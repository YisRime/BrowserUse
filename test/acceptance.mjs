import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { abort, check, finish, group, installGuards, log, onCleanup, startMcp, track } from "./harness.mjs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BROWSER = existsSync(EDGE) ? EDGE : CHROME;
const ROOT = process.cwd();
const EXT_DIR = path.join(ROOT, ".output", "chrome-mv3");
const PROFILE = mkdtempSync(path.join(tmpdir(), "bu-acc-profile-"));
const EXTENSION_ID = /EXTENSION_ID = "([^"]+)"/.exec(readFileSync(path.join(ROOT, "src", "protocol.ts"), "utf8"))?.[1] ?? "";

const GUARD_DIR = mkdtempSync(path.join(tmpdir(), "bu-userscript-ext-"));
writeFileSync(
  path.join(GUARD_DIR, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "油猴替身",
    version: "0.1.0",
    options_page: "options.html",
    background: { service_worker: "bg.js", type: "module" },
    content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_idle" }],
  }),
);
writeFileSync(path.join(GUARD_DIR, "bg.js"), "console.log('替身后台已启动');\n");
writeFileSync(
  path.join(GUARD_DIR, "content.js"),
  "window.__userscript_secret = '替身私有值';\nconsole.log('替身脚本已注入');\nsetTimeout(function () { throw new Error('替身脚本报错样例'); }, 300);\n",
);
writeFileSync(path.join(GUARD_DIR, "options.html"), '<!doctype html><meta charset="utf-8"><title>替身设置页</title>\n<body><h1>替身设置</h1><label>开关<input id="sw" aria-label="启用替身"></label></body>\n');
onCleanup(() => rmSync(GUARD_DIR, { recursive: true, force: true }));

installGuards(300_000);

function portBusy(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ host: "127.0.0.1", port, timeout: 400 });
    const done = (busy) => {
      probe.destroy();
      resolve(busy);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => resolve(false));
    probe.once("timeout", () => done(false));
  });
}

function wipeProfile() {
  try {
    rmSync(PROFILE, { recursive: true, force: true });
    return !existsSync(PROFILE);
  } catch {
    return false;
  }
}
onCleanup(wipeProfile);

async function freePorts(base) {
  return !(await portBusy(base - 8_000)) && !(await portBusy(base - 9_000)) && !(await portBusy(base));
}

let base = Number(process.env.BROWSERUSE_TEST_PORT || 30_000 + 100 + Math.floor(Math.random() * 900));
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (await freePorts(base)) break;
  base += 977;
}
if (!(await freePorts(base))) abort("无空闲端口组；用 BROWSERUSE_TEST_PORT 指定基址");
const PORT = base;
const CDP_PORT = PORT - 8_000;
const FIXTURE_PORT = PORT - 9_000;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;
log(`端口 base=${PORT} fixture=${FIXTURE_PORT} cdp=${CDP_PORT}`);

async function until(limit, probe) {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const outcome = await probe();
    if (outcome) return outcome;
    await delay(600);
  }
  return null;
}

const PAGES = {
  "/login": `<!doctype html><meta charset="utf-8"><title>登录夹具</title>
<body><h1>登录</h1><label>用户名<input id="u" aria-label="用户名"></label>
<button id="go" onclick="doLogin()">提交</button>
<label>系列<select id="s" aria-label="系列"><option value="a">甲款</option><option value="b">乙款</option></select></label>
<div id="out"></div><pre id="pick"></pre>
<script>
function doLogin(){ document.cookie='session=abc123; path=/'; localStorage.setItem('who','夹具用户');
  document.getElementById('out').textContent='正在跳转…'; setTimeout(()=>location.pathname='/dashboard',150); }
document.getElementById('s').addEventListener('change', function(e){ document.getElementById('pick').textContent='已选 ' + e.target.value; });
</script></body>`,
  "/dashboard": `<!doctype html><meta charset="utf-8"><title>控制面板</title>
<body><h1>控制面板</h1><p id="who"></p><button id="signout">退出</button>
<script>document.getElementById('who').textContent = /session=abc123/.test(document.cookie) ? '已登录：夹具用户' : '未登录';</script></body>`,
  "/mainworld": `<!doctype html><meta charset="utf-8"><title>MAIN world 夹具</title>
<body><h1>主 world 探针</h1><div id="live"></div>
<script>window.__probe=42; window.__observed=[];
new MutationObserver(function(m){ window.__observed.push(m.length); }).observe(document.documentElement,{subtree:true,childList:true});
</script></body>`,
  "/net": `<!doctype html><meta charset="utf-8"><title>网络与日志夹具</title>
<body><h1>采集夹具</h1>
<script>console.log('控制台标记 ALPHA');
fetch('/api/data').then(r=>r.json()).then(function(j){ console.log('接口返回 ' + j.ok); document.title='接口已回'; });</script></body>`,
  "/spa": `<!doctype html><meta charset="utf-8"><title>SPA 夹具</title>
<body><h1>SPA 路由</h1><button id="route" onclick="history.pushState({}, '', '/settings')">换路由</button></body>`,
  "/upload": `<!doctype html><meta charset="utf-8"><title>上传夹具</title>
<body><h1>上传</h1><input id="f" type="file" aria-label="附件"><pre id="r"></pre>
<script>document.getElementById('f').addEventListener('change',function(e){ var f=e.target.files[0];
  document.getElementById('r').textContent = f ? (f.name + ':' + f.size) : '没有文件'; });</script></body>`,
  "/inspect": `<!doctype html><meta charset="utf-8"><title>元素检查夹具</title>
<body><h1>元素检查</h1>
<button id="target" class="primary big" data-role="submit">按我</button>
<input id="txt" aria-label="昵称" value="原有内容">
<div id="hidden" style="display:none">看不见</div>
<script>document.getElementById('target').addEventListener('click', function onTargetClick(event) { window.__clicked = (window.__clicked || 0) + 1; });</script></body>`,
  "/dirty": `<!doctype html><meta charset="utf-8"><title>未保存夹具</title>
<body><h1>未保存的改动</h1><textarea aria-label="正文" id="t">写了一半</textarea>
<script>window.onbeforeunload = function () { return '还有没保存的内容'; };</script></body>`,
  "/bp": `<!doctype html><meta charset="utf-8"><title>断点夹具</title>
<body><h1>断点夹具</h1><button id="run" aria-label="算一次">算</button><script src="/app.js"></script></body>`,
  "/vanish": `<!doctype html><meta charset="utf-8"><title>消失夹具</title>
<body><h1>会消失的节点</h1><div id="gone">还在</div>
<script>setTimeout(function () { document.getElementById('gone').remove(); window.__ready = true; }, 600);</script></body>`,
  "/intercept": `<!doctype html><meta charset="utf-8"><title>拦截夹具</title>
<body><h1>拦截夹具</h1><p id="r">等接口</p>
<script>fetch('/api/intercepted?t=' + Date.now()).then(function(r){ return r.json(); }).then(function(j) {
  console.log('拦截结果 ' + j.ok); document.getElementById('r').textContent = '拦截结果 ' + j.ok; });</script></body>`,
  "/download": `<!doctype html><meta charset="utf-8"><title>下载夹具</title>
<body><h1>下载</h1><a id="d" href="/blob.csv" download="blob.csv" aria-label="下载文件">下载</a></body>`,
  "/sw": `<!doctype html><meta charset="utf-8"><title>服务工作者夹具</title>
<body><h1>站点自己的 SW</h1><p id="r">注册中</p>
<script>navigator.serviceWorker.register('/sw.js').then(function(){ document.getElementById('r').textContent='SW 已注册'; },
  function(e){ document.getElementById('r').textContent='注册失败 ' + e.message; });</script></body>`,
};

