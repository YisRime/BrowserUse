import { spawn } from "node:child_process";

const results = [];
const children = [];
const cleanups = [];
const startedAt = Date.now();
let stepStartedAt = startedAt;

export function check(name, condition, evidence) {
  const now = Date.now();
  results.push({ name, ok: Boolean(condition), took: now - stepStartedAt });
  stepStartedAt = now;
  const detail = evidence === undefined ? "无证据" : typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  console.log(`${condition ? "通过" : "失败"}  ${name}${condition ? "" : `\n      ${String(detail).slice(0, 900)}`}`);
}

export function group(title) {
  console.log(`\n== ${title} ==`);
}

export function log(message) {
  console.log(`--  ${message}`);
}

export function track(child) {
  children.push(child);
  return child;
}

export function onCleanup(fn) {
  cleanups.push(fn);
}

function report(note) {
  const failed = results.filter((entry) => !entry.ok);
  const slow = results
    .filter((entry) => entry.took > 3_000)
    .map((entry) => `${entry.name} ${Math.round(entry.took / 1000)}s`)
    .join("，");
  console.log(`\n结果  ${results.length - failed.length}/${results.length} 项通过（${note}${slow ? `，耗时最长 ${slow}` : ""}）`);
  for (const entry of failed) console.log(`失败  ${entry.name}`);
  return failed.length;
}

export function abort(reason) {
  console.log(`失败  测试中止\n      ${reason}`);
  report("提前中止");
  process.exit(1);
}

export function finish() {
  process.exit(report(`全程 ${Math.round((Date.now() - startedAt) / 1000)}s`) ? 1 : 0);
}

export function installGuards(timeoutMs) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      for (const child of children) child.kill();
      process.exit(130);
    });
  }
  process.on("exit", () => {
    for (const child of children) child.kill();
    for (const fn of cleanups) fn();
  });
  const bail = (reason) => abort(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  process.on("unhandledRejection", bail);
  process.on("uncaughtException", bail);
  setTimeout(() => abort(`超过 ${Math.round(timeoutMs / 1000)}s 未完成，日志最后一行即停滞位置`), timeoutMs).unref();
}

export function startMcp(label, port) {
  const child = track(spawn("python", ["browseruse.py", "--port", String(port)], { stdio: ["pipe", "pipe", "pipe"] }));
  const logs = [];
  const waiters = new Map();
  let nextId = 1;

  const eachLine = (stream, onLine) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
        index = buffer.indexOf("\n");
      }
    });
  };

  eachLine(child.stdout, (line) => {
    const message = JSON.parse(line);
    waiters.get(message.id)?.(message);
  });
  eachLine(child.stderr, (line) => {
    logs.push(line);
    process.stderr.write(`[${label}] ${line}\n`);
  });

  const request = (method, params) => {
    const id = nextId++;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    waiters.set(id, release);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return gate;
  };

  return {
    child,
    label,
    logs,
    request,
    async hello() {
      const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: label, version: "0" } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return init;
    },
    async call(name, args) {
      const response = await request("tools/call", { name, arguments: args });
      const content = response.result?.content ?? [];
      return {
        text: content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
        image: content.find((block) => block.type === "image"),
        isError: response.result?.isError === true,
      };
    },
  };
}
