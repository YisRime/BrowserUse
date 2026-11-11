import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { check, finish, group, installGuards, startMcp } from "./harness.mjs";

const PORT = Number(process.env.BROWSERUSE_TEST_PORT || 20_000 + Math.floor(Math.random() * 20_000));
const SOURCE = readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8");
const EXTENSION_ID = /EXTENSION_ID = "([^"]+)"/.exec(SOURCE)?.[1] ?? "";
const PROTOCOL_VERSION = Number(/PROTOCOL_VERSION = (\d+)/.exec(SOURCE)?.[1]);
const DEFAULT_PORT = Number(/DEFAULT_PORT = (\d+)/.exec(SOURCE)?.[1]);

installGuards(120_000);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const layout = {
  width: 1280,
  height: 720,
  dpr: 1.5,
  screenshotWidth: 1920,
  screenshotHeight: 1080,
  pxScale: 1.5,
  scrollX: 0,
  scrollY: 120,
  documentWidth: 1280,
  documentHeight: 4000,
};
const page = (over = {}) => ({ pageId: 42, url: "https://example.com/", title: "Example Domain", active: true, attached: true, selected: true, ...over });
const snapshot = (seq) => ({
  pageId: 42,
  url: "https://example.com/",
  title: "Example Domain",
  snapshotSeq: seq,
  tree: `[${seq}_0] RootWebArea "Example Domain"\n  [${seq}_1] textbox "用户名" focusable editable\n  [${seq}_2] button "提交" focusable`,
  nodes: 3,
  interactive: 3,
  truncated: false,
  focus: "body",
  readyState: "complete",
  layout,
});