const SW_JS = `self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('fetch', function (event) { if (String(event.request.url).indexOf('/api/data') >= 0) event.respondWith(new Response('{"ok":true,"from":"service worker"}')); });
console.log('站点 SW 已激活');`;

const APP_JS = `function computeTotal(items) {
  var total = 0;
  for (var i = 0; i < items.length; i++) { total += items[i]; }
  window.__total = String(total);
  window.__runs = (window.__runs || 0) + 1;
}
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('run').addEventListener('click', function () { computeTotal([2, 3, 40]); });
});
`;

const server = createServer((request, response) => {
  const page = PAGES[request.url ?? ""];
  if (page) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  if (request.url === "/blob.csv") {
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"blob.csv\"",
    });
    response.end("a,b\n1,2\n3,4\n5,6\n7,8\n9,10\n");
    return;
  }
  if (String(request.url).indexOf("/api/intercepted") === 0) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, real: true }));
    return;
  }
  if (request.url === "/app.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(APP_JS);
    return;
  }
  if (request.url === "/sw.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(SW_JS);
    return;
  }
  if (request.url === "/api/data") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
    return;
  }
  response.writeHead(404).end("no fixture");
});
await new Promise((resolve) => server.listen(FIXTURE_PORT, "127.0.0.1", resolve));

group("构建产物与固定 ID");
const manifest = existsSync(path.join(EXT_DIR, "manifest.json")) ? JSON.parse(readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8")) : null;
check("build 产出可加载的 chrome-mv3", Boolean(manifest?.background?.service_worker), manifest);
check("manifest 固定 key 使 ID 恒定", typeof manifest?.key === "string" && manifest.key.length > 100, { keyLength: manifest?.key?.length });
check("同时产出 edge-mv3", existsSync(path.join(ROOT, ".output", "edge-mv3", "manifest.json")), ".output/edge-mv3");

group("无宿主进程");
const owner = startMcp("owner", PORT);
const init = await owner.hello();
check("python stdio 即可完成 MCP 握手", Boolean(init.result?.serverInfo), init.result?.serverInfo ?? init);
const toolList = await owner.request("tools/list", {});
check("tools/list 返回 27 个工具", (toolList.result?.tools ?? []).length === 27, (toolList.result?.tools ?? []).map((tool) => tool.name));

const browserProcess = track(
  spawn(
    BROWSER,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${EXT_DIR},${GUARD_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      `${FIXTURE}/login`,
    ],
    { stdio: "ignore", detached: true },
  ),
);
browserProcess.unref();

let cdpId = 1;
let browser = null;
function cdp(method, params, sessionId) {
  const id = cdpId++;
  browser.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.removeEventListener("message", onMessage);
      reject(new Error(`${method} 超时`));
    }, 20_000);
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      browser.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    browser.addEventListener("message", onMessage);
  });
}

const targetInfos = async () => (await cdp("Target.getTargets", {})).targetInfos ?? [];
const pageTarget = async () => (await targetInfos()).find((item) => item.type === "page" && String(item.url ?? "").includes(`:${FIXTURE_PORT}/`));
let LOADED_ID = EXTENSION_ID;
const workerTarget = async () => (await targetInfos()).find((item) => item.url === `chrome-extension://${LOADED_ID}/background.js`) ?? null;

