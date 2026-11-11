import {
  armBeforeUnload, armExpiry, attachedTabs, beforeUnloadOutcome, breakpointsOf, browserLabel, connectionState, consoleEntries, contextsOf, currentEpoch, INTERCEPT_TTL_MS, interceptRules,
  interceptState, invalidate, isAttached, listenerNames, listPages, networkEntries, nextSeq, notify, pausedState, pendingDialog, resolveContext, resolveUid, saveTree, scriptOf,
  scriptsOf, select, setListenerNames, setRules, traceState, waitCancel, workerSessions,
} from "./browser";
import type { ElementRecord, InterceptRule } from "./browser";
import {
  attachFiles, attachWorker, boxCenter, boxRect, captureScreenshot, cdp, clickAt, detach, detachWorker, dragTo, elementPresent, ensureAttached, evaluateFrame, evaluateMain,
  evaluateWithArgs, evaluateWorker, focusField, handleDialog, hoverAt, insertText, inspectElement, layoutInfo, listTargets, objectIds, openDebugger, pauseInfo, pressChord, queryAll,
  removeBreakpoint, runAction, scriptSource, selectOption, setBreakpoint, setBreakpointsActive, setListener, setPauseOnExceptions, settle, startTrace, stopIntercept, stopTrace,
  syncIntercept,
} from "./cdp";
import { bool, choice, DEFAULT_PORT, HostError, num, parseUid, PROTOCOL_VERSION, str } from "./protocol";
import type { Method, Params, StatusResult } from "./protocol";
type AxValue = { type?: string; value?: unknown };
type AxNode = {
  nodeId: string;
  childIds?: string[];
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: Array<{ name: string; value: AxValue }>;
  backendDOMNodeId?: number;
};
// 读取取值
function textOf(value: AxValue | undefined, fallback = ""): string {
  if (!value) return fallback;
  const raw = typeof value === "object" && "value" in value ? value.value : (value as unknown);
  if (raw === undefined || raw === null) return fallback;
  return String(raw);
}
// 压平空白
const clean = (value: string, limit: number): string => value.replace(/"/g, "'").replace(/\s+/g, " ").trim().slice(0, limit);
// 图片尺寸
function pngSize(base64: string): { width: number; height: number } | null {
  try {
    const binary = atob(base64.slice(0, 64));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.length < 24 || bytes[0] !== 0x89) return null;
    const view = new DataView(bytes.buffer);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  } catch {
    return null;
  }
}
// 读取标记
function flagOf(node: AxNode, name: string): string {
  const value = node.properties?.find((item) => item.name === name)?.value;
  if (!value) return "";
  const raw = textOf(value);
  if (raw === "" || raw === "false" || raw === "undefined") return "";
  return raw === "true" ? ` ${name}` : ` ${name}=${raw}`;
}
type Budget = { maxNodes: number; maxDepth: number; maxChars: number; includeIgnored: boolean };
// 构建树形
function buildTree(nodes: AxNode[], seq: number, budget: Budget): {
  tree: string;
  records: ElementRecord[];
  nodeCount: number;
  interactiveCount: number;
  truncated: boolean;
} {
  const byId = new Map<string, AxNode>();
  const hasParent = new Set<string>();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
    for (const childId of node.childIds ?? []) hasParent.add(childId);
  }
  const lines: string[] = [];
  const records: ElementRecord[] = [];
  let index = 0;
  let chars = 0;
  let interactiveCount = 0;
  let truncated = false;
  const walk = (node: AxNode, depth: number): void => {
    if (truncated) return;
    const ignored = node.ignored === true;
    let kept = false;
    if (!ignored || budget.includeIgnored) {
      if (depth > budget.maxDepth || index >= budget.maxNodes || chars >= budget.maxChars) {
        truncated = true;
        return;
      }
      const role = textOf(node.role, "none");
      const name = clean(textOf(node.name), 110);
      const value = clean(textOf(node.value), 60);
      const flags = [
        flagOf(node, "focusable"), flagOf(node, "focused"), flagOf(node, "editable"), flagOf(node, "checked"), flagOf(node, "selected"), flagOf(node, "expanded"),
        flagOf(node, "pressed"), flagOf(node, "disabled"), flagOf(node, "required"), flagOf(node, "level"), value ? ` value="${value}"` : "",
      ] .join("");
      const uid = `${seq}_${index}`;
      const line = `${"  ".repeat(depth)}[${uid}] ${role}${name ? ` "${name}"` : ""}${flags}`;
      lines.push(line);
      chars += line.length + 1;
      if (node.backendDOMNodeId !== undefined && !ignored) {
        records.push({ uid, index, backendNodeId: node.backendDOMNodeId as number, role, name, line });
        interactiveCount += 1;
      }
      index += 1;
      kept = true;
    }
    const childDepth = ignored || !kept ? depth : depth + 1;
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, childDepth);
    }
  };
  for (const node of nodes) {
    if (hasParent.has(node.nodeId)) continue;
    walk(node, 0);
    if (truncated) break;
  }
  const total = nodes.filter((node) => node.ignored !== true).length;
  if (truncated || total > index) {
    lines.push(`[已截断：共 ${total} 个可渲染节点，本次输出 ${index} 个；可增大 maxNodes 或加 verbose 获取更多]`);
  }
  return { tree: lines.join("\n"), records, nodeCount: index, interactiveCount, truncated };
}
// 生成快照
async function snapshotOf(tabId: number, params: Params) {
  await ensureAttached(tabId);
  const seq = nextSeq(tabId);
  const budget: Budget = {
    maxNodes: num(params, "maxNodes", bool(params, "verbose", false) ? 1_200 : 400) as number, maxDepth: num(params, "maxDepth", 30) as number,
    maxChars: num(params, "maxChars", bool(params, "verbose", false) ? 120_000 : 30_000) as number, includeIgnored: bool(params, "verbose", false),
  };
  const ax = await cdp<{ nodes?: AxNode[] }>(tabId, "Accessibility.getFullAXTree", {});
  const built = buildTree(ax.nodes ?? [], seq, budget);
  saveTree(tabId, seq, built.records);
  const tab = await chrome.tabs.get(tabId);
  const layout = await layoutInfo(tabId);
  const probe = await evaluateMain<{ focus: string; readyState: string }>(
    tabId,
    `() => { const el = document.activeElement; const label = el && el.getAttribute ? el.getAttribute('aria-label') : null;
      return { focus: el && el.tagName ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (label ? '[aria-label=' + label + ']' : '') : '',
               readyState: document.readyState }; }`,
  );
  return {
    pageId: tabId, url: tab.url ?? "", title: tab.title ?? "", snapshotSeq: seq, tree: built.tree, nodes: built.nodeCount, interactive: built.interactiveCount,
    truncated: built.truncated, focus: probe.value?.focus || null, readyState: probe.value?.readyState ?? "unknown", layout,
  };
}
// 定位页面
async function requireTab(params: Params): Promise<number> {
  const explicit = num(params, "pageId", null);
  if (explicit !== null) {
    const tab = await chrome.tabs.get(Math.trunc(explicit)).catch(() => null);
    if (!tab) throw new HostError("page_gone", `页面 ${explicit} 已不存在，请重新 list_pages`, true);
    select(tab.id as number);
    return tab.id as number;
  }
  const pages = await listPages();
  const selected = pages.find((page) => page.selected);
  if (!selected) throw new HostError("no_page", "尚未选中页面：先 list_pages，再由 select_page 选定", true);
  return selected.pageId;
}
// 附带快照
async function withTree(tabId: number, params: Params) {
  return bool(params, "includeSnapshot", false) ? snapshotOf(tabId, params) : null;
}
// 编号转点
async function uidCenter(tabId: number, uid: string): Promise<{ x: number; y: number }> {
  const record = resolveUid(tabId, uid);
  return boxCenter(tabId, record.backendNodeId, record.index);
}
// 等待加载
function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
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
    const listener: Listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete" || tab.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new HostError("timeout", `页面 ${tabId} 在 ${timeoutMs}ms 内未完成加载`, true)), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    });
  });
}
// 取出分页
function paging<T>(entries: T[], params: Params): { page: T[]; total: number } {
  const pageSize = Math.min(500, Math.max(1, num(params, "pageSize", 50) as number));
  const pageIdx = Math.max(0, num(params, "pageIdx", 0) as number);
  const start = pageIdx * pageSize;
  return { page: entries.slice(start, start + pageSize), total: entries.length };
}
type Handler = (params: Params) => Promise<unknown>;
// 调试环形缓冲：写入 chrome.storage.session（SW 被冻结/重启后仍可读），由 status 工具读出
const DEBUG_LIMIT = 60;
const DEBUG_KEY = "browseruse.debuglog";
export const BOOT_AT = Date.now();
export async function debugLog(message: string): Promise<void> {
  const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
  try {
    const got = await chrome.storage.session.get(DEBUG_KEY);
    const buffer: string[] = Array.isArray(got[DEBUG_KEY]) ? got[DEBUG_KEY] : [];
    buffer.push(line);
    while (buffer.length > DEBUG_LIMIT) buffer.shift();
    await chrome.storage.session.set({ [DEBUG_KEY]: buffer });
  } catch {
    // session 存储不可用时退回 console
  }
  console.debug("[browseruse]", line);
}
export const methods: Record<Method, Handler> = {
  // 汇报状态
  async status(): Promise<StatusResult> {
    const pages = await listPages();
    let log: string[] = [];
    try {
      const got = await chrome.storage.session.get(DEBUG_KEY);
      if (Array.isArray(got[DEBUG_KEY])) log = got[DEBUG_KEY];
    } catch {
      // 忽略
    }
    return {
      protocol: PROTOCOL_VERSION, extensionVersion: chrome.runtime.getManifest().version, browser: browserLabel(), selectedPageId: pages.find((page) => page.selected)?.pageId ?? null,
      attachedTabs: attachedTabs(), pages, debugLog: log, bootAt: new Date(BOOT_AT).toISOString(),
    };
  },
  // 保存归档
  async save_page(params) {
    const tabId = await requireTab(params);
    await ensureAttached(tabId);
    const response = await cdp<{ data?: string }>(tabId, "Page.captureSnapshot", { format: "mhtml" });
    const mhtml = String(response.data ?? "");
    if (!mhtml) throw new HostError("cdp_failed", "Page.captureSnapshot 未返回内容", true);
    const tab = await chrome.tabs.get(tabId);
    return { pageId: tabId, url: tab.url ?? "", title: tab.title ?? "", bytes: mhtml.length, mhtml };
  },
  // 读写端口
  async set_bridge_port(params) {
    const wanted = num(params, "port", null);
    const current = Number((await chrome.storage.local.get("browseruse.port"))["browseruse.port"]) || DEFAULT_PORT;
    if (wanted === null) return { port: current, defaultPort: DEFAULT_PORT, ...connectionState() };
    const port = Math.trunc(wanted);
    if (port < 1024 || port > 65535) throw new HostError("bad_request", `端口需在 1024–65535 之间，实际为 ${port}`);
    await chrome.storage.local.set({ "browseruse.port": port });
    return { previous: current, port, ...connectionState() };
  },
  // 新建页面
  async create_page(params) {
    const mode = choice(params, "mode", ["window", "tab"], "window");
    const url = str(params, "url", "about:blank") as string;
    if (mode === "tab") {
      const tab = await chrome.tabs.create({ url, active: bool(params, "active", false) });
      select(tab.id as number);
      return { mode, pageId: tab.id, windowId: tab.windowId, url: tab.url ?? url, title: tab.title ?? "", focused: bool(params, "active", false) };
    }
    // 普通浏览器新窗口（非 popup、非无痕），focused=false 时后台打开不抢焦点
    const createData: chrome.windows.CreateData = { url, focused: bool(params, "focused", false) };
    for (const key of ["left", "top", "width", "height"] as const) {
      const value = num(params, key, null);
      if (value !== null) createData[key] = Math.trunc(value);
    }
    const win = await chrome.windows.create(createData);
    let tab = win?.tabs?.[0];
    if (!tab?.id && win?.id !== undefined) {
      // 窗口创建回执可能未携带 tabs：回查一次
      await settle(250);
      tab = (await chrome.windows.get(win.id, { populate: true }).catch(() => null))?.tabs?.[0];
    }
    if (!tab?.id) throw new HostError("cdp_failed", "窗口创建成功但未返回标签页", true);
    select(tab.id as number);
    return {
      mode, pageId: tab.id, windowId: win.id, url: tab.url ?? url, title: tab.title ?? "", focused: win.focused === true,
    };
  },
  // 关闭页面
  async close_page(params) {
    const explicit = num(params, "pageId", null);
    const tabId = explicit !== null ? Math.trunc(explicit) : (await listPages()).find((page) => page.selected)?.pageId ?? null;
    if (tabId === null) throw new HostError("no_page", "没有可选定页面：先 list_pages，再由 select_page 选定或向 close_page 传 pageId", true);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new HostError("page_gone", `页面 ${tabId} 已不存在，请重新 list_pages`, true);
    await chrome.tabs.remove(tabId);
    return { closed: tabId, url: tab.url ?? "" };
  },
  // 列出标签
  async list_pages(params) {
    return { browser: browserLabel(), pages: await listPages() };
  },
  // 选定页面
  async select_page(params) {
    const pageId = num(params, "pageId");
    const tab = await chrome.tabs.get(Math.trunc(pageId)).catch(() => null);
    if (!tab) throw new HostError("page_gone", `页面 ${pageId} 已不存在，请重新 list_pages`, true);
    if (bool(params, "bringToFront", false)) {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(pageId, { active: true });
    }
    select(tab.id as number);
    return { pageId: tab.id, url: tab.url ?? "", title: tab.title ?? "", attached: isAttached(tab.id as number) };
  },
  // 执行导航
  async navigate_page(params) {
    const tabId = await requireTab(params);
    const kind = choice(params, "type", ["url", "back", "forward", "reload"], "url");
    const timeoutMs = num(params, "timeout", 20_000) as number;
    const initScript = str(params, "initScript", null);
    if (kind !== "url") {
      // reload/back/forward 依赖 CDP，需要接管；type=url 走 tabs.update，可从占位页/chrome:// 页逃生
      await ensureAttached(tabId);
    }
    if (initScript && kind !== "url") {
      await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: initScript });
    }
    const before = await chrome.tabs.get(tabId);
    armBeforeUnload(tabId, str(params, "handleBeforeUnload", "accept") as "accept" | "dismiss");
    if (kind === "url") {
      const url = str(params, "url");
      if (!url) throw new HostError("bad_request", "type=url 时必须提供 url");
      await chrome.tabs.update(tabId, { url });
      if (initScript) {
        try {
          await ensureAttached(tabId);
          await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: initScript });
        } catch {
          // 占位页上注入失败可容忍：导航本身已生效
        }
      }
    } else if (kind === "reload") {
      await cdp(tabId, "Page.reload", { ignoreCache: bool(params, "ignoreCache", false) });
    } else if (kind === "back" || kind === "forward") {
      const history = await cdp<{ currentIndex?: number; entries?: { url?: string }[] }>(tabId, "Page.getNavigationHistory");
      const target = (history.currentIndex ?? 0) + (kind === "back" ? -1 : 1);
      const entry = history.entries?.[target];
      if (!entry) throw new HostError("bad_request", `无可${kind === "back" ? "前" : "后"}退的历史记录`);
      await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: target });
    } else {
    }
    invalidate(tabId, `navigated:${kind}`);
    await Promise.race([waitForLoad(tabId, timeoutMs), waitCancel(tabId)]);
    const after = await chrome.tabs.get(tabId);
    return { pageId: tabId, from: before.url ?? "", to: after.url ?? "", title: after.title ?? "", beforeUnload: beforeUnloadOutcome(tabId), snapshot: await withTree(tabId, params)};
  },
  // 获取快照
  async take_snapshot(params) {
    const tabId = await requireTab(params);
    return snapshotOf(tabId, params);
  },
  // 获取截图
  async take_screenshot(params) {
    debugLog(`screenshot enter ${JSON.stringify(params)}`);
    const tabId = await requireTab(params);
    let tab = await chrome.tabs.get(tabId).catch(() => null);
    debugLog(`screenshot tab ${tab?.id} active:${tab?.active} status:${tab?.status} win:${tab ? await chrome.windows.get(tab.windowId).then((w) => w.state).catch(() => "?") : "no-tab"}`);
    if (tab && (await chrome.windows.get(tab.windowId).catch(() => null))?.state === "minimized") {
      throw new HostError("window_minimized", "页面所在窗口已最小化，截图无法取得画面：请使窗口可见，或改用 take_snapshot 读取结构", true);
    }
    // 后台标签不出帧：先自动前台化再截
    if (tab && tab.active === false && bool(params, "activate", true)) {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
      tab = await chrome.tabs.get(tabId);
      await settle(300);
    }
    const format = str(params, "format", "png") as string;
    const uid = str(params, "uid", null);
    let clip = null;
    if (uid) {
      const record = resolveUid(tabId, uid);
      await ensureAttached(tabId);
      clip = await boxRect(tabId, record.backendNodeId);
      if (!clip) throw new HostError("uid_not_found", `元素 ${uid} 无可见布局盒`, true);
    }
    const options = { format, quality: num(params, "quality", null), fullPage: bool(params, "fullPage", false), clip };
    let base64: string;
    try {
      // 常规路径：合成器取帧。窗口被遮挡时 Chrome 停止合成，此调用可能迟迟不返回
      debugLog("screenshot surface try");
      base64 = await captureScreenshot(tabId, { ...options, timeoutMs: 12_000 });
      debugLog(`screenshot surface ok ${base64.length}`);
    } catch (error) {
      // 回退：直接向渲染器要最后一帧，不依赖合成器出帧（窗口被遮挡/失焦时仍可取得）
      const first = error instanceof HostError ? error : new HostError("cdp_failed", error instanceof Error ? error.message : String(error));
      debugLog(`screenshot surface failed: ${first.message}`);
      try {
        base64 = await captureScreenshot(tabId, { ...options, fromSurface: false, timeoutMs: 12_000 });
        debugLog(`screenshot renderer ok ${base64.length}`);
      } catch (error2) {
        debugLog(`screenshot renderer failed: ${error2 instanceof Error ? error2.message : String(error2)}`);
        throw new HostError(first.code, `${first.message}；回退 fromSurface=false 亦失败。若窗口被遮挡或最小化，请把浏览器窗口置于前台后重试`, true);
      }
    }
    const size = pngSize(base64);
    debugLog("screenshot layout probe");
    const layout = await layoutInfo(tabId);
    debugLog("screenshot done");
    if (size && layout.width === 0) {
      layout.width = Math.round(size.width / (layout.dpr || 1));
      layout.height = Math.round(size.height / (layout.dpr || 1));
    }
    return {
      pageId: tabId, format, base64, bytes: Math.round((base64.length * 3) / 4), clip, activated: tab?.active === true,
      layout: { ...layout, screenshotWidth: size?.width ?? layout.screenshotWidth, screenshotHeight: size?.height ?? layout.screenshotHeight },
    };
  },
  // 点击元素
  async click(params) {
    const tabId = await requireTab(params);
    const uid = str(params, "uid");
    const center = await uidCenter(tabId, uid);
    await clickAt(tabId, { x: center.x, y: center.y, button: str(params, "button", "left") as "left" | "right" | "middle", clickCount: bool(params, "dblClick", false) ? 2 : 1 });
    return { pageId: tabId, action: "click", uid, at: center, snapshot: await withTree(tabId, params) };
  },
  // 悬停元素
  async hover(params) {
    const tabId = await requireTab(params);
    const uid = str(params, "uid");
    const center = await uidCenter(tabId, uid);
    await hoverAt(tabId, center.x, center.y);
    return { pageId: tabId, action: "hover", uid, at: center, snapshot: await withTree(tabId, params) };
  },
  // 拖拽元素
  async drag(params) {
    const tabId = await requireTab(params);
    const fromUid = str(params, "from_uid");
    const toUid = str(params, "to_uid");
    await dragTo(tabId, await uidCenter(tabId, fromUid), await uidCenter(tabId, toUid), num(params, "duration", 200) as number);
    return { pageId: tabId, action: "drag", from: fromUid, to: toUid, snapshot: await withTree(tabId, params) };
  },
  // 填充输入
  async fill(params) {
    const tabId = await requireTab(params);
    const uid = str(params, "uid");
    const record = resolveUid(tabId, uid);
    const value = str(params, "value", "") as string;
    const focused = await focusField(tabId, record.backendNodeId);
    if (focused.editable) {
      await pressChord(tabId, "Control+A");
      if (value === "") await pressChord(tabId, "Delete");
      else await insertText(tabId, value);
    } else if (focused.tag === "select") {
      await selectOption(tabId, record.backendNodeId, value, uid);
    } else {
      throw new HostError("bad_request", `元素 ${uid} 解析为 <${focused.tag}>，不是可填充的输入框、文本域、下拉框或 contenteditable`);
    }
    return { pageId: tabId, action: "fill", uid, valueLength: value.length, snapshot: await withTree(tabId, params) };
  },
  // 派发按键
  async press_key(params) {
    const tabId = await requireTab(params);
    const pressed = await pressChord(tabId, str(params, "key"));
    return { pageId: tabId, action: "press_key", key: pressed, snapshot: await withTree(tabId, params) };
  },
  // 等待条件
  async wait_for(params) {
    const tabId = await requireTab(params);
    const needles = (Array.isArray(params.text) ? (params.text as unknown[]) : params.text ? [params.text] : []).map((item) => String(item));
    const selector = str(params, "selector", null);
    const uid = str(params, "uid", null);
    const predicate = str(params, "function", null);
    const state = choice(params, "state", ["visible", "attached", "hidden", "detached"], "visible");
    if (!needles.length && !selector && !uid && !predicate) throw new HostError("bad_request", "text / selector / uid / function 至少提供一项");
    const timeoutMs = num(params, "timeout", 10_000) as number;
    const startAt = Date.now();
    const deadline = startAt + timeoutMs;
    const wanted = state === "visible" || state === "attached";
    let uidRetired = false;
    for (;;) {
      const missing: string[] = [];
      if (needles.length) {
        const text = await evaluateMain<string>(tabId, `() => document.body ? document.body.innerText : ''`);
        const haystack = String(text.value ?? "");
        for (const needle of needles) if (!haystack.includes(needle)) missing.push(`文本 ${JSON.stringify(needle)}`);
      }
      if (uid || selector) {
        let backendNodeId: number | null = null;
        if (uid) {
          try {
            backendNodeId = resolveUid(tabId, uid).backendNodeId;
          } catch {
            uidRetired = true;
          }
        } else {
          backendNodeId = (await queryAll(tabId, selector as string, 1)).backendNodeIds[0] ?? null;
        }
        const found = backendNodeId === null ? false : await elementPresent(tabId, backendNodeId, state);
        if (found !== wanted) {
          missing.push(`${uid ? `元素 ${uid}${uidRetired ? "（快照已作废）" : ""}` : `选择器 ${JSON.stringify(selector)}`} 当前${found ? "满足" : "不满足"}，目标为${wanted ? "存在" : "不存在"}`);
        }
      }
      if (predicate && !(await evaluateMain<boolean>(tabId, predicate)).value) missing.push("函数尚未为真");
      if (!missing.length) {
        return {
          pageId: tabId,
          waitedFor: [...needles, uid ? `元素 ${uid} ${state}` : selector ? `选择器 ${selector} ${state}` : null, predicate ? "自定义函数为真" : null].filter((row): row is string => Boolean(row)),
          found: true, uidRetired, elapsedMs: Date.now() - startAt,
        };
      }
      if (Date.now() >= deadline) {
        throw new HostError("timeout", `等待 ${timeoutMs}ms 后条件未满足：${missing.join(" / ")}；页面正文前 200 字：${String((await evaluateMain<string>(tabId, `() => document.body ? document.body.innerText : ''`)).value ?? "").slice(0, 200)}`, true);
      }
      await settle(200);
    }
  },
  // 应答弹窗
  async handle_dialog(params) {
    const tabId = await requireTab(params);
    const dialog = pendingDialog(tabId);
    if (!dialog) throw new HostError("no_dialog", "当前页面无待处理对话框");
    const accept = str(params, "action", "accept") === "accept";
    await handleDialog(tabId, accept, str(params, "promptText", null));
    return { pageId: tabId, accepted: accept, wasType: dialog.type, message: dialog.message };
  },
  // 传入文件
  async upload_file(params) {
    const tabId = await requireTab(params);
    const uid = str(params, "uid");
    const filePath = str(params, "filePath");
    const record = resolveUid(tabId, uid);
    await attachFiles(tabId, record.backendNodeId, [filePath]);
    return { pageId: tabId, action: "upload_file", uid, filePath, snapshot: await withTree(tabId, params) };
  },
  // 执行脚本
  async evaluate_script(params) {
    const tabId = await requireTab(params);
    const functionSource = str(params, "function");
    const dialog = pendingDialog(tabId);
    const dialogAction = str(params, "dialogAction", null);
    if (dialog) {
      if (!dialogAction) {
        throw new HostError("no_dialog", `页面被 ${dialog.type} 对话框阻塞（${dialog.message}），请先执行 handle_dialog`, true);
      }
      await handleDialog(tabId, dialogAction !== "dismiss", null);
    }
    if (bool(params, "waitForStableDom", false)) await waitStable(tabId, num(params, "timeout", 5_000) as number);
    const uids = Array.isArray(params.args) ? (params.args as unknown[]).map((item) => parseUid(item)) : [];
    const resolvedUids = uids.filter((item): item is { snapshotSeq: number; index: number } => item !== null);
    if (uids.length !== resolvedUids.length) throw new HostError("bad_request", "args 仅接受 take_snapshot 返回的 uid，形如 5_12");
    const contextNeedle = str(params, "context", null);
    let context = null;
    if (contextNeedle) {
      if (resolvedUids.length) throw new HostError("bad_request", "args 与 context 不可同时提供：元素 uid 仅在页面 main world 可解析");
      context = resolveContext(tabId, contextNeedle);
    }
    const evaluated = resolvedUids.length
      ? await evaluateWithArgs(tabId, functionSource, await objectIds(tabId, resolvedUids))
      : await evaluateMain(tabId, functionSource, { awaitPromise: true, context: context ?? undefined });
    if (evaluated.threw) throw new HostError("cdp_failed", `页面抛出异常：${evaluated.threw}`);
    return {
      pageId: tabId, world: context ? context.name || context.origin : "main", contextId: context?.contextId ?? null, value: evaluated.value, unserializable: evaluated.unserializable,
      snapshot: await withTree(tabId, params),
    };
  },
  // 检查元素
  async inspect_element(params) {
    const tabId = await requireTab(params);
    const uid = str(params, "uid", null);
    const selector = str(params, "selector", null);
    if (!uid && !selector) throw new HostError("bad_request", "inspect_element 需提供 uid 或 selector");
    const options = { outerLimit: num(params, "htmlChars", 1_600) as number, allStyles: bool(params, "allStyles", false)};
    let backendNodeIds: number[];
    let matched = 1;
    let semantic: Record<string, unknown> = {};
    if (uid) {
      await ensureAttached(tabId);
      const record = resolveUid(tabId, uid);
      semantic = { role: record.role, accessibleName: record.name };
      backendNodeIds = [record.backendNodeId];
    } else {
      const found = await queryAll(tabId, selector as string, num(params, "limit", 5) as number);
      if (!found.backendNodeIds.length) throw new HostError("not_found", `选择器 ${JSON.stringify(selector)} 在页面上无命中元素`, true);
      backendNodeIds = found.backendNodeIds;
      matched = found.total;
    }
    const elements: unknown[] = [];
    for (const backendNodeId of backendNodeIds) elements.push({ ...semantic, ...(await inspectElement(tabId, backendNodeId, options)) });
    return { pageId: tabId, matched, truncated: matched > elements.length, elements };
  },
  // 列出世界
  async list_worlds(params) {
    const tabId = await requireTab(params);
    await ensureAttached(tabId);
    const rows = contextsOf(tabId);
    const ids = [...new Set(rows.map((row) => /^chrome-extension:\/\/([^/]+)/.exec(row.origin)?.[1]).filter((item): item is string => Boolean(item)))];
    const owners = new Map<string, string>();
    await Promise.all(
      ids.map(async (extensionId) => {
        const detail = await chrome.management.get(extensionId).catch(() => null);
        if (detail?.name) owners.set(extensionId, detail.name);
      }),
    );
    return {
      pageId: tabId,
      contexts: rows.map((row) => {
        const extensionId = /^chrome-extension:\/\/([^/]+)/.exec(row.origin)?.[1] ?? null;
        return { ...row, extensionId, owner: extensionId ? owners.get(extensionId) ?? null : null };
      }),
    };
  },
  // 列出脚本
  async list_scripts(params) {
    const tabId = await requireTab(params);
    await openDebugger(tabId);
    const needle = (str(params, "filter", "") as string).toLowerCase();
    const deadline = Date.now() + 600;
    let index = scriptsOf(tabId);
    while (!index.scripts.length && Date.now() < deadline) {
      await settle(60);
      index = scriptsOf(tabId);
    }
    const { scripts, topFrameId } = index;
    const rows = scripts
      .filter((script) => bool(params, "allFrames", false) || !script.frameId || script.frameId === topFrameId)
      .filter((script) => !needle || script.url.toLowerCase().includes(needle));
    const limit = num(params, "limit", 200) as number;
    return {
      pageId: tabId,
      total: rows.length,
      shown: Math.min(rows.length, limit),
      scripts: rows.slice(0, limit).map((script) => ({
        scriptId: script.scriptId,
        url: script.url || "(内联或 eval)",
        lines: script.lines,
        topFrame: !script.frameId || script.frameId === topFrameId,
      })),
    };
  },
  // 读取源码
  async read_script(params) {
    const tabId = await requireTab(params);
    await openDebugger(tabId);
    const scriptId = str(params, "scriptId", null);
    const needle = (str(params, "url", "") as string).toLowerCase();
    const { scripts } = scriptsOf(tabId);
    let record = scriptId ? scriptOf(tabId, scriptId) : null;
    if (!record && !scriptId && needle) {
      const hits = scripts.filter((script) => script.url.toLowerCase().includes(needle));
      if (!hits.length) throw new HostError("not_found", `无 url 包含 ${JSON.stringify(needle)} 的脚本，先 list_scripts 查看索引`, true);
      if (hits.length > 1) {
        throw new HostError("bad_request", `${JSON.stringify(needle)} 命中 ${hits.length} 个脚本，请改用 scriptId：\n${hits.map((hit) => `${ hit.scriptId } ${ hit.url }`).join("\n")}`);
      }
      record = hits[0];
    }
    if (!record) throw new HostError("not_found", `脚本索引中不存在 ${scriptId ?? needle}，先 list_scripts`);
    const source = await scriptSource(tabId, record.scriptId);
    const lines = source.split(/\r?\n/);
    const fromLine = Math.max(1, num(params, "fromLine", 1) as number);
    const toLine = Math.min(lines.length, num(params, "toLine", lines.length) as number);
    const maxChars = num(params, "maxChars", 20_000) as number;
    const body = lines.slice(fromLine - 1, toLine).join("\n");
    return {
      pageId: tabId, scriptId: record.scriptId, url: record.url || "(内联或 eval)", lines: lines.length, fromLine, toLine, truncated: body.length > maxChars,
      source: body.slice(0, maxChars),
    };
  },
  // 管理断点
  async handle_breakpoints(params) {
    const tabId = await requireTab(params);
    const action = choice(params, "action", ["list", "add", "remove", "clear", "activate", "deactivate", "add_listener", "remove_listener"], "list");
    if (action === "list") {
      await openDebugger(tabId);
      return { pageId: tabId, action, breakpoints: breakpointsOf(tabId), paused: pausedState(tabId) !== null };
    }
    if (action === "add") {
      const scriptId = str(params, "scriptId", null);
      const url = str(params, "url", null);
      if (!scriptId && !url) throw new HostError("bad_request", "add 需提供 url 或 scriptId（两者均取自 list_scripts）");
      const line = num(params, "line");
      const added = await setBreakpoint(tabId, {
        scriptId: scriptId ?? undefined,
        url: url ?? undefined,
        line: Math.max(0, line - 1),
        column: num(params, "column", 0) as number,
        condition: str(params, "condition", null) ?? undefined,
      });
      return { pageId: tabId, action, line, ...added };
    }
    if (action === "remove") {
      const breakpointId = str(params, "breakpointId");
      const records = breakpointsOf(tabId);
      if (!records.some((record) => record.breakpointId === breakpointId)) {
        throw new HostError("not_found", `断点表中不存在 ${breakpointId}，先 action=list`);
      }
      await removeBreakpoint(tabId, breakpointId);
      return { pageId: tabId, action, removed: breakpointId, left: records.length - 1 };
    }
    if (action === "clear") {
      const before = breakpointsOf(tabId).length;
      for (const record of breakpointsOf(tabId)) await removeBreakpoint(tabId, record.breakpointId);
      return { pageId: tabId, action, removed: before };
    }
    if (action === "add_listener" || action === "remove_listener") {
      const eventName = choice(params, "eventName", ["alert", "beforeunload", "blur", "change", "click", "copy", "cut", "paste", "DOMContentLoaded", "load", "resize", "scroll", "XHR", "fetch"], "");
      if (!eventName) throw new HostError("bad_request", "listener/unlistener 需带 eventName");
      await setListener(tabId, eventName, action === "add_listener");
      const left = listenerNames(tabId).filter((item) => item !== eventName);
      const watching = action === "add_listener" ? [...left, eventName] : left;
      setListenerNames(tabId, watching);
      return { pageId: tabId, action, eventName, watching };
    }
    if (action === "activate" || action === "deactivate") {
      await setBreakpointsActive(tabId, action === "activate");
      return { pageId: tabId, action, active: action === "activate", kept: breakpointsOf(tabId).length };
    }
  },
  // 暂停控制
  async handle_pause(params) {
    const tabId = await requireTab(params);
    const action = choice(params, "action", ["state", "resume", "step_over", "step_into", "step_out", "pause", "exceptions"], "state");
    if (action === "exceptions") {
      const state = choice(params, "exceptionState", ["none", "uncaught", "all"], "uncaught");
      await setPauseOnExceptions(tabId, state);
      return { pageId: tabId, action, exceptionState: state };
    }
    if (action !== "state") {
      const step = { resume: "continue", step_over: "over", step_into: "into", step_out: "out", pause: "pause" } as const;
      const state = await runAction(tabId, step[action as keyof typeof step]);
      const top = state?.frames?.[0];
      return {
        pageId: tabId, action, paused: Boolean(state), at: top ? { function: top.functionName, url: top.url, line: top.lineNumber + 1 } : null,
        heldForMs: state ? Date.now() - state.at : null,
      };
    }
    const frameIndex = num(params, "frameIndex", 0) as number;
    const snapshot = await pauseInfo(tabId, frameIndex);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!snapshot) return { pageId: tabId, action, paused: false, url: tab?.url ?? "", value: null };
    const functionSource = str(params, "function", null);
    let value: unknown = null;
    let unserializable: string | null = null;
    if (functionSource) {
      const evaluated = await evaluateFrame(tabId, (snapshot.frameIds as string[])[Math.max(0, Math.min((snapshot.frameIds as string[]).length - 1, frameIndex))], functionSource);
      if (evaluated.threw) throw new HostError("cdp_failed", `在该调用帧内求值失败：${evaluated.threw}`);
      value = evaluated.value;
      unserializable = evaluated.unserializable;
    }
    return { pageId: tabId, action, paused: true, url: tab?.url ?? "", ...snapshot, value, unserializable };
  },
  // 管理拦截
  async intercept_requests(params) {
    const tabId = await requireTab(params);
    const action = choice(params, "action", ["list", "add", "remove", "stop", "clear"], "list");
    const ttlMs = Math.min(600_000, Math.max(5_000, num(params, "ttlMs", INTERCEPT_TTL_MS) as number));
    const rules = interceptRules(tabId);
    const expire = () => {
      void stopIntercept(tabId).then(() => notify("intercept_expired", { pageId: tabId }));
    };
    if (action === "list") {
      const state = interceptState(tabId);
      return { pageId: tabId, action, on: state.on, leftMs: state.on ? Math.max(0, state.deadline - Date.now()) : 0, rules, hits: state.hits.slice(-25), hitTotal: state.hits.length };
    }
    if (action === "add") {
      const match = str(params, "match");
      const ruleAction = choice(params, "ruleAction", ["continue", "abort", "block", "redirect", "mock"], "block") as InterceptRule["action"];
      const rule: InterceptRule = { match, action: ruleAction };
      if (ruleAction === "redirect") rule.redirectTo = str(params, "redirectTo", "") || undefined;
      if (ruleAction === "mock") {
        rule.status = num(params, "status", 200) as number;
        rule.contentType = str(params, "contentType", "application/json") || undefined;
        rule.body = str(params, "body", "") || undefined;
        if (params.headers && typeof params.headers === "object") rule.headers = params.headers as Record<string, string>;
      }
      const next = [...rules.filter((item) => item.match !== match), rule];
      setRules(tabId, next);
      await syncIntercept(tabId);
      armExpiry(tabId, ttlMs, expire);
      const state = interceptState(tabId);
      return { pageId: tabId, action, match, ruleAction, on: state.on, rules: next.length, leftMs: Math.max(0, state.deadline - Date.now()) };
    }
    if (action === "remove") {
      const match = str(params, "match");
      const next = rules.filter((item) => item.match !== match);
      setRules(tabId, next);
      await syncIntercept(tabId);
      const state = interceptState(tabId);
      if (state.on) armExpiry(tabId, ttlMs, expire);
      return { pageId: tabId, action, match, rules: next.length, on: state.on };
    }
    if (action === "stop") {
      await stopIntercept(tabId);
      return { pageId: tabId, action, on: false, kept: rules.length };
    }
    if (action === "clear") {
      setRules(tabId, []);
      await stopIntercept(tabId);
      return { pageId: tabId, action, on: false, removed: rules.length };
    }
  },
  // 读取存储
  async list_storage(params) {
    const tabId = await requireTab(params);
    const scope = choice(params, "scope", ["cookies", "local", "session", "databases", "all"], "cookies");
    const tab = await chrome.tabs.get(tabId);
    const origin = str(params, "origin", null) || new URL(tab.url ?? "http://localhost").origin;
    const wants = scope === "all" ? ["cookies", "local", "session", "databases"] : [scope];
    const out: Record<string, unknown> = { pageId: tabId, scope, origin };
    if (wants.includes("cookies")) {
      const response = await cdp<{ cookies?: Record<string, any>[] }>(tabId, "Network.getCookies", { urls: [origin] });
      out.cookies = (response.cookies ?? []).map((item) => ({
        name: String(item.name ?? ""),
        value: String(item.value ?? "").slice(0, 200),
        domain: String(item.domain ?? ""),
        path: String(item.path ?? ""),
        expires: Number(item.expires ?? -1),
        httpOnly: item.httpOnly === true,
        secure: item.secure === true,
        sameSite: String(item.sameSite ?? ""),
      }));
    }
    if (wants.includes("local") || wants.includes("session")) {
      const picked = await evaluateMain<Record<string, { length?: number; error?: string; items?: Record<string, string> }>>(
        tabId,
        `async () => { const read = (name) => { try { const store = window[name]; const items = {};
            for (let i = 0; i < Math.min(store.length, 50); i += 1) { const key = store.key(i); items[key] = String(store.getItem(key)).slice(0, 200); }
            return { length: store.length, items }; } catch (error) { return { error: String((error && error.message) || error) }; } };
          return { local: read('localStorage'), session: read('sessionStorage') }; }`,
      );
      const value = picked.value ?? {};
      if (wants.includes("local")) out.local = value.local ?? null;
      if (wants.includes("session")) out.session = value.session ?? null;
    }
    if (wants.includes("databases")) {
      const dbs = await evaluateMain<{ name?: string; version?: number }[]>(tabId, `async () => (await indexedDB.databases()).map((item) => ({ name: item.name, version: item.version}))`);
      out.databases = dbs.value ?? [];
    }
    return out;
  },
  // 管理后台
  async handle_worker(params) {
    const action = choice(params, "action", ["list", "attach", "detach", "console", "evaluate"], "list");
    const prefix = str(params, "targetId", "") as string;
    const attached = () => workerSessions().find((entry) => entry.targetId.startsWith(prefix)) ?? null;
    if (action === "list") {
      const open = new Map(workerSessions().map((entry) => [entry.targetId, entry]));
      return {
        action,
        targets: (await listTargets()).map((target) => ({
          targetId: target.targetId.slice(0, 8),
          url: target.url,
          type: target.type,
          title: target.title,
          attached: open.has(target.targetId),
          consoleEntries: open.get(target.targetId)?.console.length ?? 0,
        })),
        note: "仅列出 chrome.debugger 可见的目标；站点自身的 service worker 可挂接，其它扩展的后台会被 Chrome 拒绝。",
      };
    }
    if (!prefix) throw new HostError("bad_request", "attach/detach/evaluate/console 均需 targetId（取 list 返回的 8 位前缀即可）");
    const resolve = async (): Promise<string> => {
      const known = attached();
      if (known) return known.targetId;
      const found = (await listTargets()).find((target) => target.targetId.startsWith(prefix));
      if (!found) throw new HostError("not_found", `无 targetId 以 ${JSON.stringify(prefix)} 开头的目标，先 action=list`);
      return found.targetId;
    };
    if (action === "attach") {
      const targetId = await resolve();
      await attachWorker(targetId);
      return { action, targetId: prefix, url: attached()?.url ?? "", consoleEntries: attached()?.console.length ?? 0 };
    }
    if (action === "detach") {
      await detachWorker(await resolve());
      return { action, targetId: prefix };
    }
    if (action === "console") {
      const session = attached();
      if (!session) throw new HostError("not_attached", `该 target 尚未 attach，先执行 action=attach`, true);
      return { action, targetId: prefix, total: session.console.length, pageIdx: 0, page: session.console.slice().reverse() };
    }
    if (action === "evaluate") {
      const targetId = await resolve();
      if (!attached()) await attachWorker(targetId);
      const evaluated = await evaluateWorker(targetId, str(params, "function") as string);
      if (evaluated.threw) throw new HostError("cdp_failed", `worker 内抛出异常：${evaluated.threw}`);
      return { action, targetId: prefix, value: evaluated.value, unserializable: evaluated.unserializable };
    }
  },
  // 性能录制
  async trace_page(params) {
    const tabId = await requireTab(params);
    const action = choice(params, "action", ["run", "stop", "status"], "run");
    if (action === "status") {
      const state = traceState(tabId);
      return { pageId: tabId, action, recording: state.on, events: state.events.length, leftMs: state.on ? Math.max(0, state.deadline - Date.now()) : 0 };
    }
    if (action === "stop") return { pageId: tabId, action, ...(await stopTrace(tabId)) };
    if (action === "run") {
      const durationMs = Math.min(60_000, Math.max(200, num(params, "durationMs", 1_500) as number));
      await startTrace(tabId, Array.isArray(params.categories) ? (params.categories as unknown[]).map(String) : [], Math.min(120_000, durationMs + 10_000));
      await settle(durationMs);
      return { pageId: tabId, action, durationMs, ...(await stopTrace(tabId)) };
    }
  },
  // 管理下载
  async handle_downloads(params) {
    const action = choice(params, "action", ["list", "wait", "cancel"], "list");
    const recent = async (limit: number) =>
      (await chrome.downloads.search({ limit, orderBy: ["startTime"] })).map((item) => ({
        id: item.id,
        filename: item.filename,
        url: String(item.url ?? "").slice(0, 200),
        state: item.state,
        totalBytes: item.totalBytes ?? 0,
        bytesReceived: item.bytesReceived ?? 0,
        danger: item.danger,
      }));
    if (action === "list") return { action, downloads: await recent(num(params, "limit", 15) as number) };
    if (action === "cancel") {
      const id = Math.trunc(num(params, "downloadId"));
      await chrome.downloads.cancel(id);
      return { action, id };
    }
    if (action === "wait") {
      const match = str(params, "match", "") as string;
      const timeoutMs = num(params, "timeout", 30_000) as number;
      const startAt = Date.now();
      const deadline = startAt + timeoutMs;
      for (;;) {
        const rows = await recent(30);
        const hit = rows.find((item) => (!match || `${item.filename} ${item.url}`.includes(match)) && (item.state === "complete" || item.state === "interrupted"));
        if (hit) return { action, download: hit, waitedMs: Date.now() - startAt };
        if (Date.now() >= deadline) {
          throw new HostError(
            "timeout",
            `等待 ${timeoutMs}ms 无完成的下载${match ? `（match=${ JSON.stringify(match)}）` : ""}；最近的：${
              rows.slice(0, 3).map((item) => `${item.state} ${item.filename}`).join(" / ") || "（无下载记录）"
            }`,
            true,
          );
        }
        await settle(400);
      }
    }
  },
  // 管理扩展
  async manage_extensions(params) {
    const action = choice(params, "action", ["list", "get", "enable", "disable", "open_options"], "list");
    const selfId = chrome.runtime.id;
    const id = str(params, "extensionId", null);
    if (action !== "list" && !id) throw new HostError("bad_request", `action=${action} 需要 extensionId；先 action=list 获取`);
    if (action === "list") {
      const all = await chrome.management.getAll();
      const rows = all
        .filter((item) => bool(params, "includeOtherTypes", false) || item.type === "extension")
        .map((item) => ({ id: item.id, name: item.name, version: item.version, enabled: item.enabled, type: item.type, self: item.id === selfId }));
      return { action, total: rows.length, extensions: rows };
    }
    if (action === "get") {
      const detail = await chrome.management.get(id as string);
      const extra = detail as { url?: string; homepageUrl?: string };
      return { action, id: detail.id, name: detail.name, version: detail.version, enabled: detail.enabled, type: detail.type, url: extra.url ?? extra.homepageUrl ?? "" };
    }
    if (action === "enable" || action === "disable") {
      if (id === selfId) throw new HostError("bad_request", "不能停用 BrowserUse 自身：通道会立即断开");
      const detail = await chrome.management.get(id as string);
      await chrome.management.setEnabled(id as string, action === "enable");
      return { action, id, name: detail.name, version: detail.version, enabled: action === "enable" };
    }
    if (action === "open_options") {
      const detail = await chrome.management.get(id as string);
      const url = (detail as { optionsUi?: string; optionsUrl?: string }).optionsUi ?? detail.optionsUrl;
      if (!url) throw new HostError("not_found", `${detail.name} 未声明选项页`);
      const tab = await chrome.tabs.create({ url });
      return { action, id, name: detail.name, url, pageId: tab.id ?? null };
    }
  },
  // 列出请求
  async list_network_requests(params) {
    const tabId = await requireTab(params);
    const epoch = currentEpoch(tabId);
    const includePreserved = bool(params, "includePreservedRequests", false);
    const types = (Array.isArray(params.resourceTypes) ? (params.resourceTypes as unknown[]).map(String) : []).map((type) => type.toLowerCase());
    const entries = networkEntries(tabId).filter((entry) => (includePreserved || entry.epoch >= epoch) && (types.length === 0 || types.includes(entry.resourceType.toLowerCase())));
    return { pageId: tabId, ...paging(entries.slice().reverse(), params) };
  },
  // 列出日志
  async list_console_messages(params) {
    const tabId = await requireTab(params);
    const epoch = currentEpoch(tabId);
    const includePreserved = bool(params, "includePreservedMessages", false);
    const types = (Array.isArray(params.types) ? (params.types as unknown[]).map(String) : []).map((type) => type.toLowerCase());
    const entries = consoleEntries(tabId)
      .filter((entry) => (includePreserved || entry.epoch >= epoch) && (types.length === 0 || types.includes(entry.type.toLowerCase())))
      .map((entry) => (bool(params, "includeStackTraces", false) ? entry : { ...entry, stack: undefined }));
    return { pageId: tabId, ...paging(entries.slice().reverse(), params) };
  },
  // 全部摘除
  async detach() {
    const tabs = attachedTabs();
    await Promise.all(tabs.map((tabId) => detach(tabId)));
    return { detached: tabs };
  },
};
// 等待稳定
async function waitStable(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  while (Date.now() < deadline) {
    const size = await evaluateMain<number>(tabId, `() => document.body ? document.body.innerHTML.length : 0`);
    const current = Number(size.value ?? 0);
    if (current === previous) return;
    previous = current;
    await settle(150);
  }
}
// 监听回收
export function watchTabUrls(): void {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.discarded || changeInfo.status === "unloaded") invalidate(tabId, "tab:discarded");
  });
}
