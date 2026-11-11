import {
  armPause, cancelLoad, clearContexts, consumeBeforeUnload, contextLabel, debuggerOn, dropBreakpoint, dropContext, dropWorker, forgetWorker, interceptRules, invalidate, isAttached,
  markAttached, markDebugger, markIntercepting, noteBeforeUnloadHandled, noteHit, noteWorkerLog, notify, openWorker, pausedState, recordBreakpoint, recordConsole, recordContext,
  recordNetwork, recordScript, resolveUid, scriptOf, setDialog, setPaused, setTopFrame, stopPause, traceFinish, tracePush, traceReset, traceStart, traceState,
} from "./browser";
import type { CallFrameInfo, ContextInfo, PauseState } from "./browser";
import { HostError } from "./protocol";
type KeyDef = { key: string; code: string; vk: number; char?: string };
const MODIFIERS: Record<string, KeyDef> = {
  ctrl: { key: "Control", code: "ControlLeft", vk: 17 }, control: { key: "Control", code: "ControlLeft", vk: 17 }, shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
  alt: { key: "Alt", code: "AltLeft", vk: 18 }, option: { key: "Alt", code: "AltLeft", vk: 18 }, meta: { key: "Meta", code: "MetaLeft", vk: 91 },
  cmd: { key: "Meta", code: "MetaLeft", vk: 91 }, command: { key: "Meta", code: "MetaLeft", vk: 91 }, super: { key: "Meta", code: "MetaLeft", vk: 91 },
};
const MODIFIER_MASK: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
// 修饰按键
const modifierMask = (name: string): number => MODIFIER_MASK[name] ?? 0;
const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "\r", code: "Enter", vk: 13, char: "\r" },
  return: { key: "\r", code: "Enter", vk: 13, char: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9, char: "\t" },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8, char: "\b" },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  space: { key: " ", code: "Space", vk: 32, char: " " },
};
for (let index = 1; index <= 12; index += 1) {
  NAMED_KEYS[`f${index}`] = { key: `F${index}`, code: `F${index}`, vk: 111 + index };
}
// 按键定义
function keyDef(name: string): KeyDef {
  const normalized = name.trim().toLowerCase().replace(/[ _-]+/g, "");
  const modifier = MODIFIERS[normalized];
  if (modifier) return modifier;
  const named = NAMED_KEYS[normalized];
  if (named) return named;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    return { key: name, code: /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : "Unidentified", vk: upper.charCodeAt(0), char: name };
  }
  throw new HostError("bad_request", `无法识别的按键名 ${JSON.stringify(name)}；写法如 Enter、Tab、Control+A`);
}
const inFlight = new Map<number, Set<(error: HostError) => void>>();
// 中断在途
function abortPending(tabId: number, error: HostError): void {
  for (const abort of inFlight.get(tabId) ?? []) abort(error);
  inFlight.delete(tabId);
}
// 构造中断
function pausedError(state: PauseState): HostError {
  const top = state.frames[0];
  const where = top ? `${top.functionName} (${top.url.split("/").pop() || top.url}:${top.lineNumber + 1})` : "未知位置";
  return new HostError("paused", `页面停在断点上：${where}。主线程已冻结，此时其他工具均无结果；调用栈与变量由 handle_pause 读取，放行同样使用它`, true);
}
// 发送命令
export async function cdp<T = Record<string, unknown>>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  if (!/^Debugger\.|^Runtime\.(getProperties|releaseObject)$/.test(method)) {
    const paused = pausedState(tabId);
    if (paused) throw pausedError(paused);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborts = inFlight.get(tabId) ?? new Set();
  inFlight.set(tabId, aborts);
  let rejectAbort: (error: HostError) => void = () => {};
  try {
    const result = await Promise.race([
      chrome.debugger.sendCommand({ tabId }, method, params ?? {}),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${timeoutMs}ms 内没有响应`)), timeoutMs);
      }),
      new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
        aborts.add(rejectAbort);
      }),
    ]);
    return (result ?? {}) as T;
  } catch (error) {
    if (error instanceof HostError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HostError(/没有响应/.test(message) ? "timeout" : "cdp_failed", `${method}: ${message}`, true);
  } finally {
    if (timer) clearTimeout(timer);
    aborts.delete(rejectAbort);
    if (!aborts.size) inFlight.delete(tabId);
  }
}
// 唤醒休眠标签页：Auto Tab Discard 等丢弃标签页后渲染器不存在，直接 attach 后所有 CDP 域调用都会挂起
function wakeTab(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    type Listener = Parameters<typeof chrome.tabs.onUpdated.addListener>[0];
    const listener: Listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new HostError("timeout", `休眠标签页 ${tabId} 唤醒超时`, true)), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId)
      .then(() => chrome.tabs.get(tabId))
      .then((fresh) => {
        if (fresh.status === "complete") finish();
      })
      .catch(() => finish(new HostError("cdp_failed", `唤醒休眠标签页 ${tabId} 失败`, true)));
  });
}
// 确保接管
export async function ensureAttached(tabId: number): Promise<void> {
  if (isAttached(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new HostError("page_gone", `页面 ${tabId} 已不存在，请重新 list_pages`, true);
  const url = tab.url ?? "";
  const internal = ["chrome://", "edge://", "devtools://", "view-source:", "chrome-extension://"].some((prefix) => url.startsWith(prefix)) || (url.startsWith("about:") && !/^about:blank([?#]|$)/.test(url));
  if (internal) {
    throw new HostError("attach_blocked", `无法接管 ${url || "该页面"}（内部/扩展页面，常见于标签页休眠扩展的占位页）；对 navigate_page 传 type=url 可跳转回普通页面`, true);
  }
  if (tab.discarded === true || tab.status === "unloaded") {
    await wakeTab(tabId);
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/another debugger|Being debugged/i.test(message)) {
      throw new HostError("attach_blocked", `${message}（该标签页已有一个调试客户端：通常是 DevTools 处于打开状态，或已被其他自动化工具接管）`);
    }
    if (/chrome-extension/i.test(message)) {
      throw new HostError("attach_blocked", `${message}：一个扩展无法调试另一个扩展的界面。其设置页仅可通过 manage_extensions 开关，或人工操作`);
    }
    throw new HostError("cdp_failed", message);
  }
  markAttached(tabId, true);
  for (const domain of ["Page.enable", "DOM.enable", "Runtime.enable", "Network.enable", "Log.enable", "CSS.enable"]) await cdp(tabId, domain).catch(() => undefined);
  const frameTree = await cdp<{ frameTree?: { frame?: { id?: string } } }>(tabId, "Page.getFrameTree").catch(() => null);
  setTopFrame(tabId, String(frameTree?.frameTree?.frame?.id ?? ""));
  await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
}
// 摘除会话
export async function detach(tabId: number): Promise<void> {
  if (isAttached(tabId)) {
    await cdp(tabId, "Debugger.disable").catch(() => undefined);
    await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
  }
  markAttached(tabId, false);
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}
type MouseButton = "left" | "right" | "middle";
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };
// 派发鼠标
async function mouse(
  tabId: number,
  params: { x: number; y: number; type: "mouseMoved" | "mousePressed" | "mouseReleased"; button?: MouseButton; buttons?: number; clickCount?: number; },
): Promise<void> {
  await cdp(tabId, "Input.dispatchMouseEvent", { pointerType: "mouse", ...params }, 8_000);
}
// 点击坐标
export async function clickAt(
  tabId: number,
  options: { x: number; y: number; button?: MouseButton; clickCount?: number },
): Promise<void> {
  await ensureAttached(tabId);
  const button = options.button ?? "left";
  const clickCount = Math.max(1, options.clickCount ?? 1);
  await mouse(tabId, { type: "mouseMoved", x: options.x, y: options.y, buttons: 0 });
  for (let round = 0; round < clickCount; round += 1) {
    await mouse(tabId, { type: "mousePressed", x: options.x, y: options.y, button, buttons: BUTTON_BITS[button], clickCount: round + 1 });
    await mouse(tabId, { type: "mouseReleased", x: options.x, y: options.y, button, buttons: 0, clickCount: round + 1 });
  }
}
// 悬停坐标
export async function hoverAt(tabId: number, x: number, y: number): Promise<void> {
  await ensureAttached(tabId);
  await mouse(tabId, { type: "mouseMoved", x, y, buttons: 0 });
}
// 拖拽路径
export async function dragTo(
  tabId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs = 200,
): Promise<void> {
  await ensureAttached(tabId);
  const steps = Math.min(24, Math.max(6, Math.round(durationMs / 16)));
  await mouse(tabId, { type: "mouseMoved", x: from.x, y: from.y, buttons: 0 });
  await mouse(tabId, { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    await mouse(tabId, { type: "mouseMoved", x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio, buttons: 1 });
    await settle(durationMs / steps);
  }
  await mouse(tabId, { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
}
// 派发按键
export async function pressChord(tabId: number, chord: string): Promise<string> {
  await ensureAttached(tabId);
  const parts = chord.includes("+") ? chord.split("+") : [chord];
  const finalName = parts.pop() ?? "";
  const mods = parts.map((part) => keyDef(part));
  const main = keyDef(finalName);
  const held = mods.reduce((mask, def) => mask | modifierMask(def.key), 0);
  let running = 0;
  for (const mod of mods) {
    running |= MODIFIER_MASK[mod.key] ?? 0;
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.vk, nativeVirtualKeyCode: mod.vk, modifiers: running });
  }
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: main.key,
    code: main.code,
    windowsVirtualKeyCode: main.vk,
    nativeVirtualKeyCode: main.vk,
    modifiers: held | (MODIFIER_MASK[main.key] ?? 0),
  });
  if (main.char && !(held & (modifierMask("Alt") | modifierMask("Control") | modifierMask("Meta")))) {
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "char",
      key: main.key,
      text: main.char,
      code: main.code,
      windowsVirtualKeyCode: main.vk,
      nativeVirtualKeyCode: main.vk,
      modifiers: held,
    });
  }
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: main.key, code: main.code, windowsVirtualKeyCode: main.vk, nativeVirtualKeyCode: main.vk, modifiers: held });
  for (const mod of [...mods].reverse()) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.vk, nativeVirtualKeyCode: mod.vk, modifiers: 0 });
  }
  return [...mods.map((mod) => mod.key), main.key].join("+");
}
// 插入文本
export async function insertText(tabId: number, text: string): Promise<void> {
  await ensureAttached(tabId);
  await cdp(tabId, "Input.insertText", { text });
}
// 滚动可见
export async function scrollIntoView(tabId: number, backendNodeId: number): Promise<void> {
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
}
// 元素中心
export async function boxCenter(tabId: number, backendNodeId: number, index: number): Promise<{ x: number; y: number }> {
  await scrollIntoView(tabId, backendNodeId);
  const response = await cdp<{ model?: { content?: number[] } }>(tabId, "DOM.getBoxModel", { backendNodeId });
  const quad = response.model?.content ?? [];
  if (quad.length < 8) {
    throw new HostError("uid_not_found", `元素 [${index}] 无布局盒，可能为隐藏或未渲染元素`, true);
  }
  const average = (start: number): number => {
    const corners = [quad[start], quad[start + 2], quad[start + 4], quad[start + 6]].map((value) => value ?? 0);
    return corners.reduce((sum, value) => sum + value, 0) / corners.length;
  };
  return { x: average(0), y: average(1) };
}
// 元素矩形
export async function boxRect(
  tabId: number,
  backendNodeId: number,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const response = await cdp<{ model?: { content?: number[] } }>(tabId, "DOM.getBoxModel", { backendNodeId });
  const quad = response.model?.content ?? [];
  if (quad.length < 8) return null;
  const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
// 聚焦探测
export async function focusField(tabId: number, backendNodeId: number): Promise<{ tag: string; editable: boolean }> {
  await scrollIntoView(tabId, backendNodeId);
  await cdp(tabId, "DOM.focus", { backendNodeId });
  const probe = await evaluateJson<{ tag?: string; editable?: boolean }>(
    tabId,
    `() => { const el = document.activeElement; return { tag: el && el.tagName ? el.tagName.toLowerCase() : 'none', editable: !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName))) }; }`,
  );
  return { tag: probe.value?.tag ?? "none", editable: probe.value?.editable === true };
}
// 传入文件
export async function attachFiles(tabId: number, backendNodeId: number, files: string[]): Promise<void> {
  await cdp(tabId, "DOM.setFileInputFiles", { backendNodeId, files });
}
// 应答弹窗
export async function handleDialog(tabId: number, accept: boolean, promptText: string | null): Promise<void> {
  await cdp(tabId, "Page.handleJavaScriptDialog", { accept, ...(promptText !== null ? { promptText } : {}) });
}
type EvaluateResult = {
  result?: { type?: string; value?: unknown; unserializableValue?: string; objectId?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};
// 归一返回
function normalize<T = unknown>(response: EvaluateResult): { value: T; threw: string | null; unserializable: string | null } {
  const details = response.exceptionDetails;
  if (details) {
    return { value: undefined as T, threw: details.exception?.description ?? details.text ?? "页面抛出异常", unserializable: null };
  }
  return {
    value: (response.result?.value ?? undefined) as T, threw: null, unserializable: response.result?.unserializableValue ?? (response.result?.type === "undefined" ? "undefined" : null),
  };
}
// 默认求值
export async function evaluateMain<T = unknown>(
  tabId: number,
  functionSource: string,
  options: { awaitPromise?: boolean; context?: ContextInfo } = {},
): Promise<{ value: T; threw: string | null; unserializable: string | null }> {
  await ensureAttached(tabId);
  const response = await cdp<EvaluateResult>(tabId, "Runtime.evaluate", {
    expression: `(${functionSource})()`,
    returnByValue: true,
    awaitPromise: options.awaitPromise !== false,
    ...(options.context ? { contextId: options.context.contextId } : {}),
  });
  return normalize<T>(response);
}
// 求值取回
async function evaluateJson<T>(tabId: number, functionSource: string): Promise<{ value: T | null }> {
  const result = await evaluateMain<T>(tabId, functionSource);
  return { value: result.threw ? null : (result.value ?? null) };
}
// 换取对象
async function toObjectId(tabId: number, backendNodeId: number, label: string): Promise<string> {
  const resolved = await cdp<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new HostError("uid_not_found", `元素 ${label} 已脱离文档，请重新 take_snapshot`, true);
  return objectId;
}
// 批量换号
export async function objectIds(tabId: number, uids: { snapshotSeq: number; index: number }[]): Promise<string[]> {
  const objectIds: string[] = [];
  for (const uid of uids) {
    const label = `${uid.snapshotSeq}_${uid.index}`;
    objectIds.push(await toObjectId(tabId, resolveUid(tabId, label).backendNodeId, label));
  }
  return objectIds;
}
// 释放对象
export async function releaseObjects(tabId: number, objectIds: string[]): Promise<void> {
  for (const objectId of objectIds) {
    await cdp(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}
// 元素存在
export async function elementPresent(tabId: number, backendNodeId: number, state: string): Promise<boolean> {
  const objectId = await toObjectId(tabId, backendNodeId, String(backendNodeId)).catch(() => null);
  if (!objectId) return false;
  try {
    const response = await cdp<EvaluateResult>(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(){ const el = this; ${
        state === "attached" || state === "detached"
          ? "return Boolean(el);"
          : "if (!el) return false; const cs = getComputedStyle(el); return el.getClientRects().length > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;"
      } }`,
      returnByValue: true,
    });
    return normalize<boolean>(response).value === true;
  } catch {
    return false;
  } finally {
    await releaseObjects(tabId, [objectId]);
  }
}
// 带参求值
export async function evaluateWithArgs(tabId: number, functionSource: string, objectIds: string[]) {
  await ensureAttached(tabId);
  const [receiver, ...rest] = objectIds;
  const forwarded = rest.map((_, position) => `arguments[${position}]`).join(", ");
  try {
    const response = await cdp<EvaluateResult>(tabId, "Runtime.callFunctionOn", {
      objectId: receiver,
      functionDeclaration: `function(){ return (${functionSource}).apply(null, [this${forwarded ? `, ${ forwarded }` : ""}]); }`,
      arguments: rest.map((objectId) => ({ objectId })),
      returnByValue: true,
      awaitPromise: true,
    });
    return normalize(response);
  } finally {
    await releaseObjects(tabId, objectIds);
  }
}
// 选择下拉
export async function selectOption(tabId: number, backendNodeId: number, value: string, label: string): Promise<void> {
  const objectId = await toObjectId(tabId, backendNodeId, label);
  try {
    const response = await cdp<EvaluateResult>(tabId, "Runtime.callFunctionOn", {
      objectId,
      arguments: [{ value }],
      functionDeclaration: "function(value){ this.value = value; this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); return this.value; }",
      returnByValue: true,
    });
    if (normalize(response).threw) throw new HostError("cdp_failed", `设置下拉框 ${label} 的值时页面抛出异常`);
  } finally {
    await releaseObjects(tabId, [objectId]);
  }
}
const KEY_STYLES = [
  "display", "position", "top", "right", "bottom", "left", "z-index", "width", "height", "min-width", "min-height", "max-width", "max-height", "margin", "padding", "border",
  "visibility", "opacity", "overflow", "pointer-events", "cursor", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "text-align", "white-space",
  "transform",
];
// 取文档根
export async function rootNodeId(tabId: number): Promise<number> {
  const response = await cdp<{ root?: { nodeId?: number } }>(tabId, "DOM.getDocument", { depth: 1 });
  const nodeId = response.root?.nodeId;
  if (nodeId === undefined) throw new HostError("cdp_failed", "DOM.getDocument 未返回文档根节点", true);
  return nodeId;
}
// 查询节点
export async function queryAll(
  tabId: number,
  selector: string,
  limit: number,
): Promise<{ backendNodeIds: number[]; total: number }> {
  await ensureAttached(tabId);
  const root = await rootNodeId(tabId);
  let nodeIds: number[];
  try {
    nodeIds = (await cdp<{ nodeIds?: number[] }>(tabId, "DOM.querySelectorAll", { nodeId: root, selector })).nodeIds ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HostError("bad_request", `选择器 ${JSON.stringify(selector)} 不合法：${message.split(/\r?\n/)[0]}`);
  }
  const described = await Promise.all(
    nodeIds.slice(0, limit).map(async (nodeId) => {
      const node = await cdp<{ node?: { backendNodeId?: number } }>(tabId, "DOM.describeNode", { nodeId });
      return node.node?.backendNodeId;
    }),
  );
  return { backendNodeIds: described.filter((item): item is number => typeof item === "number"), total: nodeIds.length };
}
// 检查元素
export async function inspectElement(
  tabId: number,
  backendNodeId: number,
  options: { outerLimit: number; allStyles: boolean },
): Promise<Record<string, unknown>> {
  await ensureAttached(tabId);
  const resolved = await cdp<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new HostError("not_found", `后端节点 ${backendNodeId} 已无法取得对象，请重新 take_snapshot`, true);
  const probed = await cdp<EvaluateResult>(tabId, "Runtime.callFunctionOn", {
    objectId,
    returnByValue: true,
    functionDeclaration:
      `function(){ const el = this; const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean) : [],
        attrs: Array.prototype.map.call(el.attributes || [], function(a){ return { name: a.name, value: String(a.value).slice(0, 240) }; }),
        text: String(el.innerText != null ? el.innerText : (el.textContent || '')).trim().slice(0, 400),
        childElements: el.children ? el.children.length : 0,
        value: ('value' in el) ? String(el.value).slice(0, 240) : undefined,
        checked: ('checked' in el) ? Boolean(el.checked) : undefined,
        disabled: ('disabled' in el) ? Boolean(el.disabled) : undefined,
        editable: Boolean(el.isContentEditable) || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|file|submit|image|reset)$/.test(String(el.type))) || el.tagName === 'TEXTAREA',
        ariaRole: el.getAttribute('role') || null,
        label: el.getAttribute('aria-label') || (el.labels && el.labels.length ? el.labels[0].textContent : null) || null,
        inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
        rendered: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
        overlapped: (() => { const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const hit = document.elementFromPoint(cx, cy); return !!(hit && hit !== el && !el.contains(hit) && !hit.contains(el)); })(),
        path: (() => { const parts = []; let node = el; while (node && node.nodeType === 1 && parts.length < 12) {
          let step = node.tagName.toLowerCase();
          if (node.id) { parts.unshift(step + '#' + node.id); break; }
          const sameTag = node.parentNode ? Array.prototype.filter.call(node.parentNode.children, function(c){ return c.tagName === node.tagName; }) : [];
          if (sameTag.length > 1) step += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
          parts.unshift(step); node = node.parentElement; }
          return parts.join(' > '); })(),
      }; }`,
  });
  const shape = normalize<Record<string, unknown>>(probed).value ?? {};
  await rootNodeId(tabId);
  const pushed = await cdp<{ nodeIds?: number[] }>(tabId, "DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] });
  const nodeId = pushed.nodeIds?.[0] as number;
  const meta = await cdp<{ node?: { documentURL?: string; frameId?: string } }>(tabId, "DOM.describeNode", { backendNodeId, depth: 0 });
  const outer = await cdp<{ outerHTML?: string }>(tabId, "DOM.getOuterHTML", { backendNodeId });
  const listeners = await cdp<{
    listeners?: { type?: string; useCapture?: boolean; passive?: boolean; scriptId?: string; lineNumber?: number; columnNumber?: number; handler?: { description?: string } }[];
  }>(tabId, "DOMDebugger.getEventListeners", { objectId }).catch(() => ({ listeners: [] }));
  const styles = await cdp<{ computedStyle?: { name?: string; value?: string }[] }>(tabId, "CSS.getComputedStyleForNode", { nodeId });
  const computed: Record<string, string> = {};
  for (const item of styles.computedStyle ?? []) {
    if (!item.name) continue;
    if (options.allStyles || KEY_STYLES.includes(item.name)) computed[item.name] = String(item.value ?? "");
  }
  const rect = await boxRect(tabId, backendNodeId).catch(() => null);
  await cdp(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  const html = String(outer.outerHTML ?? "");
  return {
    ...shape,
    rect,
    documentUrl: meta.node?.documentURL ?? "",
    frameId: meta.node?.frameId ?? "",
    styles: computed,
    listeners: (listeners.listeners ?? []).map((item) => ({
      type: String(item.type ?? ""),
      useCapture: item.useCapture === true,
      passive: item.passive === true,
      at: item.scriptId ? `${item.scriptId}:${Number(item.lineNumber ?? 0) + 1}` : null,
      handler: String(item.handler?.description ?? "").slice(0, 200),
    })),
    outerLimit: options.outerLimit,
    outerHtml: html.length > options.outerLimit ? `${html.slice(0, options.outerLimit)}…` : html,
    htmlChars: html.length,
  };
}
// 开启调试
export async function openDebugger(tabId: number): Promise<void> {
  await ensureAttached(tabId);
  if (debuggerOn(tabId)) return;
  await cdp(tabId, "Debugger.enable");
  markDebugger(tabId, true);
}
// 读取源码
export async function scriptSource(tabId: number, scriptId: string): Promise<string> {
  const response = await cdp<{ scriptSource?: string }>(tabId, "Debugger.getScriptSource", { scriptId });
  return String(response.scriptSource ?? "");
}
// 短暂等待
export const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type BreakpointLocation = { scriptId?: string; lineNumber?: number; columnNumber?: number };
type BreakpointResponse = { breakpointId?: string; locations?: BreakpointLocation[]; actualLocation?: BreakpointLocation };
// 设置断点
export async function setBreakpoint(
  tabId: number,
  target: { scriptId?: string; url?: string; line: number; column: number; condition?: string },
): Promise<{ breakpointId: string; locations: { scriptId: string; line: number; column: number }[] }> {
  await openDebugger(tabId);
  const response: BreakpointResponse = target.scriptId
    ? await cdp<BreakpointResponse>(tabId, "Debugger.setBreakpoint", {
        location: { scriptId: target.scriptId, lineNumber: target.line, columnNumber: target.column },
        condition: target.condition,
      })
    : await cdp<BreakpointResponse>(tabId, "Debugger.setBreakpointByUrl", { url: target.url, lineNumber: target.line, columnNumber: target.column, condition: target.condition });
  const breakpointId = response.breakpointId;
  if (!breakpointId) throw new HostError("cdp_failed", "设置断点未返回 breakpointId", true);
  const raw = response.locations ?? (response.actualLocation ? [response.actualLocation] : []);
  const locations = raw.map((item) => ({ scriptId: String(item.scriptId ?? ""), line: Number(item.lineNumber ?? target.line), column: Number(item.columnNumber ?? target.column)}));
  recordBreakpoint(tabId, {
    breakpointId,
    url: target.url ?? locations[0]?.scriptId ?? "",
    scriptId: target.scriptId,
    lineNumber: target.line,
    columnNumber: target.column,
    condition: target.condition,
    enabled: true,
  });
  return { breakpointId, locations };
}
// 删除断点
export async function removeBreakpoint(tabId: number, breakpointId: string): Promise<void> {
  await cdp(tabId, "Debugger.removeBreakpoint", { breakpointId }).catch(() => undefined);
  dropBreakpoint(tabId, breakpointId);
}
// 断点开关
export async function setBreakpointsActive(tabId: number, active: boolean): Promise<void> {
  await openDebugger(tabId);
  await cdp(tabId, "Debugger.setBreakpointsActive", { active });
}
// 异常中断
export async function setPauseOnExceptions(tabId: number, state: string): Promise<void> {
  await openDebugger(tabId);
  await cdp(tabId, "Debugger.setPauseOnExceptions", { state });
}
// 放行单步
export async function runAction(tabId: number, action: "continue" | "over" | "into" | "out" | "pause"): Promise<PauseState | null> {
  await openDebugger(tabId);
  const before = pausedState(tabId);
  const method = action === "continue" ? "Debugger.resume" : action === "pause" ? "Debugger.pause" : `Debugger.step${action === "over" ? "Over" : action === "into" ? "Into" : "Out"}`;
  await cdp(tabId, method);
  await settle(150);
  const after = pausedState(tabId);
  if (action === "continue" && after && after === before) {
    stopPause(tabId);
    setPaused(tabId, null);
    return null;
  }
  return after;
}
// 读取变量
async function scopeVariables(tabId: number, frame: CallFrameInfo): Promise<Record<string, Record<string, string>>> {
  const scopes: Record<string, Record<string, string>> = {};
  for (const scope of frame.scopes) {
    if (!scope.objectId) continue;
    if (scope.type === "global" || scope.type === "module") continue;
    const response = await cdp<{ result?: Record<string, any>[] }>(tabId, "Runtime.getProperties", {
      objectId: scope.objectId,
      ownProperties: true,
      generatePreview: true,
    }).catch(() => ({ result: [] }));
    const entries: Record<string, string> = {};
    for (const item of (response.result ?? []).slice(0, 24)) {
      if (!item.name) continue;
      const value = item.value;
      entries[String(item.name)] =
        value !== undefined && value !== null && typeof value === "object"
          ? ("value" in value ? JSON.stringify(value.value) : String(value.unserializableValue ?? value.preview?.description ?? value.description ?? value.subtype ?? value.type ?? "object"))
          : value !== undefined
            ? JSON.stringify(value)
            : String(item.type ?? "undefined");
    }
    scopes[`${scope.type}${scope.name ? `:${ scope.name }` : ""}`] = entries;
  }
  return scopes;
}
// 中断现场
export async function pauseInfo(tabId: number, frameIndex: number): Promise<Record<string, unknown> | null> {
  const state = pausedState(tabId);
  if (!state) return null;
  const frame = state.frames[Math.max(0, Math.min(state.frames.length - 1, frameIndex))];
  return {
    reason: state.reason,
    hitBreakpoints: state.hitBreakpoints,
    heldForMs: Date.now() - state.at,
    frameIds: state.frames.map((item) => item.callFrameId),
    frames: state.frames.map((item) => ({
      index: item.index,
      function: item.functionName,
      url: item.url,
      line: item.lineNumber + 1,
      column: item.columnNumber,
      scopes: item.scopes.map((scope) => `${scope.type}${scope.name ? `(${ scope.name })` : ""} ${scope.className ?? ""}${scope.preview ? ` = ${ scope.preview }` : ""}`.trim()),
    })),
    variables: frame ? await scopeVariables(tabId, frame) : {},
  };
}
// 帧内求值
export async function evaluateFrame(tabId: number, callFrameId: string, functionSource: string): Promise<{ value: unknown; threw: string | null; unserializable: string | null }> {
  const response = await cdp<EvaluateResult>(tabId, "Debugger.evaluateOnCallFrame", { callFrameId, expression: `(${functionSource})()`, returnByValue: true });
  return normalize(response);
}
const INTERCEPT_ALL = "*";
// 编码转换
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
// 应答请求
async function fetchReply(tabId: number, method: string, params: Record<string, unknown>): Promise<void> {
  await chrome.debugger.sendCommand({ tabId }, method, params).catch(() => undefined);
}
// 处理暂停
export async function answerPaused(tabId: number, event: Record<string, any>): Promise<void> {
  const requestId = String(event.requestId ?? "");
  const url = String(event.request?.url ?? "");
  const rule = interceptRules(tabId).find((item) => item.match === INTERCEPT_ALL || url.includes(item.match)) ?? null;
  const action = rule?.action ?? "continue";
  if (!rule || action === "continue") await fetchReply(tabId, "Fetch.continueRequest", { requestId });
  else if (action === "abort") await fetchReply(tabId, "Fetch.failRequest", { requestId, errorReason: "Failed" });
  else if (action === "block") {
    await fetchReply(tabId, "Fetch.fulfillRequest", {
      requestId,
      responseCode: 403,
      responseHeaders: [{ name: "content-type", value: "text/plain; charset=utf-8" }],
      body: base64("blocked by BrowserUse"),
    });
  } else if (action === "redirect") await fetchReply(tabId, "Fetch.redirectRequest", { requestId, url: rule.redirectTo ?? url });
  else {
    const headers = Object.entries(rule.headers ?? { "content-type": rule.contentType ?? "application/json" }).map(([name, value]) => ({ name, value: String(value)}));
    await fetchReply(tabId, "Fetch.fulfillRequest", { requestId, responseCode: rule.status ?? 200, responseHeaders: headers, body: base64(rule.body ?? "")});
  }
  noteHit(tabId, { url, method: String(event.request?.method ?? ""), type: String(event.resourceType ?? ""), action, at: Date.now() });
}
// 同步规则
export async function syncIntercept(tabId: number): Promise<void> {
  const rules = interceptRules(tabId);
  if (!rules.length) {
    await cdp(tabId, "Fetch.disable");
    markIntercepting(tabId, false);
    return;
  }
  await ensureAttached(tabId);
  await cdp(tabId, "Fetch.enable", {
    patterns: rules.map((rule) => ({ urlPattern: rule.match === INTERCEPT_ALL ? INTERCEPT_ALL : `*${rule.match}*`, requestStage: "Request" })),
    handleAuthRequests: false,
  });
  markIntercepting(tabId, true);
}
// 关闭拦截
export async function stopIntercept(tabId: number): Promise<void> {
  await cdp(tabId, "Fetch.disable").catch(() => undefined);
  markIntercepting(tabId, false);
}
// 监听断点
export async function setListener(tabId: number, eventName: string, on: boolean): Promise<void> {
  await openDebugger(tabId);
  await cdp(tabId, on ? "DOMDebugger.setEventListenerBreakpoint" : "DOMDebugger.removeEventListenerBreakpoint", { eventName, targetName: "" });
}
// 发往目标
export async function cdpTarget<T = Record<string, unknown>>(
  targetId: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  try {
    const result = await Promise.race([
      chrome.debugger.sendCommand({ targetId }, method, params ?? {}),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${timeoutMs}ms 内没有响应`)), timeoutMs)),
    ]);
    return (result ?? {}) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HostError(/没有响应/.test(message) ? "timeout" : "cdp_failed", `${method}: ${message}`, true);
  }
}
// 列出目标
export async function listTargets(): Promise<{ targetId: string; url: string; type: string; title: string }[]> {
  const all = await chrome.debugger.getTargets();
  return all.map((item) => ({ targetId: item.id, url: item.url ?? "", type: item.type ?? "", title: item.title ?? "" }));
}
// 挂接后台
export async function attachWorker(targetId: string): Promise<void> {
  await chrome.debugger.detach({ targetId }).catch(() => undefined);
  await chrome.debugger.attach({ targetId }, "1.3");
  await cdpTarget(targetId, "Runtime.enable");
  const info = (await listTargets()).find((item) => item.targetId === targetId);
  openWorker(targetId, info?.url ?? "", info?.type ?? "");
}
// 摘除后台
export async function detachWorker(targetId: string): Promise<void> {
  await chrome.debugger.detach({ targetId }).catch(() => undefined);
  dropWorker(targetId);
}
// 后台求值
export async function evaluateWorker(targetId: string, functionSource: string) {
  const response = await cdpTarget<EvaluateResult>(targetId, "Runtime.evaluate", { expression: `(${functionSource})()`, returnByValue: true, awaitPromise: true });
  return normalize(response);
}
const TRACE_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing", "cc", "v8"];
// 汇总摘要
function summarizeTrace(events: Record<string, any>[]): Record<string, unknown> {
  const byName = new Map<string, { name: string; count: number; ms: number; detail: string }>();
  let first = 0;
  let last = 0;
  let frames = 0;
  for (const item of events) {
    const ts = Number(item.ts ?? 0);
    if (ts) {
      if (!first || ts < first) first = ts;
      if (ts > last) last = ts;
    }
    if (item.name === "DrawFrame" || item.name === "Commit") frames += 1;
    const dur = Number(item.dur ?? 0);
    if (item.ph !== "X" || !dur) continue;
    const data = (item.args?.data ?? {}) as Record<string, any>;
    const detail = [data.type, data.url ? String(data.url).split("/").pop() : "", data.fileName].filter(Boolean).join(" ");
    const row = byName.get(String(item.name)) ?? { name: String(item.name), count: 0, ms: 0, detail };
    row.count += 1;
    row.ms += dur / 1000;
    if (!row.detail && detail) row.detail = detail;
    byName.set(String(item.name), row);
  }
  const rows = [...byName.values()].sort((left, right) => right.ms - left.ms);
  return {
    events: events.length, spanMs: Math.round((last - first) / 1000), frames,
    hotspots: rows.slice(0, 10).map((row) => ({ name: row.name, count: row.count, ms: Math.round(row.ms), detail: row.detail })),
  };
}
// 开始录制
export async function startTrace(tabId: number, categories: string[], ttlMs: number): Promise<void> {
  await ensureAttached(tabId);
  traceStart(tabId, ttlMs);
  await cdp(tabId, "Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: categories.length ? categories : TRACE_CATEGORIES } });
  setTimeout(() => {
    if (!traceState(tabId).on) return;
    void stopTrace(tabId).then((summary) => notify("trace_expired", { pageId: tabId, events: summary.events }));
  }, ttlMs);
}
// 停止录制
export async function stopTrace(tabId: number): Promise<Record<string, unknown>> {
  await cdp(tabId, "Tracing.end").catch(() => undefined);
  const deadline = Date.now() + 5_000;
  while (!traceState(tabId).complete && Date.now() < deadline) await settle(100);
  const summary = summarizeTrace(traceState(tabId).events);
  traceReset(tabId);
  return summary;
}
// 截取画面
export async function captureScreenshot(
  tabId: number,
  options: { format: string; quality: number | null; fullPage: boolean; clip?: { x: number; y: number; width: number; height: number } | null; fromSurface?: boolean; timeoutMs?: number },
): Promise<string> {
  await ensureAttached(tabId);
  const params: Record<string, unknown> = { format: options.format };
  if (options.format !== "png" && options.quality !== null) params.quality = options.quality;
  if (options.clip) params.clip = { ...options.clip, scale: 1 };
  else if (options.fullPage) params.captureBeyondViewport = true;
  if (options.fromSurface !== undefined) params.fromSurface = options.fromSurface;
  const response = await cdp<{ data?: string }>(tabId, "Page.captureScreenshot", params, options.timeoutMs ?? 20_000);
  if (!response.data) throw new HostError("cdp_failed", "Page.captureScreenshot 未返回数据", true);
  return response.data;
}
// 版面尺寸
export async function layoutInfo(tabId: number): Promise<{
  width: number;
  height: number;
  dpr: number;
  screenshotWidth: number;
  screenshotHeight: number;
  pxScale: number;
  scrollX: number;
  scrollY: number;
  documentWidth: number;
  documentHeight: number;
}> {
  const probe = await evaluateJson<{
    innerWidth?: number;
    innerHeight?: number;
    clientWidth?: number;
    clientHeight?: number;
    dpr?: number;
    scrollX?: number;
    scrollY?: number;
    documentWidth?: number;
    documentHeight?: number;
  }>(
    tabId,
    `() => { const root = document.documentElement; return {
      innerWidth: window.innerWidth || 0,
      innerHeight: window.innerHeight || 0,
      clientWidth: root ? root.clientWidth || 0 : 0,
      clientHeight: root ? root.clientHeight || 0 : 0,
      dpr: window.devicePixelRatio || 1,
      scrollX: Math.round(window.scrollX || 0),
      scrollY: Math.round(window.scrollY || 0),
      documentWidth: root ? root.scrollWidth || 0 : 0,
      documentHeight: root ? root.scrollHeight || 0 : 0
    }; }`,
  );
  const value = probe.value ?? {};
  const width = value.innerWidth || value.clientWidth || 0;
  const height = value.innerHeight || value.clientHeight || 0;
  const dpr = value.dpr || 1;
  return {
    width, height, dpr, screenshotWidth: Math.round(width * dpr), screenshotHeight: Math.round(height * dpr), pxScale: dpr, scrollX: value.scrollX ?? 0, scrollY: value.scrollY ?? 0,
    documentWidth: value.documentWidth ?? 0, documentHeight: value.documentHeight ?? 0,
  };
}
// 监听调试
export function watchDebugger(): void {
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    abortPending(tabId, new HostError("cdp_failed", `调试会话已摘除（${reason}），该命令未完成`, true));
    markAttached(tabId, false);
    invalidate(tabId, `detach:${reason}`);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined && source.targetId) forgetWorker(source.targetId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    abortPending(tabId, new HostError("page_gone", "标签页已关闭，请重新 list_pages", true));
  });
  chrome.debugger.onEvent.addListener((source, method, payload) => {
  const tabId = source.tabId;
  if (tabId === undefined) {
    const targetId = source.targetId;
    if (!targetId) return;
    const event = (payload ?? {}) as Record<string, any>;
    if (method === "Runtime.consoleAPICalled") {
      noteWorkerLog(targetId, {
        type: String(event.type ?? "log"),
        text: (event.args ?? []).map((arg: Record<string, any>) => ("value" in arg ? String(arg.value) : `[${String(arg?.type ?? "object")}]`)).join(" "),
        timestamp: Date.now(),
        level: String(event.type ?? "log"),
      });
    } else if (method === "Runtime.exceptionThrown") {
      const details = event.exceptionDetails ?? {};
      noteWorkerLog(targetId, {
        type: "error",
        text: String(details.exception?.description ?? details.text ?? "worker 抛出未捕获异常").split(/\r?\n/)[0].slice(0, 400),
        timestamp: Date.now(),
        source: details.url ? String(details.url) : undefined,
        level: "error",
      });
    }
    return;
  }
  const event = (payload ?? {}) as Record<string, any>;
  switch (method) {
    case "Page.frameNavigated":
      if (!event.frame?.parentId) {
        setTopFrame(tabId, String(event.frame?.frameId ?? ""));
        invalidate(tabId, "navigated:document");
      }
      break;
    case "Page.navigatedWithinDocument":
      invalidate(tabId, "navigated:same_document");
      break;
    case "Page.javascriptDialogOpening": {
      const type = String(event.type ?? "alert");
      if (type === "beforeunload") {
        const armed = consumeBeforeUnload(tabId);
        if (!armed) {
          setDialog(tabId, { type, message: String(event.message ?? "页面请求确认是否离开") });
          break;
        }
        noteBeforeUnloadHandled(tabId, armed);
        void handleDialog(tabId, armed === "accept", null)
          .then(() => {
            if (armed === "dismiss") cancelLoad(tabId);
          })
          .catch(() => undefined);
        break;
      }
      setDialog(tabId, { type, message: String(event.message ?? ""), promptText: event.prompt ? String(event.prompt) : undefined });
      break;
    }
    case "Page.javascriptDialogClosed":
      setDialog(tabId, null);
      break;
    case "Runtime.executionContextCreated": {
      const context = event.context ?? {};
      recordContext(tabId, {
        contextId: Number(context.id),
        name: String(context.name ?? ""),
        origin: String(context.origin ?? ""),
        isDefault: context.auxData?.isDefault === true,
        type: String(context.auxData?.type ?? (context.auxData?.isDefault === true ? "default" : "isolated")),
        frameId: String(context.auxData?.frameId ?? ""),
      });
      break;
    }
    case "Runtime.executionContextDestroyed":
      dropContext(tabId, Number(event.executionContextId));
      break;
    case "Runtime.executionContextsCleared":
      clearContexts(tabId);
      break;
    case "Tracing.dataCollected":
      if (traceState(tabId).on) tracePush(tabId, (event.value ?? []) as Record<string, any>[]);
      break;
    case "Tracing.tracingComplete":
      traceFinish(tabId);
      break;
    case "Fetch.requestPaused":
      void answerPaused(tabId, event);
      break;
    case "Debugger.scriptParsed":
      recordScript(tabId, {
        scriptId: String(event.scriptId ?? ""),
        url: String(event.url ?? ""),
        frameId: String(event.frameId ?? ""),
        lines: Number(event.endLine ?? 0) - Number(event.startLine ?? 0) + 1,
      });
      break;
    case "Debugger.paused": {
      const frames: CallFrameInfo[] = (event.callFrames ?? []).map((frame: Record<string, any>, index: number) => ({
        index,
        callFrameId: String(frame.callFrameId ?? ""),
        functionName: String(frame.functionName || "(匿名)"),
        url: String(frame.url || "") || scriptOf(tabId, String(frame.location?.scriptId ?? ""))?.url || String(frame.location?.scriptId ?? ""),
        lineNumber: Number(frame.location?.lineNumber ?? frame.lineNumber ?? 0),
        columnNumber: Number(frame.location?.columnNumber ?? frame.columnNumber ?? 0),
        scopes: (frame.scopeChain ?? []).map((scope: Record<string, any>) => ({
          type: String(scope.type ?? ""),
          name: scope.name ? String(scope.name) : undefined,
          objectId: scope.object?.objectId ? String(scope.object.objectId) : undefined,
          className: scope.object?.className ?? scope.object?.subtype ?? scope.object?.type,
          preview: scope.object?.description ? String(scope.object.description).slice(0, 120) : undefined,
        })),
      }));
      const state: PauseState = { reason: String(event.reason ?? "other"), hitBreakpoints: (event.hitBreakpoints ?? []).map(String), frames, at: Date.now()};
      setPaused(tabId, state);
      abortPending(tabId, pausedError(state));
      armPause(tabId, () => {
        void runAction(tabId, "continue").then(() => notify("paused_timeout", { pageId: tabId }));
      });
      notify("paused", { pageId: tabId, reason: state.reason, at: frames[0] ? `${frames[0].functionName}:${frames[0].lineNumber + 1}` : null });
      break;
    }
    case "Debugger.resumed":
      stopPause(tabId);
      setPaused(tabId, null);
      notify("resumed", { pageId: tabId });
      break;
    case "Network.requestWillBeSent":
      recordNetwork(tabId, String(event.requestId), {
        url: String(event.request?.url ?? ""),
        method: String(event.request?.method ?? ""),
        resourceType: String(event.type ?? "Other").toLowerCase(),
        startedAt: Date.now(),
      });
      break;
    case "Network.responseReceived":
      recordNetwork(tabId, String(event.requestId), {
        status: Number(event.response?.status),
        statusText: String(event.response?.statusText ?? ""),
        mimeType: String(event.response?.mimeType ?? ""),
      });
      break;
    case "Network.loadingFinished":
      recordNetwork(tabId, String(event.requestId), { finishedAt: Date.now(), encodedDataLength: Number(event.encodedDataLength ?? 0)});
      break;
    case "Network.loadingFailed":
      recordNetwork(tabId, String(event.requestId), { finishedAt: Date.now(), failed: String(event.errorText ?? event.type ?? "failed")});
      break;
    case "Runtime.consoleAPICalled": {
      const text = (event.args ?? [])
        .map((arg: Record<string, unknown>) =>
          arg && "value" in arg ? String(arg.value) : arg && arg.type === "string" ? String(arg.value ?? "") : `[${String(arg?.type ?? "object")}]`,
        )
        .join(" ");
      const top = event.stackTrace?.callFrames?.[0];
      recordConsole(tabId, {
        type: String(event.type ?? "log"),
        text,
        timestamp: Date.now(),
        source: top?.url ? String(top.url) : undefined,
        line: top ? Number(top.lineNumber ?? 0) + 1 : undefined,
        world: contextLabel(tabId, Number(event.contextId ?? 0)),
        stack: event.stackTrace?.callFrames?.length ? JSON.stringify(event.stackTrace.callFrames.slice(0, 8)) : undefined,
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const details = event.exceptionDetails ?? {};
      const description = String(details.exception?.description ?? details.text ?? "页面抛出未捕获异常");
      recordConsole(tabId, {
        type: "error",
        text: description.split(/\r?\n/)[0].slice(0, 400),
        timestamp: Date.now(),
        source: details.url ? String(details.url) : undefined,
        line: details.lineNumber !== undefined ? Number(details.lineNumber) + 1 : undefined,
        world: contextLabel(tabId, Number(details.executionContextId ?? 0)),
        stack: details.stack?.callFrames?.length ? JSON.stringify(details.stack.callFrames.slice(0, 8)) : undefined,
      });
      break;
    }
    case "Log.entryAdded": {
      const entry = event.entry ?? {};
      recordConsole(tabId, {
        type: String(entry.source ?? "log"),
        text: String(entry.text ?? ""),
        timestamp: Date.now(),
        source: String(entry.url ?? ""),
        line: Number(entry.lineNumber ?? 0),
        level: String(entry.level ?? "info"),
      });
      break;
    }
    default:
      break;
  }
  });
}
