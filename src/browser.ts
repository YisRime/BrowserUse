import { HostError, parseUid } from "./protocol";
import type { PageInfo } from "./protocol";
const NETWORK_LIMIT = 500;
const CONSOLE_LIMIT = 500;
const SCRIPT_LIMIT = 800;
export type ElementRecord = { uid: string; index: number; backendNodeId: number; role: string; name: string; line: string };
export type NetworkEntry = {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  encodedDataLength?: number;
  startedAt: number;
  finishedAt?: number;
  failed?: string;
  epoch: number;
};
export type ConsoleEntry = { type: string; text: string; timestamp: number; source?: string; line?: number; level?: string; stack?: string; world?: string; epoch: number };
export type ContextInfo = { contextId: number; name: string; origin: string; isDefault: boolean; type: string; frameId: string };
export type ScriptRecord = { scriptId: string; url: string; frameId: string; lines: number };
export type BreakpointRecord = { breakpointId: string; url: string; scriptId?: string; lineNumber: number; columnNumber: number; condition?: string; enabled: boolean };
export type CallFrameInfo = {
  index: number;
  callFrameId: string;
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  scopes: { type: string; name?: string; objectId?: string; className?: string; preview?: string }[];
};
export type PauseState = { reason: string; hitBreakpoints: string[]; frames: CallFrameInfo[]; at: number };
export type InterceptRule = {
  match: string;
  action: "continue" | "abort" | "block" | "redirect" | "mock";
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  redirectTo?: string;
};
export type InterceptHit = { url: string; method: string; type: string; action: string; at: number };
export type WorkerSession = { targetId: string; url: string; type: string; attachedAt: number; console: ConsoleEntry[] };
export type TraceState = { on: boolean; events: Record<string, any>[]; deadline: number; complete: boolean };
type Session = {
  attached: boolean;
  snapshotSeq: number;
  snapshots: Map<number, ElementRecord[]>;
  network: NetworkEntry[];
  console: ConsoleEntry[];
  dialog: { type: string; message: string; promptText?: string } | null;
  epoch: number;
  contexts: Map<number, ContextInfo>;
  topFrameId: string;
  scripts: ScriptRecord[];
  debuggerOn: boolean;
  beforeUnload: "accept" | "dismiss" | null;
  beforeUnloadHandled: "accept" | "dismiss" | null;
  breakpoints: Map<string, BreakpointRecord>;
  paused: PauseState | null;
  pauseTimer: ReturnType<typeof setTimeout> | null;
  listenerNames: string[];
  rules: InterceptRule[];
  interceptOn: boolean;
  interceptDeadline: number;
  interceptTimer: ReturnType<typeof setTimeout> | null;
  interceptHits: InterceptHit[];
  trace: TraceState;
};
const sessions = new Map<number, Session>();
let selectedPageId: number | null = null;
let emit: (name: string, payload?: unknown) => void = () => {};
let connection: { connected: boolean; endpoint: string } = { connected: false, endpoint: "" };
// 写入连接
export function setConnection(next: { connected: boolean; endpoint: string }): void {
  connection = next;
}
// 读取连接
export function connectionState(): { connected: boolean; endpoint: string } {
  return connection;
}
// 注册发帧
export function setEmitter(fn: (name: string, payload?: unknown) => void): void {
  emit = fn;
}
// 推送事件
export function notify(name: string, payload?: unknown): void {
  emit(name, payload);
}
// 浏览器名
export function browserLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Edg\//i.test(ua) ? "edge" : "chrome";
}
// 取用会话
function session(tabId: number): Session {
  let entry = sessions.get(tabId);
  if (!entry) {
    entry = {
      attached: false, snapshotSeq: 0, snapshots: new Map(), network: [], console: [], dialog: null, epoch: 0, contexts: new Map(), topFrameId: "", scripts: [], debuggerOn: false,
      beforeUnload: null, beforeUnloadHandled: null, breakpoints: new Map(), paused: null, pauseTimer: null, listenerNames: [], rules: [], interceptOn: false, interceptDeadline: 0,
      interceptTimer: null, interceptHits: [], trace: { on: false, events: [], deadline: 0, complete: false },
    };
    sessions.set(tabId, entry);
  }
  return entry;
}
// 查询接管
export const isAttached = (tabId: number): boolean => sessions.get(tabId)?.attached === true;
// 已接管页
export const attachedTabs = (): number[] => [...sessions.entries()].filter(([, entry]) => entry.attached).map(([tabId]) => tabId);
// 标记接管
export function markAttached(tabId: number, attached: boolean): void {
  const entry = session(tabId);
  entry.attached = attached;
  if (attached) return;
  stopPause(tabId);
  entry.snapshots.clear();
  entry.contexts.clear();
  entry.breakpoints.clear();
  if (entry.interceptTimer) clearTimeout(entry.interceptTimer);
  Object.assign(entry, {
    dialog: null, scripts: [], debuggerOn: false, beforeUnload: null, beforeUnloadHandled: null,
    paused: null, listenerNames: [], rules: [], interceptOn: false, interceptDeadline: 0, interceptTimer: null, interceptHits: [],
  });
}
// 作废快照
export function invalidate(tabId: number, reason: string): void {
  const entry = sessions.get(tabId);
  if (!entry) return;
  const retired = entry.snapshots.size;
  entry.snapshots.clear();
  entry.epoch += 1;
  if (retired) emit("snapshot_invalidated", { pageId: tabId, reason, retired });
}
// 读取轮次
export const currentEpoch = (tabId: number): number => session(tabId).epoch;
// 列出页面
export async function listPages(): Promise<PageInfo[]> {
  const windows = await chrome.windows.getAll({ populate: true });
  const pages: PageInfo[] = [];
  for (const browserWindow of windows) {
    for (const tab of browserWindow.tabs ?? []) {
      const tabId = tab.id;
      if (tabId === undefined) continue;
      if ((tab.url ?? "").startsWith("devtools://")) continue;
      pages.push({ pageId: tabId, url: tab.url ?? "", title: tab.title ?? "", active: tab.active === true, attached: isAttached(tabId), selected: selectedPageId === tabId });
    }
  }
  return pages;
}
// 选定页面
export function select(tabId: number): void {
  selectedPageId = tabId;
}
// 分配序号
export function nextSeq(tabId: number): number {
  const entry = session(tabId);
  entry.snapshotSeq += 1;
  return entry.snapshotSeq;
}
// 保存快照
export function saveTree(tabId: number, seq: number, records: ElementRecord[]): void {
  const entry = session(tabId);
  entry.snapshots.set(seq, records);
  while (entry.snapshots.size > 4) {
    const oldest = [...entry.snapshots.keys()].find((key) => key !== seq);
    if (oldest === undefined) break;
    entry.snapshots.delete(oldest);
  }
}
// 换取元素
export function resolveUid(tabId: number, uid: unknown): ElementRecord {
  const parsed = parseUid(uid);
  if (!parsed) throw new HostError("bad_request", `uid ${JSON.stringify(uid)} 格式不正确，形如 5_12`);
  const entry = session(tabId);
  const records = entry.snapshots.get(parsed.snapshotSeq) ?? null;
  if (!records) {
    throw new HostError("stale_snapshot", `uid ${String(uid)} 属于快照 ${parsed.snapshotSeq}，当前为 ${entry.snapshotSeq}（页面已变化或被回收），请重新 take_snapshot`, true);
  }
  const record = records.find((item) => item.index === parsed.index);
  if (!record) throw new HostError("uid_not_found", `快照 ${parsed.snapshotSeq} 中不存在元素 ${parsed.index}`);
  return record;
}
// 记录请求
export function recordNetwork(tabId: number, requestId: string, patch: Partial<NetworkEntry>): void {
  const entry = session(tabId);
  const existing = entry.network.find((item) => item.requestId === requestId);
  if (existing) {
    Object.assign(existing, patch);
    return;
  }
  entry.network.push({ requestId, url: "", method: "", resourceType: "other", startedAt: Date.now(), epoch: entry.epoch, ...patch });
  if (entry.network.length > NETWORK_LIMIT) entry.network.splice(0, entry.network.length - NETWORK_LIMIT);
}
// 请求列表
export const networkEntries = (tabId: number): NetworkEntry[] => session(tabId).network;
// 记录日志
export function recordConsole(tabId: number, entry: Omit<ConsoleEntry, "epoch">): void {
  const owner = session(tabId);
  owner.console.push({ ...entry, epoch: owner.epoch });
  if (owner.console.length > CONSOLE_LIMIT) owner.console.splice(0, owner.console.length - CONSOLE_LIMIT);
}
// 日志列表
export const consoleEntries = (tabId: number): ConsoleEntry[] => session(tabId).console;
// 记录弹窗
export function setDialog(tabId: number, dialog: Session["dialog"]): void {
  session(tabId).dialog = dialog;
}
// 待答弹窗
export const pendingDialog = (tabId: number): Session["dialog"] => session(tabId).dialog;
// 预设应答
export function armBeforeUnload(tabId: number, action: Session["beforeUnload"]): void {
  const entry = session(tabId);
  entry.beforeUnload = action;
  entry.beforeUnloadHandled = null;
}
// 取出预设
export function consumeBeforeUnload(tabId: number): Session["beforeUnload"] {
  const entry = session(tabId);
  const action = entry.beforeUnload;
  entry.beforeUnload = null;
  return action;
}
// 记录已答
export function noteBeforeUnloadHandled(tabId: number, action: "accept" | "dismiss"): void {
  session(tabId).beforeUnloadHandled = action;
}
const navigationCancels = new Map<number, () => void>();
// 等待取消
export const waitCancel = (tabId: number): Promise<void> => new Promise((resolve) => navigationCancels.set(tabId, resolve));
// 结束等待
export function cancelLoad(tabId: number): void {
  const resolve = navigationCancels.get(tabId);
  navigationCancels.delete(tabId);
  if (resolve) resolve();
}
// 应答结果
export function beforeUnloadOutcome(tabId: number): "accept" | "dismiss" | null {
  const entry = session(tabId);
  const handled = entry.beforeUnloadHandled;
  entry.beforeUnloadHandled = null;
  entry.beforeUnload = null;
  return handled;
}
// 登记世界
export function recordContext(tabId: number, info: ContextInfo): void {
  session(tabId).contexts.set(info.contextId, info);
}
// 删除世界
export function dropContext(tabId: number, contextId: number): void {
  session(tabId).contexts.delete(contextId);
}
// 清空世界
export function clearContexts(tabId: number): void {
  const entry = session(tabId);
  entry.contexts.clear();
  entry.scripts = [];
}
// 世界列表
export const contextsOf = (tabId: number): ContextInfo[] => [...session(tabId).contexts.values()];
// 世界名称
export function contextLabel(tabId: number, contextId: number): string | undefined {
  const info = session(tabId).contexts.get(contextId);
  if (!info) return undefined;
  return info.isDefault ? "main" : info.name || info.origin;
}
// 匹配世界
export function resolveContext(tabId: number, needle: string): ContextInfo {
  const entry = session(tabId);
  const wanted = needle.trim().toLowerCase();
  if (wanted === "main" || wanted === "default") {
    const main = [...entry.contexts.values()].find((info) => info.isDefault);
    if (main) return main;
  }
  if (/^\d+$/.test(wanted)) {
    const exact = entry.contexts.get(Number(wanted));
    if (exact) return exact;
  }
  const matches = [...entry.contexts.values()].filter(
    (info) => wanted === info.name.toLowerCase() || info.origin.toLowerCase().includes(wanted) || info.name.toLowerCase().includes(wanted),
  );
  if (matches.length === 1) return matches[0];
  const catalog = [...entry.contexts.values()]
    .map((info) => `${info.contextId} ${info.isDefault ? "main" : "isolated"} ${info.name || "(未命名)"} ${info.origin}`)
    .join("\n");
  throw new HostError(
    "no_context", `${JSON.stringify(needle)} ${matches.length ? `匹配到 ${ matches.length } 个执行上下文` : "无匹配的执行上下文"}；先执行 list_worlds 选择一个：\n${catalog || "（尚未采集到上下文，页面可能刚被接管）"}`, true,
  );
}
// 登记脚本
export function recordScript(tabId: number, record: ScriptRecord): void {
  const entry = session(tabId);
  const existing = entry.scripts.find((item) => item.scriptId === record.scriptId);
  if (existing) {
    Object.assign(existing, record);
    return;
  }
  entry.scripts.push(record);
  if (entry.scripts.length > SCRIPT_LIMIT) entry.scripts.splice(0, entry.scripts.length - SCRIPT_LIMIT);
}
// 脚本索引
export function scriptsOf(tabId: number): { scripts: ScriptRecord[]; topFrameId: string } {
  const entry = session(tabId);
  return { scripts: entry.scripts, topFrameId: entry.topFrameId };
}
// 置调试开
export function markDebugger(tabId: number, enabled: boolean): void {
  session(tabId).debuggerOn = enabled;
}
// 查询调试
export const debuggerOn = (tabId: number): boolean => session(tabId).debuggerOn === true;
// 记录主帧
export function setTopFrame(tabId: number, frameId: string): void {
  if (frameId) session(tabId).topFrameId = frameId;
}
// 查询脚本
export const scriptOf = (tabId: number, scriptId: string): ScriptRecord | null => session(tabId).scripts.find((item) => item.scriptId === scriptId) ?? null;
const workers = new Map<string, WorkerSession>();
// 后台列表
export const workerSessions = (): WorkerSession[] => [...workers.values()];
// 登记后台
export function openWorker(targetId: string, url: string, type: string): WorkerSession {
  const session = workers.get(targetId) ?? { targetId, url, type, attachedAt: Date.now(), console: [] };
  session.attachedAt = Date.now();
  session.url = url || session.url;
  session.type = type || session.type;
  workers.set(targetId, session);
  return session;
}
// 移除后台
export function dropWorker(targetId: string): WorkerSession | null {
  const session = workers.get(targetId) ?? null;
  workers.delete(targetId);
  return session;
}
// 缓存日志
export function noteWorkerLog(targetId: string, entry: Omit<ConsoleEntry, "epoch">): void {
  const session = workers.get(targetId);
  if (!session) return;
  session.console.push({ ...entry, epoch: 0 });
  if (session.console.length > CONSOLE_LIMIT) session.console.splice(0, session.console.length - CONSOLE_LIMIT);
}
// 删除后台
export function forgetWorker(targetId: string): void {
  workers.delete(targetId);
}
const TRACE_EVENT_LIMIT = 20_000;
// 查询录制
export const traceState = (tabId: number): TraceState => session(tabId).trace;
// 开始录制
export function traceStart(tabId: number, ttlMs: number): TraceState {
  const entry = session(tabId);
  entry.trace = { on: true, events: [], deadline: Date.now() + ttlMs, complete: false };
  return entry.trace;
}
// 追加事件
export function tracePush(tabId: number, events: Record<string, any>[]): void {
  const entry = session(tabId);
  entry.trace.events.push(...events);
  if (entry.trace.events.length > TRACE_EVENT_LIMIT) entry.trace.events.splice(0, entry.trace.events.length - TRACE_EVENT_LIMIT);
}
// 清空录制
export function traceReset(tabId: number): void {
  session(tabId).trace = { on: false, events: [], deadline: 0, complete: false };
}
// 结束录制
export function traceFinish(tabId: number): TraceState {
  const entry = session(tabId);
  entry.trace.on = false;
  entry.trace.complete = true;
  return entry.trace;
}
export const INTERCEPT_TTL_MS = 120_000;
const INTERCEPT_LOG_LIMIT = 200;
// 规则列表
export const interceptRules = (tabId: number): InterceptRule[] => session(tabId).rules;
// 替换规则
export function setRules(tabId: number, rules: InterceptRule[]): void {
  session(tabId).rules = rules;
}
// 拦截状态
export function interceptState(tabId: number): { on: boolean; deadline: number; hits: InterceptHit[] } {
  const entry = session(tabId);
  return { on: entry.interceptOn, deadline: entry.interceptDeadline, hits: entry.interceptHits };
}
// 开启拦截
export function markIntercepting(tabId: number, on: boolean): void {
  const entry = session(tabId);
  entry.interceptOn = on;
  if (!on) {
    entry.interceptDeadline = 0;
    if (entry.interceptTimer) clearTimeout(entry.interceptTimer);
    entry.interceptTimer = null;
  }
}
// 定时停用
export function armExpiry(tabId: number, ttlMs: number, fire: () => void): void {
  const entry = session(tabId);
  if (entry.interceptTimer) clearTimeout(entry.interceptTimer);
  entry.interceptDeadline = Date.now() + ttlMs;
  entry.interceptTimer = setTimeout(() => {
    entry.interceptTimer = null;
    fire();
  }, ttlMs);
}
// 记录命中
export function noteHit(tabId: number, hit: InterceptHit): void {
  const entry = session(tabId);
  entry.interceptHits.push(hit);
  if (entry.interceptHits.length > INTERCEPT_LOG_LIMIT) entry.interceptHits.splice(0, entry.interceptHits.length - INTERCEPT_LOG_LIMIT);
}
// 监听事件
export const listenerNames = (tabId: number): string[] => session(tabId).listenerNames;
// 设置监听
export function setListenerNames(tabId: number, names: string[]): void {
  session(tabId).listenerNames = names;
}
// 中断状态
export const pausedState = (tabId: number): PauseState | null => session(tabId).paused;
// 记录中断
export function setPaused(tabId: number, state: PauseState | null): void {
  session(tabId).paused = state;
}
// 登记断点
export function recordBreakpoint(tabId: number, record: BreakpointRecord): void {
  session(tabId).breakpoints.set(record.breakpointId, record);
}
// 删除断点
export function dropBreakpoint(tabId: number, breakpointId: string): BreakpointRecord | null {
  const record = session(tabId).breakpoints.get(breakpointId) ?? null;
  session(tabId).breakpoints.delete(breakpointId);
  return record;
}
// 断点列表
export const breakpointsOf = (tabId: number): BreakpointRecord[] => [...session(tabId).breakpoints.values()];
// 定时放行
export function armPause(tabId: number, fire: () => void): void {
  const entry = session(tabId);
  if (entry.pauseTimer) clearTimeout(entry.pauseTimer);
  entry.pauseTimer = setTimeout(() => {
    entry.pauseTimer = null;
    fire();
  }, 30_000);
}
// 撤销定时
export function stopPause(tabId: number): void {
  const entry = session(tabId);
  if (entry.pauseTimer) clearTimeout(entry.pauseTimer);
  entry.pauseTimer = null;
}
// 监听关页
export function watchTabs(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    cancelLoad(tabId);
    const driven = sessions.delete(tabId) || selectedPageId === tabId;
    if (selectedPageId === tabId) selectedPageId = null;
    if (driven) emit("page_closed", { pageId: tabId });
  });
}