const seen = [];
const activity = { active: 0, maxConcurrent: 0 };
const canned = {
  status: () => ({ protocol: PROTOCOL_VERSION, extensionVersion: "0.3.0-test", browser: "edge", selectedPageId: 42, attachedTabs: [42], pages: [page()] }),
  list_pages: () => ({ browser: "edge", pages: [page(), page({ pageId: 43, title: "第二个标签页", selected: false, active: false, attached: false })] }),
  select_page: (params) => ({ ...page({ pageId: params.pageId }), attached: true }),
  navigate_page: (params) => ({ pageId: 42, from: "https://example.com/", to: params.url ?? "https://example.com/", title: "Example Domain", snapshot: null }),
  take_snapshot: () => snapshot(7),
  take_screenshot: () => ({ pageId: 42, format: "png", base64: PNG, bytes: 70, clip: null, layout }),
  click: (params) => ({ pageId: 42, uid: params.uid, at: { x: 480, y: 320 }, snapshot: params.includeSnapshot ? snapshot(8) : null }),
  hover: (params) => ({ pageId: 42, uid: params.uid, at: { x: 10, y: 20 }, snapshot: null }),
  drag: (params) => ({ pageId: 42, from: params.from_uid, to: params.to_uid, snapshot: null }),
  fill: (params) => ({ pageId: 42, uid: params.uid, valueLength: String(params.value ?? "").length, snapshot: null }),
  press_key: (params) => ({ pageId: 42, key: params.key, snapshot: null }),
  wait_for: () => ({ pageId: 42, waitedFor: ["已登录"], found: true, elapsedMs: 420 }),
  handle_dialog: () => ({ pageId: 42, accepted: true, wasType: "alert", message: "确认？" }),
  upload_file: (params) => ({ pageId: 42, uid: params.uid, filePath: params.filePath, snapshot: null }),
  evaluate_script: () => ({ pageId: 42, value: 42, unserializable: null, world: "main", contextId: null, snapshot: null }),
  inspect_element: () => ({
    pageId: 42,
    matched: 1,
    truncated: false,
    elements: [
      {
        tag: "button",
        id: "go",
        classes: ["primary"],
        attrs: [{ name: "data-role", value: "submit" }],
        text: "提交",
        rect: { x: 10, y: 20, width: 80, height: 30 },
        path: "body > button#go",
        inViewport: true,
        rendered: true,
        overlapped: false,
        styles: { display: "block", color: "rgb(0, 0, 0)" },
        listeners: [{ type: "click", at: "77:12", handler: "function onTargetClick(event)" }],
        outerHtml: '<button id="go" class="primary">提交</button>',
        htmlChars: 38,
      },
    ],
  }),
  list_worlds: () => ({
    pageId: 42,
    contexts: [
      { contextId: 3, name: "", origin: "https://example.com", isDefault: true, type: "default", frameId: "F1", extensionId: null, owner: null },
      {
        contextId: 5,
        name: "content.js",
        origin: "chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo",
        isDefault: false,
        type: "isolated",
        frameId: "F1",
        extensionId: "dhdgffkkebhmkfjojejmpbldmpobfkfo",
        owner: "Tampermonkey",
      },
    ],
  }),
  list_scripts: () => ({
    pageId: 42,
    total: 2,
    shown: 2,
    scripts: [
      { scriptId: "7", url: "https://example.com/app.js", lines: 240, topFrame: true },
      { scriptId: "9", url: "chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/content.js", lines: 12, topFrame: true },
    ],
  }),
  read_script: () => ({
    pageId: 42,
    scriptId: "7",
    url: "https://example.com/app.js",
    lines: 2,
    fromLine: 1,
    toLine: 2,
    truncated: false,
    source: "console.log(1);\nvar a = 2;",
  }),
  manage_extensions: (params) =>
    params.action === "list"
      ? {
          action: "list",
          total: 2,
          extensions: [
            { id: EXTENSION_ID, name: "BrowserUse", version: "1.0.0", enabled: true, type: "extension", self: true },
            { id: "dhdgffkkebhmkfjojejmpbldmpobfkfo", name: "Tampermonkey", version: "5.3.2", enabled: true, type: "extension", self: false },
          ],
        }
      : { action: params.action, id: params.id, name: "Tampermonkey", version: "5.3.2", enabled: params.action === "enable", url: "chrome-extension://dhdgffkk/options.html" },
  handle_breakpoints: (params) =>
    params.action === "list"
      ? {
          pageId: 42,
          action: "list",
          paused: false,
          breakpoints: [{ breakpointId: "1:24:0:https://example.com/app.js", url: "https://example.com/app.js", lineNumber: 24, columnNumber: 0, enabled: true }],
        }
      : { pageId: 42, action: params.action, breakpointId: "1:24:0:https://example.com/app.js", locations: [{ scriptId: "7", line: 24, column: 0 }], line: params.line, removed: params.breakpointId, left: 0, kept: 1, active: params.action === "activate" },
  handle_pause: (params) => (params.action && params.action !== "state" ? { pageId: 42, action: params.action, exceptionState: params.exceptionState, paused: false, at: null, heldForMs: null } : {
    pageId: 42,
    action: "state",
    paused: true,
    url: "https://example.com/",
    reason: "DOM breakpoint",
    hitBreakpoints: ["1:24:0:https://example.com/app.js"],
    heldForMs: 420,
    frameIds: ["frame-0"],
    frames: [{ index: 0, function: "computeTotal", url: "https://example.com/app.js", line: 25, column: 0, scopes: ["local", "closure:computeTotal"] }],
    variables: { "local:": { total: "45", items: "Array(3)" } },
    value: 45,
    unserializable: null,
  }),
  intercept_requests: (params) =>
    params.action === "list"
      ? {
          pageId: 42,
          action: "list",
          on: true,
          leftMs: 110_000,
          rules: [{ match: "/api/data", action: "mock", status: 200 }],
          hits: [{ url: "https://example.com/api/data", method: "GET", type: "xhr", action: "mock", at: 1_000 }],
          hitTotal: 1,
        }
      : { pageId: 42, action: params.action, match: params.match, ruleAction: params.ruleAction, on: true, rules: 1, leftMs: 110_000, removed: 1, kept: 1 },
  list_storage: () => ({
    pageId: 42,
    scope: "all",
    origin: "https://example.com",
    cookies: [{ name: "session", value: "abc", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" }],
    local: { length: 2, items: { who: "夹具用户" } },
    session: { length: 0, items: {} },
    databases: [{ name: "cache", version: 3 }],
  }),
  handle_worker: (params) =>
    params.action === "list"
      ? {
          action: "list",
          targets: [{ targetId: "ab12cd34", url: "https://example.com/sw.js", type: "service_worker", title: "", attached: true, consoleEntries: 2 }],
          note: "仅列出 chrome.debugger 可见的目标",
        }
      : params.action === "console"
        ? { action: "console", targetId: params.targetId, total: 1, pageIdx: 0, page: [{ type: "log", text: "站点 SW 已激活", timestamp: 1_000 }] }
        : params.action === "evaluate"
          ? { action: "evaluate", targetId: params.targetId, value: "sw", unserializable: null }
          : { action: params.action, targetId: params.targetId, url: "https://example.com/sw.js" },
  trace_page: (params) =>
    params.action === "status"
      ? { pageId: 42, action: "status", recording: false, events: 0, leftMs: 0 }
      : {
          pageId: 42,
          action: params.action,
          durationMs: 1_500,
          events: 4_200,
          spanMs: 1_480,
          frames: 42,
          hotspots: [{ name: "FunctionCall", count: 12, ms: 310, detail: "https://example.com/app.js" }],
        },
  handle_downloads: (params) =>
    params.action === "list"
      ? { action: "list", downloads: [{ id: 7, filename: "C:/tmp/report.csv", url: "https://example.com/report.csv", state: "complete", totalBytes: 2048, bytesReceived: 2048, danger: "fileSuccess" }] }
      : params.action === "cancel"
        ? { action: "cancel", id: params.id }
        : { action: "wait", waitedMs: 900, download: { id: 7, filename: "C:/tmp/report.csv", state: "complete", totalBytes: 2048, bytesReceived: 2048 } },
  save_page: () => ({ pageId: 42, url: "https://example.com/", title: "Example Domain", bytes: 1_800, mhtml: "MIME-Version: 1.0\r\nSubject: x\r\n\r\n<html></html>" }),
  set_bridge_port: (params) => (params.port ? { previous: 8712, port: params.port, connected: true, endpoint: "ws://127.0.0.1:8712/" } : { port: 8712, defaultPort: 8712, connected: true, endpoint: "ws://127.0.0.1:8712/" }),
  create_page: (params) => ({ mode: params.mode ?? "window", pageId: 88, windowId: 7, url: params.url ?? "about:blank", title: "", incognito: params.incognito === true, focused: params.focused === true, type: params.type ?? "popup" }),
  close_page: (params) => ({ closed: params.pageId ?? 42, url: "https://example.com/" }),
  status: () => ({ protocol: PROTOCOL_VERSION, extensionVersion: "0.3.0-test", browser: "edge", selectedPageId: 42, attachedTabs: [42], pages: [page()], debugLog: ["frame fill"], bootAt: "2026-01-01T00:00:00.000Z" }),
  detach: () => ({ detached: [42] }),
  list_network_requests: () => ({
    pageId: 42,
    total: 2,
    pageIdx: 0,
    page: [{ requestId: "1", method: "GET", status: 200, resourceType: "xhr", encodedDataLength: 1234, startedAt: 1_000, finishedAt: 1_340, url: "https://example.com/api" }],
  }),
  list_console_messages: () => ({ pageId: 42, total: 1, pageIdx: 0, page: [{ type: "log", text: "控制台标记 ALPHA", timestamp: 1_000, source: "https://example.com/a.js", line: 12, world: "content.js" }] }),
};
const failing = { hover: { code: "stale_snapshot", message: "uid 3_1 属于旧快照，重新 take_snapshot", retryable: true } };
const TOOLS = Object.keys(canned);

group("握手与工具表");
const owner = startMcp("owner", PORT);
const init = await owner.hello();
check("python stdio 即可完成 MCP 握手", init.result?.serverInfo?.name === "browser-use", init.result?.serverInfo ?? init);

const listed = await owner.request("tools/list", {});
const names = (listed.result?.tools ?? []).map((tool) => tool.name);
const COPIED = [
  "list_pages",
  "select_page",
  "navigate_page",
  "take_snapshot",
  "take_screenshot",
  "wait_for",
  "handle_dialog",
  "upload_file",
  "evaluate_script",
];
check(
  "内置那 9 个工具名逐个照抄",
  COPIED.every((name) => names.includes(name)),
  COPIED.filter((name) => !names.includes(name)),
);
const METHODS = [...(/export type Method =([\s\S]*?);/.exec(SOURCE)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
const SURFACE_ONLY = ["interact", "scripts", "logs", "debugger"];
const HIDDEN = ["click", "hover", "drag", "fill", "press_key", "list_scripts", "read_script", "handle_breakpoints", "handle_pause", "list_network_requests", "list_console_messages"];
check(
  "MCP 工具面为方法表的收敛视图（合并 4 个、隐藏 11 个内部方法）",
  SURFACE_ONLY.every((name) => names.includes(name)) && HIDDEN.every((name) => !names.includes(name)) && names.every((name) => SURFACE_ONLY.includes(name) || METHODS.includes(name)),
  { missing: SURFACE_ONLY.filter((n) => !names.includes(n)), leaked: HIDDEN.filter((n) => names.includes(n)), unknown: names.filter((n) => !SURFACE_ONLY.includes(n) && !METHODS.includes(n)) },
);

const cold = await owner.call("list_pages", {});
check("扩展未接入时返回 extension_offline", cold.isError && cold.text.includes("extension_offline"), cold.text);

group("常量核对");
const probe = "import browseruse,json;print(json.dumps([browseruse.PROTOCOL_VERSION,browseruse.DEFAULT_PORT,browseruse.EXTENSION_ID,len(browseruse.TOOLS)]))";
const probed = await new Promise((resolve) => {
  const child = spawn("python", ["-B", "-c", probe]);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.on("close", () => resolve({ out: out.trim(), err: err.trim() }));
});
if (!probed.out) {
  check("Python 常量探针可执行", false, probed.err || "探针 stdout 为空");
  process.exit(1);
}
const [pyVersion, pyPort, pyId, pyTools] = JSON.parse(probed.out);
check(
  "Python 与 src/protocol.ts 的常量一致",
  pyVersion === PROTOCOL_VERSION && pyPort === DEFAULT_PORT && pyId === EXTENSION_ID && pyTools === 27,
  { py: [pyVersion, pyPort, pyId, pyTools], ts: [PROTOCOL_VERSION, DEFAULT_PORT, EXTENSION_ID, TOOLS.length] },
);

group("假扩展接入");
const extension = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: `chrome-extension://${EXTENSION_ID}` } });
extension.addEventListener("message", (event) => {
  const frame = JSON.parse(String(event.data));
  if (frame.t === "ping") {
    extension.send(JSON.stringify({ t: "pong", at: frame.at }));
    return;
  }
  if (frame.t !== "req") return;
  activity.active += 1;
  activity.maxConcurrent = Math.max(activity.maxConcurrent, activity.active);
  seen.push({ method: frame.method, params: frame.params });
  setTimeout(() => {
    activity.active -= 1;
    const handler = canned[frame.method];
    const error = failing[frame.method] ?? (handler ? undefined : { code: "unsupported", message: `假扩展不实现 ${frame.method}` });
    const body = error ? { ok: false, error } : { ok: true, result: handler(frame.params ?? {}) };
    extension.send(JSON.stringify({ t: "res", id: frame.id, ...body }));
  }, 40);
});
await new Promise((resolve, reject) => {
  extension.addEventListener(
    "open",
    () => {
      extension.send(JSON.stringify({ t: "hello", role: "extension", protocol: PROTOCOL_VERSION, version: "0.3.0-test", browser: "edge" }));
      setTimeout(resolve, 100);
    },
    { once: true },
  );
  extension.addEventListener("error", () => reject(new Error("假扩展未连上本地集线器")), { once: true });
});

const pages = await owner.call("list_pages", {});
check("list_pages 带 pageId 与作用域标记", pages.text.includes("[42]") && pages.text.includes("当前作用域"), pages.text);

const shot = await owner.call("take_snapshot", {});
check("take_snapshot 行首输出 uid", shot.text.includes("[7_1] textbox") && shot.text.includes("快照 7"), shot.text);
check("快照头部带布局与文档状态", /布局: 1280x720 css px, dpr 1.5/.test(shot.text) && shot.text.includes("文档状态: complete"), shot.text.slice(0, 300));

group("参数透传与错误码");
const image = await owner.call("take_screenshot", { format: "png" });
check("take_screenshot 内联返回 image 块", image.image?.data === PNG && image.image?.mimeType === "image/png", image.text);

const clicked = await owner.call("interact", { action: "click", uid: "7_2", dblClick: true, includeSnapshot: true });
const clickParams = seen.find((entry) => entry.method === "click")?.params ?? {};
check("click 原样透传 uid/dblClick/includeSnapshot", clickParams.uid === "7_2" && clickParams.dblClick === true && clickParams.includeSnapshot === true, clickParams);
check("includeSnapshot 返回新快照", clicked.text.includes("\"uid\": \"7_2\"") && clicked.text.includes("[8_2] button"), clicked.text);

const scoped = await owner.call("take_screenshot", { format: "png", pageId: 43 });
const drag = await owner.call("interact", { action: "drag", uid: "7_1", to_uid: "7_2", duration: 800 });
const shotParams = seen.find((entry) => entry.method === "take_screenshot" && entry.params?.pageId === 43)?.params ?? {};
const dragParams = seen.find((entry) => entry.method === "drag")?.params ?? {};
check(
  "pageId 与 duration 不被 MCP 层拦截",
  shotParams.pageId === 43 && dragParams.duration === 800 && !scoped.isError && !drag.isError,
  { scoped: scoped.text.slice(0, 120), drag: drag.text.slice(0, 120) },
);

const rightClick = await owner.call("interact", { action: "click", uid: "7_2", button: "right" });
const rightParams = seen.filter((entry) => entry.method === "click").slice(-1)[0]?.params ?? {};
check("button 透传右键点击", !rightClick.isError && rightParams.button === "right", { rightClick: rightClick.text.slice(0, 120), rightParams });

const evaluated = await owner.call("evaluate_script", { function: "() => window.__probe" });
check("evaluate_script 回传返回值", evaluated.text.includes("返回值: 42"), evaluated.text);

const crossWorld = await owner.call("evaluate_script", { function: "() => window.__userscript_secret", context: "dhdgffkkebhmkf" });
const crossParams = seen.filter((entry) => entry.method === "evaluate_script").slice(-1)[0]?.params ?? {};
check("context 透传至扩展做跨 world 求值", crossParams.context === "dhdgffkkebhmkf" && !crossWorld.isError, { text: crossWorld.text.slice(0, 120), crossParams });

const inspected = await owner.call("inspect_element", { uid: "7_2" });
check(
  "inspect 排版出属性、样式与事件出处",
  inspected.text.includes("data-role='submit'") && inspected.text.includes("display=block") && inspected.text.includes("监听 click @ 77:12"),
  inspected.text,
);

const contextList = await owner.call("list_worlds", {});
check(
  "worlds 返回其它扩展的 world 及归属",
  contextList.text.includes("[5] isolated content.js chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo（Tampermonkey）") && contextList.text.includes("[3] main"),
  contextList.text,
);

const scriptList = await owner.call("scripts", { action: "list", filter: "app" });
check("scripts 返回脚本索引", scriptList.text.includes("[7] 240 行 主帧 https://example.com/app.js"), scriptList.text);
const source = await owner.call("scripts", { action: "read", scriptId: "7" });
check("script 返回源码正文", source.text.includes("var a = 2;") && source.text.includes("https://example.com/app.js"), source.text);

const extensionList = await owner.call("manage_extensions", { action: "list" });
check("extensions 列出扩展并标记自建", extensionList.text.includes("[自建]") && extensionList.text.includes("Tampermonkey"), extensionList.text);
const extensionToggle = await owner.call("manage_extensions", { action: "disable", extensionId: "dhdgffkkebhmkfjojejmpbldmpobfkfo" });
const toggleParams = seen.filter((entry) => entry.method === "manage_extensions").slice(-1)[0]?.params ?? {};
check("扩展开关动作原样下发并有回执", toggleParams.action === "disable" && extensionToggle.text.includes("停用"), { extensionToggle: extensionToggle.text, toggleParams });

const bpList = await owner.call("debugger", { action: "list" });
check(
  "breakpoints 列表与暂停态一起排版",
  bpList.text.includes("[1:24:0:https://example.com/app.js] app.js:25:0") && bpList.text.includes("页面在跑"),
  bpList.text,
);
const bpAdd = await owner.call("debugger", { action: "add", url: "https://example.com/app.js", line: 25, condition: "total > 40" });
const bpAddParams = seen.filter((entry) => entry.method === "handle_breakpoints").slice(-1)[0]?.params ?? {};
check("断点参数原样下发", bpAddParams.line === 25 && bpAddParams.condition === "total > 40" && bpAdd.text.includes("→ 7:25"), { bpAdd: bpAdd.text, bpAddParams });
const paused = await owner.call("debugger", { action: "state", function: "() => total" });
check(
  "handle_pause 返回栈、变量与该帧求值结果",
  paused.text.includes("停在 DOM breakpoint") && paused.text.includes("computeTotal @ app.js:25") && paused.text.includes("total=45") && paused.text.includes("该帧求值: 45"),
  paused.text,
);
const resumed = await owner.call("debugger", { action: "step_over" });
const exceptionHold = await owner.call("debugger", { action: "exceptions", exceptionState: "all" });
check("放行与异常暂停都有回执", resumed.text.includes("已 step_over") && exceptionHold.text.includes("设为 all"), { resumed: resumed.text, exceptionHold: exceptionHold.text });

const intercepted = await owner.call("intercept_requests", { action: "add", match: "/api/data", ruleAction: "mock", status: 200, body: "{\"ok\":false}" });
const interceptParams = seen.filter((entry) => entry.method === "intercept_requests").slice(-1)[0]?.params ?? {};
check(
  "拦截规则与 ttl 原样下发并回显剩余时间",
  interceptParams.match === "/api/data" && interceptParams.ruleAction === "mock" && intercepted.text.includes("mock") && intercepted.text.includes("110s"),
  { intercepted: intercepted.text, interceptParams },
);
const interceptList = await owner.call("intercept_requests", { action: "list" });
check("拦截列表返回规则与命中记录", interceptList.text.includes("/api/data → mock") && interceptList.text.includes("GET https://example.com/api/data"), interceptList.text);

const storage = await owner.call("list_storage", { scope: "all" });
check(
  "storage 一次返回 cookie/webStorage/IndexedDB",
  storage.text.includes("session=abc") && storage.text.includes("会话级") && storage.text.includes("who=夹具用户") && storage.text.includes("cache(v3)"),
  storage.text,
);

const workers = await owner.call("handle_worker", { action: "list" });
const workerConsole = await owner.call("handle_worker", { action: "console", targetId: "ab12cd34" });
const workerValue = await owner.call("handle_worker", { action: "evaluate", targetId: "ab12cd34", function: "() => self.serviceWorker && 1" });
check("worker 列目标并标记已挂", workers.text.includes("[ab12cd34] service_worker 已挂") && workers.text.includes("sw.js"), workers.text);
check("worker 的 console 与求值都可取回", workerConsole.text.includes("站点 SW 已激活") && workerValue.text.includes('worker 返回值: "sw"'), { workerConsole: workerConsole.text, workerValue: workerValue.text });

const traced = await owner.call("trace_page", { action: "run", durationMs: 1_500 });
check("trace 回摘要而不是事件流", traced.text.includes("绘制 42 帧") && traced.text.includes("FunctionCall: 310ms / 12 次") && !traced.text.includes("cat\":\"devtools"), traced.text);

const downloadWait = await owner.call("handle_downloads", { action: "wait", match: "report.csv" });
check("downloads wait 返回本机路径与字节数", downloadWait.text.includes("C:/tmp/report.csv") && downloadWait.text.includes("2048/2048B"), downloadWait.text);

const saved = await owner.call("save_page", {});
check("archive 返回 mhtml 体积", saved.text.includes("Example Domain") && saved.text.includes("1800 字节"), saved.text);

const configRead = await owner.call("set_bridge_port", {});
check("bridge 读出端口与接入状态", configRead.text.includes("端口 8712") && configRead.text.includes("已连上"), configRead.text);
const configWrite = await owner.call("set_bridge_port", { port: 9100 });
check("bridge 改端口带重启提示", configWrite.text.includes("9100") && configWrite.text.includes("--port 9100"), configWrite.text);

const missing = await owner.call("upload_file", { uid: "7_1", filePath: "C:/does/not/exist.bin" });
check("缺文件时返回 file_not_found 且不下发扩展", missing.isError && missing.text.includes("file_not_found") && !seen.some((entry) => entry.method === "upload_file"), missing.text);

const stale = await owner.call("interact", { action: "hover", uid: "3_1" });
check("扩展侧错误码原样到达 MCP", stale.isError && stale.text.includes("stale_snapshot"), stale.text);

const network = await owner.call("logs", { type: "network", resourceTypes: ["xhr"] });
check("网络摘要含方法/状态/类型/耗时", /GET 200 xhr 1234B 340ms/.test(network.text), network.text);

const consoleOut = await owner.call("logs", { type: "console", types: ["log"] });
check("控制台摘要含类型、world 与出处", consoleOut.text.includes("[log] content.js · 控制台标记 ALPHA · https://example.com/a.js:12"), consoleOut.text);

const unknown = await owner.request("tools/call", { name: "interact", arguments: { action: "click" } });
check("缺 uid 时 MCP 层拒绝执行", /uid/.test(JSON.stringify(unknown.error ?? unknown.result ?? "")), unknown.error ?? unknown.result);

group("第二个会话接入");
const joiner = startMcp("joiner", PORT);
await joiner.hello();
check(
  "第二个 MCP 进程自动接入已有集线器",
  joiner.logs.some((line) => line.includes("端口绑定失败")) && joiner.logs.some((line) => line.includes("降级为 agent")),
  joiner.logs,
);

activity.maxConcurrent = 0;
seen.length = 0;
const [a, b] = await Promise.all([owner.call("interact", { action: "fill", uid: "7_1", value: "甲的内容" }), joiner.call("interact", { action: "press_key", key: "Control+A" })]);
check("并发时扩展同一时刻只收到一条指令", activity.maxConcurrent === 1, activity);
check("两个会话各自取回结果", a.text.includes("\"uid\": \"7_1\"") && a.text.includes("\"valueLength\": 4") && b.text.includes("\"key\": \"Control+A\""), { a: a.text, b: b.text });
check("两条会话的请求均送达扩展", new Set(seen.map((entry) => entry.method)).size === 2, seen.map((entry) => entry.method));

group("Origin 校验");
// 网页等非扩展来源一律拒绝
const webOrigin = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: "https://evil.example" } });
const webRejected = await new Promise((resolve) => {
  webOrigin.addEventListener("error", () => resolve(true));
  webOrigin.addEventListener("open", () => resolve(false));
  setTimeout(() => resolve(null), 3_000);
});
check("网页等非扩展来源接入被拒", webRejected === true, { webRejected });
// 默认接受任意 chrome-extension:// 来源（未打包扩展的实际 ID 随浏览器可能偏离 manifest.key 推导值）
const impersonator = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: "chrome-extension://anotherextensionid" } });
const accepted = await new Promise((resolve) => {
  impersonator.addEventListener("open", () => resolve(true));
  impersonator.addEventListener("error", () => resolve(false));
  setTimeout(() => resolve(null), 3_000);
});
impersonator.close();
check("默认接受任意 chrome-extension:// 来源", accepted === true, { accepted });
// 指定 --extension-id 后，其它扩展 ID 冒充被拒
const pinnedPort = PORT + 977;
const pinned = spawn("python", ["browseruse.py", "--port", String(pinnedPort), "--extension-id", EXTENSION_ID, "--serve-only"], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 1_500));
const pinnedImpostor = new WebSocket(`ws://127.0.0.1:${pinnedPort}/`, { headers: { Origin: "chrome-extension://anotherextensionid" } });
const pinnedRejected = await new Promise((resolve) => {
  pinnedImpostor.addEventListener("error", () => resolve(true));
  pinnedImpostor.addEventListener("open", () => resolve(false));
  setTimeout(() => resolve(null), 3_000);
});
check("指定 --extension-id 时其它扩展 ID 冒充接入被拒", pinnedRejected === true, { pinnedRejected });
pinned.kill();

group("扩展事件");
extension.send(JSON.stringify({ t: "evt", name: "snapshot_invalidated", payload: { pageId: 42, reason: "tab_url_changed", retired: 3 } }));
await owner.call("list_pages", {});
const evtLine = owner.logs.find((line) => line.includes("扩展事件：snapshot_invalidated"));
check("扩展的 evt 帧进日志", Boolean(evtLine) && /tab_url_changed/.test(evtLine ?? ""), evtLine ?? owner.logs.slice(-3));

owner.child.kill();
joiner.child.kill();
extension.close();
finish();