// 浏览器自带组件也可能叫 background.js，读 manifest 名字识别本扩展
async function identifyWorker(candidateId) {
  let sessionId = "";
  try {
    const target = (await targetInfos()).find((item) => item.url === `chrome-extension://${candidateId}/background.js`);
    if (!target) return null;
    sessionId = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    await cdp("Runtime.enable", {}, sessionId);
    const result = await cdp("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", awaitPromise: false }, sessionId);
    return result?.result?.value ?? null;
  } catch {
    return null;
  } finally {
    if (sessionId) await cdp("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

let worker = null;
for (let attempt = 0; attempt < 60 && !worker; attempt += 1) {
  await delay(750);
  try {
    const version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((response) => response.json());
    if (!browser) {
      browser = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        browser.addEventListener("open", resolve, { once: true });
        browser.addEventListener("error", reject, { once: true });
      });
    }
    const infos = await targetInfos();
    const candidates = infos.filter((item) => /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(item.url ?? ""));
    const ours = infos.some((item) => String(item.url ?? "").includes(`:${FIXTURE_PORT}/`));
    if (!ours) continue;
    for (const candidate of candidates) {
      const name = await identifyWorker(new URL(candidate.url).host);
      if (name === "BrowserUse") { worker = candidate; break; }
    }
  } catch {
    continue;
  }
}
group("扩展加载与反向连接");
const loadedId = worker ? new URL(worker.url).host : null;
if (loadedId) LOADED_ID = loadedId;
check("加载后的扩展 ID 为合法 32 位格式", Boolean(loadedId) && /^[a-p]{32}$/.test(loadedId), { loadedId, keyDerived: EXTENSION_ID, keyHonored: loadedId === EXTENSION_ID });
if (!loadedId) abort(`CDP cdp=${CDP_PORT} 上未见本轮夹具页与 service worker；检查上一轮残留的浏览器进程`);

