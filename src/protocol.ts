export const PROTOCOL_VERSION = 3;
export const DEFAULT_PORT = 8712;
export const EXTENSION_ID = "fafdnkbknmlcdefmfhjgdgjloekimcle";
export type Role = "extension";
export type ErrorCode =
  | "extension_offline"
  | "bad_request"
  | "no_page"
  | "page_gone"
  | "stale_snapshot"
  | "uid_not_found"
  | "not_found"
  | "no_context"
  | "not_attached"
  | "attach_blocked"
  | "cdp_failed"
  | "timeout"
  | "paused"
  | "no_dialog"
  | "window_minimized"
  | "file_not_found"
  | "unsupported";
export type ErrorBody = { code: ErrorCode | string; message: string; retryable?: boolean };
// 带码异常
export class HostError extends Error {
  code: string;
  retryable: boolean;
  // 构造异常
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
// 解析编号
export function parseUid(uid: unknown): { snapshotSeq: number; index: number } | null {
  const parts = /^(\d+)_(\d+)$/.exec(String(uid ?? ""));
  const snapshotSeq = parts?.[1];
  const index = parts?.[2];
  if (snapshotSeq === undefined || index === undefined) return null;
  return { snapshotSeq: Number(snapshotSeq), index: Number(index) };
}
export type Method =
  | "status"
  | "set_bridge_port"
  | "save_page"
  | "list_pages"
  | "select_page"
  | "navigate_page"
  | "take_snapshot"
  | "take_screenshot"
  | "click"
  | "hover"
  | "drag"
  | "fill"
  | "press_key"
  | "wait_for"
  | "handle_dialog"
  | "upload_file"
  | "evaluate_script"
  | "inspect_element"
  | "list_storage"
  | "intercept_requests"
  | "handle_worker"
  | "trace_page"
  | "handle_downloads"
  | "list_worlds"
  | "list_scripts"
  | "read_script"
  | "handle_breakpoints"
  | "handle_pause"
  | "manage_extensions"
  | "list_network_requests"
  | "list_console_messages"
  | "detach";
export type Params = Record<string, unknown>;
export type Frame =
  | { t: "hello"; role: Role; protocol: number; version?: string; browser?: string }
  | { t: "req"; id: string; method: Method | string; params?: Params; timeoutMs?: number }
  | { t: "res"; id: string; ok: boolean; result?: unknown; error?: ErrorBody }
  | { t: "evt"; name: string; payload?: unknown }
  | { t: "ping"; at: number }
  | { t: "pong"; at: number };
export type PageInfo = { pageId: number; url: string; title: string; active: boolean; attached: boolean; selected: boolean };
export type StatusResult = { protocol: number; extensionVersion: string; browser: string; selectedPageId: number | null; attachedTabs: number[]; pages: PageInfo[] };
export function num(params: Params, key: string): number;
export function num(params: Params, key: string, fallback: number | null): number | null;
// 读取数值
export function num(params: Params, key: string, fallback: number | null = null): number | null {
  const value = params[key];
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new HostError("bad_request", `参数 ${key} 不是数字`);
  return parsed;
}
export function str(params: Params, key: string): string;
export function str(params: Params, key: string, fallback: string | null): string | null;
// 读取文本
export function str(params: Params, key: string, fallback: string | null = null): string | null {
  const value = params[key];
  if (value === undefined || value === null) return fallback;
  return String(value);
}
// 读取枚举
export function choice(params: Params, key: string, allowed: readonly string[], fallback: string): string {
  const value = params[key];
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value);
  if (!allowed.includes(raw)) {
    throw new HostError("bad_request", `参数 ${key} 只能是 ${allowed.join(" / ")}，实际为 ${JSON.stringify(raw)}`);
  }
  return raw;
}
// 读取布尔
export function bool(params: Params, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}
