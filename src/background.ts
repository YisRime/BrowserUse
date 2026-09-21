import { attachedTabs, browserLabel, watchTabs, setConnection, setEmitter } from "./browser";
import { watchDebugger } from "./cdp";
import { watchTabUrls, methods } from "./page";
import { DEFAULT_PORT, HostError, PROTOCOL_VERSION } from "./protocol";
import type { Frame } from "./protocol";
let socket: WebSocket | null = null;
let connecting = false;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
setEmitter((name, payload) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "evt", name, payload } satisfies Frame));
});
// 拼出地址
async function endpoint(): Promise<string> {
  const stored = await chrome.storage.local.get("browseruse.port");
  const port = Number(stored["browseruse.port"]) || DEFAULT_PORT;
  return `ws://127.0.0.1:${port}/`;
}
// 更新角标
async function badge(text: string): Promise<void> {
  await chrome.action.setBadgeText({ text }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ color: "#1f6feb" }).catch(() => undefined);
}
// 退避重连
function scheduleRetry(): void {
  if (retryTimer) return;
  const delayMs = Math.min(2_000, 200 * 2 ** (attempts += 1));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delayMs);
}
// 建立连接
async function connect(): Promise<void> {
  if (connecting || socket) return;
  connecting = true;
  try {
    const url = await endpoint();
    setConnection({ connected: false, endpoint: url });
    const candidate = new WebSocket(url);
    candidate.onopen = () => {
      attempts = 0;
      socket = candidate;
      connecting = false;
      setConnection({ connected: true, endpoint: url });
      candidate.send(
        JSON.stringify({ t: "hello", role: "extension", protocol: PROTOCOL_VERSION, version: chrome.runtime.getManifest().version, browser: browserLabel()} satisfies Frame),
      );
      void badge("on");
    };
    candidate.onmessage = (event) => {
      void onFrame(candidate, String(event.data));
    };
    const dropped = () => {
      if (socket === candidate) {
        socket = null;
        void badge("");
      }
      connecting = false;
      setConnection({ connected: false, endpoint: candidate.url });
      scheduleRetry();
    };
    candidate.onclose = dropped;
    candidate.onerror = dropped;
  } catch {
    connecting = false;
    scheduleRetry();
  }
}
// 处理请求
async function onFrame(candidate: WebSocket, raw: string): Promise<void> {
  let frame: Frame;
  try {
    frame = JSON.parse(raw) as Frame;
  } catch {
    return;
  }
  if (frame.t === "ping") {
    candidate.send(JSON.stringify({ t: "pong", at: frame.at } satisfies Frame));
    return;
  }
  if (frame.t !== "req") return;
  let response: Frame;
  try {
    const handler = (methods as Record<string, (params: Record<string, unknown>) => Promise<unknown>>)[frame.method];
    if (!handler) throw new HostError("unsupported", `扩展不支持方法 ${frame.method}`);
    response = { t: "res", id: frame.id, ok: true, result: await handler(frame.params ?? {}) };
  } catch (error) {
    const failure = error instanceof HostError ? error : new HostError("cdp_failed", error instanceof Error ? error.message : String(error));
    response = { t: "res", id: frame.id, ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable } };
  }
  if (candidate.readyState === WebSocket.OPEN) candidate.send(JSON.stringify(response));
  await badge(attachedTabs().length ? "*" : "on");
}
export default function main(): void {
  watchTabs();
  watchDebugger();
  watchTabUrls();
  chrome.runtime.onStartup.addListener(() => {
    void connect();
  });
  chrome.runtime.onInstalled.addListener(() => {
    void connect();
  });
  chrome.alarms.create("browseruse-keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(() => {
    if (!socket) void connect();
  });
  void connect();
}
main();