let swError = "";
async function swEvaluate(expression) {
  let sessionId = "";
  try {
    const target = await workerTarget();
    if (!target) throw new Error("service worker target 未出现");
    sessionId = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    await cdp("Runtime.enable", {}, sessionId);
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result?.exceptionDetails) swError = JSON.stringify(result.exceptionDetails).slice(0, 600);
    return result?.result?.value ?? null;
  } catch (error) {
    swError = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    if (sessionId) await cdp("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

const seed = `(async () => { await chrome.storage.local.set({'browseruse.port': ${PORT}}); const got = await chrome.storage.local.get('browseruse.port'); return String(got['browseruse.port']); })()`;
const seeded = await until(30, async () => (String(await swEvaluate(seed)) === String(PORT) ? String(PORT) : null));
check("storage 覆盖端口后不用重打包", seeded !== null, { seeded, expected: String(PORT), swError });

const ready = await until(60, async () => {
  const result = await owner.call("list_pages", {});
  return result.isError ? null : result;
});
check("扩展反向接入固定端口", ready !== null, ready?.text ?? "仍是 extension_offline");
if (!ready) abort("扩展未接入集线器，参见上一行提示");

const badge = await until(10, async () => (await swEvaluate("chrome.action.getBadgeText({})")) || null);
check("工具栏角标可用", Boolean(badge), badge ?? swError ?? "角标为空");

group("会话态与真实输入");
const loginLine = ready.text.split("\n").find((line) => line.includes("登录夹具"));
const pageId = loginLine ? Number(/\[(\d+)\]/.exec(loginLine)?.[1]) : null;
check("list_pages 列出夹具页", pageId !== null, ready.text);
await owner.call("select_page", { pageId, bringToFront: true });

const evalIn = (body) => owner.call("evaluate_script", { function: body });
const uidIn = (text, label, role = "[a-z]+") => new RegExp(`\\[(\\d+_\\d+)\\] ${role} "${label}"`).exec(text)?.[1] ?? null;
const openPage = async (route, marker) => {
  await owner.call("navigate_page", { type: "url", url: `${FIXTURE}${route}` });
  return marker ? owner.call("wait_for", { text: [marker], timeout: 12_000 }) : null;
};

const snap = await owner.call("take_snapshot", {});
check("take_snapshot 返回可交互元素 uid", uidIn(snap.text, "用户名") !== null && uidIn(snap.text, "提交") !== null, snap.text.slice(0, 600));

const probeField = () => evalIn("() => { const el = document.getElementById('u'); return { value: el.value, start: el.selectionStart, end: el.selectionEnd, focused: document.activeElement === el }; }");
await owner.call("interact", { action: "fill", uid: uidIn(snap.text, "用户名"), value: "夹具用户" });
const firstFill = await probeField();
await owner.call("interact", { action: "fill", uid: uidIn(snap.text, "用户名"), value: "替换后的内容" });
const secondFill = await probeField();
check("fill 替换旧内容", secondFill.text.includes("替换后的内容") && !secondFill.text.includes("夹具用户"), { first: firstFill.text, second: secondFill.text });
await owner.call("interact", { action: "fill", uid: uidIn(snap.text, "用户名"), value: "夹具用户" });

await owner.call("interact", { action: "press_key", key: "Tab" });
const focusAfterTab = await evalIn("() => document.activeElement?.id ?? null");
check("press_key 派发按键移动焦点", focusAfterTab.text.includes("go"), focusAfterTab.text);

const selectFill = await owner.call("interact", { action: "fill", uid: uidIn(snap.text, "系列"), value: "b" });
const picked = await evalIn("() => document.getElementById('pick').textContent");
check("fill 选中原生下拉并派发 change", picked.text.includes("已选 b"), { selectFill: selectFill.text.slice(0, 120), picked: picked.text });

const submitRect = await evalIn(
  "() => { const r = document.getElementById('go').getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2; const el = document.elementFromPoint(cx, cy); return { cx: Math.round(cx), cy: Math.round(cy), hit: el ? el.id || el.tagName : null, vis: document.visibilityState }; }",
);
const { windowId } = await cdp("Browser.getWindowForTarget", { targetId: (await pageTarget()).targetId });
const setWindowState = (state) => cdp("Browser.setWindowBounds", { windowId, bounds: { windowState: state } });

await setWindowState("minimized");
await delay(1_200);
const clickRes = await owner.call("interact", { action: "click", uid: uidIn(snap.text, "提交") });
await until(20, async () => ((await evalIn("() => location.pathname")).text.includes("dashboard") ? true : null));

const minimizedShot = await owner.call("take_screenshot", {});
check("窗口最小化时截图返回 window_minimized", minimizedShot.isError && minimizedShot.text.includes("window_minimized"), minimizedShot.text.slice(0, 200));

await setWindowState("normal").catch(() => undefined);
await delay(600);
const shotPath = path.join(PROFILE, "restored.png");
const shot = await owner.call("take_screenshot", { filePath: shotPath });
const png = existsSync(shotPath) ? readFileSync(shotPath) : null;
const dims = png && png.length > 24 ? { w: png.readUInt32BE(16), h: png.readUInt32BE(20) } : null;
check("恢复窗口后截图出真实画面", !shot.isError && Boolean(dims?.w && dims.h && png.length > 1_500), { shot: shot.text.slice(0, 160), bytes: png?.length ?? 0, dims });

const dashboard = await owner.call("take_snapshot", {});
const state = await evalIn("() => ({ path: location.pathname, out: document.getElementById('out')?.textContent ?? null, val: document.getElementById('u')?.value ?? null })");
check(
  "跳转后仍认出 cookie 会话",
  dashboard.text.includes("已登录：夹具用户"),
  { click: clickRes.text.slice(0, 160), submitRect: submitRect.text.slice(0, 240), state: state.text.slice(0, 240), snapshot: dashboard.text.slice(0, 200) },
);

group("MAIN world 反证");
await openPage("/mainworld", "主 world 探针");
const globalRead = await evalIn("() => window.__probe");
check("evaluate_script 读到页面全局变量", /返回值: 42/.test(globalRead.text), globalRead.text);

const wrote = await evalIn(
  "() => { const el = document.createElement('p'); el.id = 'from-agent'; el.textContent = '来自 agent 的节点'; document.body.appendChild(el); return document.querySelectorAll('#from-agent').length; }",
);
check("evaluate_script 写入 DOM", /返回值: 1/.test(wrote.text), wrote.text);

const observed = await evalIn("() => ({ batches: window.__observed.length, text: document.getElementById('from-agent') && document.getElementById('from-agent').textContent })");
check("页面 MutationObserver 观察到改动", /"batches":\s*[1-9]\d*/.test(observed.text) && observed.text.includes("来自 agent 的节点"), observed.text);

const visible = await owner.call("take_snapshot", {});
check("新节点出现在页面快照里", visible.text.includes("来自 agent 的节点"), visible.text.slice(0, 400));

await owner.call("evaluate_script", { function: "(el) => { el.textContent = '按 uid 注入元素参数成功'; }", args: [uidIn(visible.text, "主 world 探针")] });
const readBack = await evalIn("() => document.querySelector('h1').textContent");
check("args 里的 uid 注入为真元素", readBack.text.includes("按 uid 注入元素参数成功"), readBack.text);

group("网络与控制台");
await openPage("/net");
const done = await until(20, async () => {
  const title = await evalIn("() => document.title");
  return title.text.includes("接口已回") ? title : null;
});
check("夹具接口已完成", done !== null, done?.text);
const network = await owner.call("logs", { type: "network", resourceTypes: ["xhr", "fetch"] });
check("list_network_requests 记录到真实 XHR", /\/api\/data/.test(network.text) && /200/.test(network.text), network.text);
const consoleOut = await owner.call("logs", { type: "console", types: ["log"] });
check("list_console_messages 记录到 console 输出", consoleOut.text.includes("控制台标记 ALPHA"), consoleOut.text);

group("上传与对话框");
const uploadPath = path.join(tmpdir(), "bu-acceptance-payload.txt");
writeFileSync(uploadPath, "x".repeat(2048));
await openPage("/upload", "上传");
const uploadSnap = await owner.call("take_snapshot", {});
const fileUid = uidIn(uploadSnap.text, "附件", "[a-zA-Z]+");
await owner.call("upload_file", { uid: fileUid, filePath: uploadPath });
const readFile = await evalIn("() => document.getElementById('r').textContent");
check("upload_file 让页面读到文件", readFile.text.includes("bu-acceptance-payload.txt:2048"), { uid: fileUid, readFile: readFile.text });

await openPage("/login", "登录");
await evalIn("() => { setTimeout(() => { document.title = confirm('夹具确认框') ? '已确认' : '已取消'; }, 400); return 'armed'; }");
const blocked = await until(15, async () => {
  const title = await evalIn("() => document.title");
  return title.isError && title.text.includes("no_dialog") ? title : null;
});
check("confirm 阻塞时通道返回 no_dialog", blocked !== null, blocked?.text ?? "未出现阻塞态");
const handled = await owner.call("handle_dialog", { action: "accept" });
const afterDialog = await until(15, async () => {
  const title = await evalIn("() => document.title");
  return title.text.includes("已确认") ? title : null;
});
check("handle_dialog 解阻塞后页面 JS 继续", afterDialog !== null, { handled: handled.text, after: afterDialog?.text ?? "标题未变" });

group("元素检查");
await openPage("/inspect", "元素检查");
const inspectSnap = await owner.call("take_snapshot", {});
const byUid = await owner.call("inspect_element", { uid: uidIn(inspectSnap.text, "按我", "button") });
check(
  "inspect 返回属性、样式、DOM 路径与事件绑定位置",
  !byUid.isError &&
    byUid.text.includes("data-role='submit'") &&
    /监听 click @ \S+:\d+/.test(byUid.text) &&
    byUid.text.includes("display=") &&
    byUid.text.includes("路径=button#target"),
  byUid.text.slice(0, 700),
);
const hidden = await owner.call("inspect_element", { selector: "#hidden" });
check("inspect 认出隐藏元素没有布局盒", !hidden.isError && hidden.text.includes("已渲染: 否"), hidden.text.slice(0, 400));
const bySelector = await owner.call("inspect_element", { selector: "input[aria-label='昵称']" });
check("selector 与 uid 两条路定位到同一个元素", bySelector.text.includes("原有内容"), bySelector.text.slice(0, 400));
const badSelector = await owner.call("inspect_element", { selector: "###" });
check("非法选择器返回 bad_request 而非 cdp_failed", badSelector.isError && badSelector.text.includes("bad_request"), badSelector.text.slice(0, 240));

group("beforeunload 不打断导航");
await openPage("/dirty", "未保存的改动");
const stay = await owner.call("navigate_page", { type: "url", url: `${FIXTURE}/inspect`, handleBeforeUnload: "dismiss", timeout: 15_000 });
const stayed = await evalIn("() => location.pathname");
check(
  "handleBeforeUnload=dismiss 留在原页且立刻返回",
  !stay.isError && stay.text.includes("已取消") && stayed.text.includes("/dirty"),
  { stay: stay.text.slice(0, 200), stayed: stayed.text },
);
const leave = await owner.call("navigate_page", { type: "url", url: `${FIXTURE}/login`, handleBeforeUnload: "accept", timeout: 15_000 });
const left = await evalIn("() => location.pathname");
check(
  "handleBeforeUnload=accept 放行导航",
  !leave.isError && leave.text.includes("已放行") && left.text.includes("/login"),
  { leave: leave.text.slice(0, 200), left: left.text },
);

group("跨 world：调试其它扩展注入的脚本");
const extList = await owner.call("manage_extensions", { action: "list" });
const guardLine = extList.text.split("\n").find((line) => line.includes("油猴替身"));
const guardId = guardLine ? /\b([a-p]{32})\b/.exec(guardLine)?.[1] ?? null : null;
check("extensions 列出其它扩展并标记自身", guardId !== null && extList.text.includes("[自建]") && EXTENSION_ID !== guardId, extList.text.slice(0, 500));

await openPage("/inspect", "元素检查");
const contexts = await owner.call("list_worlds", {});
check("worlds 可列出其它扩展的 world", contexts.text.includes(String(guardId)), contexts.text.slice(0, 500));

const inWorld = await owner.call("evaluate_script", { function: "() => window.__userscript_secret ?? null", context: String(guardId) });
const inMain = await owner.call("evaluate_script", { function: "() => window.__userscript_secret ?? null" });
check("context 进入替身 world 可读取其私有全局", inWorld.text.includes("替身私有值"), inWorld.text.slice(0, 300));
check("同一个探针在 main world 读不到", inMain.text.includes("返回值: null"), inMain.text.slice(0, 300));

const worldLines = { last: "" };
const worldError = await until(15, async () => {
  const out = await owner.call("logs", { type: "console",});
  worldLines.last = out.text;
  return out.text.includes("替身脚本报错样例") ? out : null;
});
check(
  "内容脚本的未捕获报错带着 world 与出处进 console",
  Boolean(worldError) && String(worldError?.text).includes(String(guardId)),
  { found: worldError?.text.slice(0, 300) ?? "没等到那条报错", all: worldLines.last.slice(0, 500) },
);
check(
  "内容脚本的 console.log 也归入其自身 world",
  worldLines.last.includes("替身脚本已注入") && worldLines.last.includes(String(guardId)),
  worldLines.last.slice(0, 500),
);

const guardScripts = await owner.call("scripts", { action: "list", filter: String(guardId) });
check("scripts 按扩展 ID 过滤出注入的脚本", guardScripts.text.includes("content.js"), guardScripts.text.slice(0, 300));
const guardSource = await owner.call("scripts", { action: "read", url: `${guardId}/content.js` });
check("script 取到用户脚本源码", guardSource.text.includes("__userscript_secret"), guardSource.text.slice(0, 300));
const pageSource = await owner.call("scripts", { action: "read", url: "/inspect" });
check("script 也可读取页面自身的内联脚本", pageSource.text.includes("onTargetClick") || pageSource.text.includes("addEventListener"), pageSource.text.slice(0, 300));

const stopped = await owner.call("manage_extensions", { action: "disable", extensionId: String(guardId) });
check("能停用其它扩展", !stopped.isError && stopped.text.includes("停用"), stopped.text.slice(0, 200));
const selfStop = await owner.call("manage_extensions", { action: "disable", extensionId: EXTENSION_ID });
check("拒绝停用本扩展", selfStop.isError && selfStop.text.includes("bad_request"), selfStop.text.slice(0, 200));
await owner.call("manage_extensions", { action: "enable", extensionId: String(guardId) });

const options = await owner.call("manage_extensions", { action: "open_options", extensionId: String(guardId) });
const optionsPageId = Number(/页面 (\d+)/.exec(options.text)?.[1] ?? "0");
const optionsSnap = await owner.call("take_snapshot", { pageId: optionsPageId });
check(
  "接管其它扩展的界面失败，错误信息含原因与退路",
  optionsSnap.isError && optionsSnap.text.includes("attach_blocked") && optionsSnap.text.includes("无法调试另一个扩展"),
  optionsSnap.text.slice(0, 300),
);
await owner.call("select_page", { pageId });
const optionsTarget = (await targetInfos()).find((item) => String(item.url ?? "").startsWith(`chrome-extension://${guardId}/`));
if (optionsTarget) await cdp("Target.closeTarget", { targetId: optionsTarget.targetId }).catch(() => undefined);

group("断点与暂停");
function bridgeCall(method) {
  return new Promise((resolve) => {
    const child = track(spawn("python", ["browseruse.py", "--port", String(PORT), "--call", method], { stdio: ["ignore", "pipe", "pipe"] }));
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.on("close", () => resolve(out));
  });
}

await openPage("/bp", "断点夹具");
const armed = await owner.call("debugger", { action: "add", url: `${FIXTURE}/app.js`, line: 4 });
check("breakpoints add 返回落点", !armed.isError && armed.text.includes("断点已设"), armed.text.slice(0, 220));
const armSnap = await owner.call("take_snapshot", {});
const clickStarted = Date.now();
const pausedClick = await owner.call("interact", { action: "click", uid: uidIn(armSnap.text, "算一次", "button") });
const clickHeldMs = Date.now() - clickStarted;
check(
  "命中断点的 click 立即返回 paused，不占队列",
  pausedClick.isError && pausedClick.text.includes("paused") && clickHeldMs < 4_000,
  { clickHeldMs, text: pausedClick.text.slice(0, 220) },
);
const pauseInfo = await owner.call("debugger", { action: "state", function: "() => total + items.length" });
check(
  "pause 返回调用栈、局部变量与帧内求值",
  pauseInfo.text.includes("computeTotal @ app.js:4") && pauseInfo.text.includes("total=45") && pauseInfo.text.includes("该帧求值: 48"),
  pauseInfo.text.slice(0, 700),
);
const frozen = await owner.call("take_snapshot", {});
check("暂停期间其它工具立即返回 paused", frozen.isError && frozen.text.includes("paused"), frozen.text.slice(0, 200));
const released = await owner.call("debugger", { action: "resume" });
const ranOnce = await until(15, async () => (((await evalIn("() => window.__runs")).text.includes("1")) ? true : null));
check(
  "continue 之后页面执行完剩余语句",
  !released.isError && released.text.includes("页面在跑") && ranOnce !== null,
  { released: released.text.slice(0, 160), runs: (await evalIn("() => window.__runs")).text },
);
await owner.call("debugger", { action: "add", url: `${FIXTURE}/app.js`, line: 4 });
const secondSnap = await owner.call("take_snapshot", {});
const pausedAgain = await owner.call("interact", { action: "click", uid: uidIn(secondSnap.text, "算一次", "button") });
check("再次命中仍停在同一断点", pausedAgain.isError && pausedAgain.text.includes("paused"), pausedAgain.text.slice(0, 200));
await bridgeCall("detach");
const ranTwice = await until(15, async () => (((await evalIn("() => window.__runs")).text.includes("2")) ? true : null));
check(
  "detach 必然放开中断中的页面",
  ranTwice !== null,
  { runs: (await evalIn("() => window.__runs")).text, detached: await bridgeCall("detach") },
);

const listenerArm = await owner.call("debugger", { action: "add_listener", eventName: "click" });
check("事件名断点在这条通道上可设置", !listenerArm.isError && listenerArm.text.includes("click"), listenerArm.text.slice(0, 240));
const clickSnapshot = await owner.call("take_snapshot", {});
const pausedByListener = await owner.call("interact", { action: "click", uid: uidIn(clickSnapshot.text, "算一次", "button") });
check(
  "事件断点在 dispatch 处把点击拦下",
  pausedByListener.isError && pausedByListener.text.includes("paused"),
  pausedByListener.text.slice(0, 240),
);
const listenerState = await owner.call("debugger", {});
check("暂停原因来自事件监听", listenerState.text.includes("停在"), listenerState.text.slice(0, 300));
await owner.call("debugger", { action: "resume" });
const listenerOff = await owner.call("debugger", { action: "remove_listener", eventName: "click" });
const afterUnset = await owner.call("interact", { action: "click", uid: uidIn((await owner.call("take_snapshot", {})).text, "算一次", "button") });
check("撤掉事件断点后点击照常通过", !listenerOff.isError && !afterUnset.isError, { listenerOff: listenerOff.text.slice(0, 160), afterUnset: afterUnset.text.slice(0, 160) });

group("站点自身的 service worker");
await openPage("/sw", "SW 已注册");
const swProbe = String(
  (await swEvaluate(`(async () => {
    const targets = await chrome.debugger.getTargets();
    const mine = targets.find((t) => t.type === 'worker' && String(t.url).includes('127.0.0.1'));
    const other = targets.find((t) => (t.type === 'worker' || t.type === 'background_page')
      && String(t.url).startsWith('chrome-extension://') && !String(t.url).startsWith('chrome-extension://' + chrome.runtime.id + '/'));
    const attempt = async (target) => {
      if (!target) return 'no-target';
      try {
        await chrome.debugger.attach({ targetId: target.id }, '1.3');
        await chrome.debugger.sendCommand({ targetId: target.id }, 'Runtime.enable');
        const r = await chrome.debugger.sendCommand({ targetId: target.id }, 'Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
        await chrome.debugger.detach({ targetId: target.id }).catch(() => undefined);
        return 'ok ' + String(r && r.result && r.result.value);
      } catch (error) { return 'ERR ' + String(error && error.message || error).slice(0, 60); }
    };
    return JSON.stringify({ mine: await attempt(mine), other: await attempt(other) });
  })()`)) ?? "{}",
);
const swOutcome = JSON.parse(swProbe);
check("站点自身的 SW target 能 attach 并求值", swOutcome.mine === "ok 2", swProbe.slice(0, 300));
check("其它扩展的后台 target 一律被拒", String(swOutcome.other).startsWith("ERR Cannot access a chrome-extension"), swProbe.slice(0, 300));


group("存储、拦截与整页存档");
await openPage("/login", "登录");
await evalIn("() => { localStorage.setItem('probe', '甲的值'); document.cookie = 'probe_cookie=1; path=/'; return 'seeded'; }");
const storage = await owner.call("list_storage", { scope: "all" });
check(
  "storage 一次返回 cookie、localStorage 与库名",
  storage.text.includes("probe=甲的值") && storage.text.includes("probe_cookie=1") && storage.text.includes("local 共 2 项"),
  storage.text.slice(0, 500),
);
const mocked = await owner.call("intercept_requests", { action: "add", match: "/api/intercepted", ruleAction: "mock", status: 200, body: '{"ok":false,"mocked":true}' });
check("拦截规则加上就生效并带自动停用倒计时", !mocked.isError && mocked.text.includes("mock") && /\d+s 后自动停用/.test(mocked.text), mocked.text);
await openPage("/intercept", "拦截结果");
const mockedLog = await until(20, async () => {
  const out = await owner.call("logs", { type: "console", types: ["log"] });
  return out.text.includes("拦截结果") ? out : null;
});
const hitsAfterMock = await owner.call("intercept_requests", { action: "list" });
check("被 mock 的请求让页面读到假数据", String(mockedLog?.text).includes("拦截结果 false"), mockedLog?.text.slice(0, 300) ?? "没等到");
check("命中记录可取回", hitsAfterMock.text.includes("/api/intercepted") && hitsAfterMock.text.includes("mock"), hitsAfterMock.text.slice(0, 400));
await owner.call("intercept_requests", { action: "clear" });
await openPage("/intercept", "拦截结果");
const realLog = await until(20, async () => {
  const out = await owner.call("logs", { type: "console", types: ["log"] });
  return out.text.includes("拦截结果 true") ? out : null;
});
check("撤掉拦截后同一请求读回真数据", realLog !== null, realLog?.text.slice(0, 300) ?? "仍读到 mock");
const mhtmlPath = path.join(PROFILE, "page.mhtml");
const saved = await owner.call("save_page", { filePath: mhtmlPath });
const mhtml = existsSync(mhtmlPath) ? readFileSync(mhtmlPath, "utf8") : "";
check("archive 写出完整 mhtml", !saved.isError && mhtml.startsWith("From:") && mhtml.includes("Snapshot-Content-Location") && mhtml.includes("MIME-Version"), { saved: saved.text.slice(0, 160), head: mhtml.slice(0, 60) });
const readBackPort = await owner.call("set_bridge_port", {});
check("bridge 读出的端口就是当前集线器端口", readBackPort.text.includes(`端口 ${PORT}`) && readBackPort.text.includes("已连上"), readBackPort.text);
const badPort = await owner.call("set_bridge_port", { port: 80 });
check("非法端口被拦截并说明范围", badPort.isError && badPort.text.includes("1024"), badPort.text.slice(0, 200));

group("消失、条件等待与性能录制");
await openPage("/vanish", "会消失的节点");
const goneBySelector = await owner.call("wait_for", { selector: "#gone", state: "detached", timeout: 8_000 });
check("wait_for 等元素从 DOM 消失", !goneBySelector.isError && goneBySelector.text.includes("#gone"), goneBySelector.text.slice(0, 200));
const readyByFn = await owner.call("wait_for", { function: "() => window.__ready === true", timeout: 8_000 });
check("wait_for 等自定义函数为真", !readyByFn.isError && readyByFn.text.includes("自定义函数为真"), readyByFn.text.slice(0, 200));
const stillWaiting = await owner.call("wait_for", { selector: "#never", state: "attached", timeout: 1_200 });
check("超时返回页面正文", stillWaiting.isError && stillWaiting.text.includes("timeout") && stillWaiting.text.includes("会消失的节点"), stillWaiting.text.slice(0, 260));
const traced = await owner.call("trace_page", { action: "run", durationMs: 1_200 });
const traceEvents = Number(/事件 (\d+) 个/.exec(traced.text)?.[1] ?? "0");
check("trace 回摘要与耗时 Top", !traced.isError && traceEvents > 0 && traced.text.includes("耗时 Top"), traced.text.slice(0, 400));

group("站点 SW 会话与下载");
await openPage("/sw", "SW 已注册");
const swList = await owner.call("handle_worker", { action: "list" });
const swTarget = /\[(\w{8})\][^\n]*\/sw\.js/.exec(swList.text)?.[1];
check("worker 可列出站点自身的 SW", Boolean(swTarget), swList.text.slice(0, 500));
const swAttach = await owner.call("handle_worker", { action: "attach", targetId: String(swTarget) });
const swValue = await owner.call("handle_worker", { action: "evaluate", targetId: String(swTarget), function: "() => typeof self.serviceWorker !== 'undefined'" });
check("在 SW 内求值可读取其自身全局", !swAttach.isError && swValue.text.includes("worker 返回值: true"), { swAttach: swAttach.text.slice(0, 160), swValue: swValue.text });
await owner.call("handle_worker", { action: "evaluate", targetId: String(swTarget), function: "() => { console.log('挂上之后再打一条'); return 1; }" });
const swConsole = await until(10, async () => {
  const out = await owner.call("handle_worker", { action: "console", targetId: String(swTarget) });
  return out.text.includes("挂上之后再打一条") ? out : null;
});
check("挂接后 worker 自身的 console 进缓冲", swConsole !== null, swConsole?.text.slice(0, 300) ?? "没等到");

const swPage = (await targetInfos()).find((item) => String(item.url ?? "").endsWith("/sw"));
const downloadSession = swPage ? (await cdp("Target.attachToTarget", { targetId: swPage.targetId, flatten: true })).sessionId : null;
if (downloadSession) await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: PROFILE }, downloadSession);
await openPage("/download", "下载");
const downloadUid = uidIn((await owner.call("take_snapshot", {})).text, "下载文件", "[a-z]+");
await owner.call("interact", { action: "click", uid: downloadUid });
const downloaded = await owner.call("handle_downloads", { action: "wait", match: "blob.csv", timeout: 15_000 });
check("downloads wait 拿到本机路径", !downloaded.isError && downloaded.text.includes("blob.csv") && downloaded.text.includes("complete"), downloaded.text.slice(0, 300));
const listed = await owner.call("handle_downloads", { action: "list" });
check("downloads list 可列出这条记录", listed.text.includes("blob.csv"), listed.text.slice(0, 300));

group("两个会话并发");
await openPage("/login", "登录");
const joiner = startMcp("joiner", PORT);
await joiner.hello();
await until(20, async () => ((await joiner.call("list_pages", {})).isError ? null : true));
const valueA = "甲的内容甲的内容";
const valueB = "乙的内容乙的内容";
const rounds = [];
for (let round = 0; round < 3; round += 1) {
  const fresh = await owner.call("take_snapshot", {});
  const field = uidIn(fresh.text, "用户名");
  await owner.call("interact", { action: "fill", uid: field, value: "" });
  const [ra, rb] = await Promise.all([owner.call("interact", { action: "fill", uid: field, value: valueA }), joiner.call("interact", { action: "fill", uid: field, value: valueB })]);
  const value = await evalIn("() => document.getElementById('u').value");
  rounds.push({ ok: !ra.isError && !rb.isError, value: value.text.replace(/^返回值: /, "") });
}
check("两个会话各自取回结果", rounds.every((round) => round.ok), rounds);
check("并发填充不互相干扰", rounds.every((round) => round.value === `"${valueA}"` || round.value === `"${valueB}"`), rounds);

group("失效事件");
await openPage("/spa", "SPA 路由");
const spaSnap = await owner.call("take_snapshot", {});
const routeUid = uidIn(spaSnap.text, "换路由");
const firstClick = await owner.call("interact", { action: "click", uid: routeUid });
check("pushState 前按钮可点击", !firstClick.isError, firstClick.text.slice(0, 200));
const retired = await until(10, async () => {
  const again = await owner.call("interact", { action: "click", uid: routeUid });
  return again.isError && again.text.includes("stale_snapshot") ? again : null;
});
const sameDocument = owner.logs.find((line) => line.includes("navigated:same_document"));
check(
  "pushState 换路由后旧 uid 作废",
  retired !== null && Boolean(sameDocument),
  { click: retired?.text.slice(0, 150) ?? "未报 stale_snapshot", event: sameDocument ?? "日志未出现 navigated:same_document" },
);

const inflight = owner.call("wait_for", { text: ["永远不会出现的文本"], timeout: 20_000 });
const spaTarget = await pageTarget();
const closedAt = Date.now();
await cdp("Target.closeTarget", { targetId: spaTarget.targetId });
const stuck = await Promise.race([inflight, delay(5_000).then(() => null)]);
const inflightMs = Date.now() - closedAt;
check(
  "关页后飞行中的命令 5s 内报错",
  Boolean(stuck) && stuck.isError && /page_gone|extension_offline/.test(stuck.text) && inflightMs < 5_000,
  { elapsedMs: inflightMs, answer: stuck?.text.slice(0, 160) ?? "5s 未返回" },
);
const afterClose = await until(20, async () => {
  const snapshot = await owner.call("take_snapshot", {});
  return snapshot.isError && /no_page|page_gone|extension_offline/.test(snapshot.text) ? snapshot : null;
});
const closedLine = owner.logs.find((line) => line.includes("扩展事件：page_closed"));
check(
  "关掉选中标签页后不再返回死页面",
  afterClose !== null && Boolean(closedLine),
  { lastProbe: afterClose?.text.slice(0, 160) ?? "仍返回旧快照", event: closedLine ?? "日志未出现 page_closed" },
);

group("后台窗口与关页");
const created = await owner.call("create_page", { mode: "window", url: `${FIXTURE}/login`, focused: false, width: 900, height: 600 });
check("create_page 开后台窗口且不抢焦点", !created.isError && /后台不抢焦点/.test(created.text), created.text.slice(0, 200));
const newPageId = Number(/页面 (\d+)/.exec(created.text)?.[1]);
check("create_page 自动选定为作用域", Number.isFinite(newPageId), { newPageId });
const listedNew = await owner.call("list_pages", {});
check("新窗口出现在 list_pages", listedNew.text.includes(`[${newPageId}]`), { newPageId, listed: listedNew.text.slice(0, 300) });
const createdSnap = await owner.call("take_snapshot", {});
check("后台窗口可直接快照与交互", !createdSnap.isError && createdSnap.text.includes("用户名"), createdSnap.text.slice(0, 200));
const closedCreated = await owner.call("close_page", { pageId: newPageId });
check("close_page 关闭后台窗口", !closedCreated.isError && closedCreated.text.includes(`已关闭页面 ${newPageId}`), closedCreated.text);
const listedAfterClose = await owner.call("list_pages", {});
check("关闭后 list_pages 不再返回该页", !listedAfterClose.text.includes(`[${newPageId}]`), { newPageId });

group("休眠标签页唤醒");
const discardWin = await owner.call("create_page", { mode: "tab", url: `${FIXTURE}/login` });
const discardPageId = Number(/页面 (\d+)/.exec(discardWin.text)?.[1]);
check("创建待休眠后台标签页", Number.isFinite(discardPageId), discardWin.text.slice(0, 200));
const discardDebug = await swEvaluate(
  `(async () => { const res = await chrome.tabs.discard(${discardPageId}).catch((e) => ({ error: String(e && e.message) })); return JSON.stringify({ requested: ${discardPageId}, newId: res.id ?? null, discarded: res.discarded ?? null, error: res.error ?? null }); })()`,
);
check("后台标签页成功休眠", /"discarded":true/.test(String(discardDebug)), { discardDebug, swError });
// Chrome 的 discard 可能替换标签页 id：取回执里的新 id 重新选定
const newTabId = Number(/"newId":(\d+)/.exec(String(discardDebug))?.[1]) || discardPageId;
await owner.call("select_page", { pageId: newTabId });
const wakeSnap = await owner.call("take_snapshot", {});
check("休眠标签页接管时自动唤醒", !wakeSnap.isError && wakeSnap.text.includes("用户名"), wakeSnap.text.slice(0, 200));
await owner.call("close_page", { pageId: newTabId });

group("断线之后");
browserProcess.kill();
const answers = [];
const gone = await until(30, async () => {
  const result = await owner.call("list_pages", {});
  answers.push(result.isError ? (result.text.includes("extension_offline") ? "offline" : "error") : "ok");
  return result.isError && result.text.includes("extension_offline") ? result : null;
});
check("浏览器退出后返回 extension_offline", gone !== null, { answers: answers.join(""), last: gone?.text.slice(0, 150) ?? owner.logs.slice(-2) });

owner.child.kill();
joiner.child.kill();
server.close();
rmSync(uploadPath, { force: true });
await until(20, async () => ((await portBusy(CDP_PORT)) ? null : true));
const wiped = await until(20, async () => (wipeProfile() ? true : null));
if (!wiped) log(`profile 未清掉 path=${PROFILE}`);

finish();
