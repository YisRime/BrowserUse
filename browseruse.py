from __future__ import annotations
# // 导入模块
import argparse
import asyncio
import base64
import hashlib
import json
import os
import struct
import sys
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Callable
# // 工具类
PROTOCOL_VERSION = 3
DEFAULT_PORT = 8712
EXTENSION_ID = "fafdnkbknmlcdefmfhjgdgjloekimcle"
# // GUID 密钥
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
DEFAULT_TIMEOUT = 60.0
VERSION = "1.0.0"
# // 版本常量
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass
# // 使用说明
INSTRUCTIONS = (
    "这是用户已登录的浏览器。流程：list_pages → select_page（或 create_page 开自动化专用页）→ take_snapshot 取 uid → interact/evaluate_script 操作。"
    "uid 仅最近一次快照有效，页面变化后重拍。日志用 logs（network/console），断点调试用 debugger，其余见各工具说明。"
)
OFFLINE_HINT = (
    "浏览器侧未连入本端口。依次确认：1) 执行 pnpm build 后在 chrome://extensions 打开开发者模式，"
    "「加载已解压的扩展程序」选择 .output/chrome-mv3；2) 该浏览器窗口仍然开启；"
    "3) 工具栏 BrowserUse 图标上有蓝色角标。端口被占用时使用 --port 更换，并让扩展获知新端口："
    "调用 set_bridge_port 传入 port，或在扩展的 service worker 控制台执行 "
    "chrome.storage.local.set({'browseruse.port': 端口号})。"
    "扩展来源默认任意 chrome-extension:// 均可接入；需限定时用 --extension-id 指定。"
)
# 带码异常
class BrowserError(Exception):
    # 构造对象
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
# 连接异常
class WsError(Exception):
    pass
# 掩码异或
def _apply_mask(payload: bytes, mask: bytes) -> bytes:
    return bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
# 组帧发出
def encode_frame(opcode: int, payload: bytes, mask: bool = False) -> bytes:
    header = bytes([0x80 | opcode])
    length = len(payload)
    if length < 126:
        size = bytes([length])
    elif length < 65536:
        size = bytes([126]) + struct.pack("!H", length)
    else:
        size = bytes([127]) + struct.pack("!Q", length)
    if not mask:
        return header + size + payload
    key = os.urandom(4)
    first = size[0] | 0x80
    return header + bytes([first]) + size[1:] + key + _apply_mask(payload, key)
# 读握手头
async def read_http_headers(reader: asyncio.StreamReader) -> tuple[str, dict[str, str]]:
    request_line = await reader.readline()
    if not request_line:
        raise WsError("空连接")
    parts = request_line.decode("latin-1").rstrip().split(" ")
    path = parts[1] if len(parts) > 1 else "/"
    headers: dict[str, str] = {}
    while True:
        line = await reader.readline()
        if line in (b"\r\n", b"\n", b""):
            break
        name, _, value = line.decode("latin-1").partition(":")
        headers[name.strip().lower()] = value.strip()
    return path, headers
# 读取首帧
async def read_hello(connection: WsConnection) -> dict[str, Any] | None:
    hello = await connection.receive()
    if not hello or hello.get("t") != "hello" or hello.get("protocol") != PROTOCOL_VERSION:
        got = f"{hello.get('t')}／协议 {hello.get('protocol')}" if hello else "空帧"
        log(f"握手失败：期望协议 {PROTOCOL_VERSION} 的 hello，实际为 {got}")
        return None
    return hello
# 响应握手
async def accept_handshake(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, headers: dict[str, str]) -> bool:
    key = headers.get("sec-websocket-key", "")
    if "websocket" not in headers.get("upgrade", "").lower() or not key:
        log("握手失败：不是 WebSocket 升级请求")
        writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        await writer.drain()
        return False
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    writer.write(
        ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
         f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode()
    )
    await writer.drain()
    return True
# 发起握手
async def client_handshake(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, path: str, port: int) -> None:
    key = base64.b64encode(os.urandom(16)).decode()
    writer.write(
        f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: browseruse-client\r\n\r\n".encode()
    )
    await writer.drain()
    _, headers = await read_http_headers(reader)
    expected = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    if headers.get("sec-websocket-accept") != expected: raise WsError("握手失败：升级响应的 Sec-WebSocket-Accept 不一致")
# 连接对象
class WsConnection:
    # 构造对象
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, masked_out: bool) -> None:
        self.reader = reader
        self.writer = writer
        self.masked_out = masked_out
        self.alive = True
    # 发送一帧
    async def send(self, frame: dict[str, Any]) -> None:
        if not self.alive:
            raise WsError("连接已关闭")
        payload = json.dumps(frame, ensure_ascii=False).encode("utf-8")
        self.writer.write(encode_frame(0x1, payload, self.masked_out))
        await self.writer.drain()
    # 写原始帧
    def _raw(self, opcode: int, payload: bytes = b"") -> None:
        try:
            self.writer.write(encode_frame(opcode, payload, self.masked_out))
        except Exception:
            self.alive = False
    # 接收一帧
    async def receive(self) -> dict[str, Any] | None:
        try:
            return await self._receive_inner()
        except WsError as error:
            log(f"WebSocket 接收异常：{error}")
            self.alive = False
            return None
        except MemoryError:
            log("WebSocket 帧解析内存耗尽（疑似流错位）")
            self.alive = False
            return None

    async def _receive_inner(self) -> dict[str, Any] | None:
        fragments: list[bytes] = []
        while True:
            try:
                head = await self.reader.readexactly(2)
            except (asyncio.IncompleteReadError, ConnectionError):
                return None
            opcode = head[0] & 0x0F
            fin = head[0] & 0x80
            length = head[1] & 0x7F
            masked = head[1] & 0x80
            try:
                if length == 126:
                    length = struct.unpack("!H", await self.reader.readexactly(2))[0]
                elif length == 127:
                    length = struct.unpack("!Q", await self.reader.readexactly(8))[0]
                if length > 64_000_000:
                    raise WsError(f"帧长度异常：{length} 字节，疑似流解析错位")
                key = await self.reader.readexactly(4) if masked else b""
                payload = await self.reader.readexactly(length)
            except (asyncio.IncompleteReadError, ConnectionError):
                return None
            if masked:
                payload = _apply_mask(payload, key)
            if opcode == 0x8:
                self._raw(0x8)
                return None
            if opcode == 0x9:
                self._raw(0xA, payload[:125])
                continue
            if opcode == 0xA:
                continue
            # 0x1 文本帧 + 0x0 续帧：浏览器对大消息（如整页截图 base64）会分片，必须重组
            if opcode in (0x1, 0x0):
                fragments.append(payload)
                if not fin:
                    continue
                full = b"".join(fragments)
                fragments = []
                try:
                    return json.loads(full.decode("utf-8"))
                except json.JSONDecodeError:
                    continue
            continue
    # 发送保活
    def ping(self) -> None:
        self._raw(0x9, b"hb")
    # 关闭连接
    async def close(self) -> None:
        if not self.alive:
            return
        self.alive = False
        self._raw(0x8)
        try:
            self.writer.close()
        except Exception:
            pass
# 排版快照
def window_text(snapshot: dict[str, Any]) -> str:
    layout = snapshot.get("layout") or {}
    return "\n".join(
        [
            f"页面 {snapshot.get('pageId')} · {snapshot.get('title')}",
            f"url: {snapshot.get('url')}",
            f"布局: {layout.get('width')}x{layout.get('height')} css px, dpr {layout.get('dpr')}, "
            f"滚动 {layout.get('scrollX')},{layout.get('scrollY')} / 文档 {layout.get('documentWidth')}x{layout.get('documentHeight')}",
            f"文档状态: {snapshot.get('readyState')} · 焦点: {snapshot.get('focus') or '无'}",
            f"快照 {snapshot.get('snapshotSeq')}: 渲染 {snapshot.get('nodes')} 个节点，可定位 {snapshot.get('interactive')} 个元素",
            "",
            str(snapshot.get("tree") or ""),
        ]
    )
# 附带快照
def inline_snapshot(result: dict[str, Any]) -> str:
    snapshot = result.get("snapshot")
    return f"\n\n{window_text(snapshot)}" if isinstance(snapshot, dict) else ""
# 排版坐标
def at_text(result: dict[str, Any]) -> str:
    at = result.get("at") or {}
    return f"{int(at.get('x', 0))},{int(at.get('y', 0))}"
# 排版页面
def pages_text(result: dict[str, Any]) -> str:
    lines = []
    for page in result.get("pages") or []:
        marks = " ".join(label for key, label in (("selected", "← 当前作用域"), ("active", "前台"), ("attached", "已接管")) if page.get(key))
        lines.append(f"[{page.get('pageId')}] \"{page.get('title')}\" {page.get('url')}" + (f"  {marks}" if marks else ""))
    return "\n".join([f"# {len(lines)} 个页面（浏览器：{result.get('browser')}）", *(lines or ["（无标签页）"]), "以 select_page 指定 pageId；未选定前其他工具返回 no_page。"])
# 排版请求
def network_text(result: dict[str, Any]) -> str:
    rows = [
        f"{entry.get('method')} {entry.get('status', entry.get('failed', '-'))} {entry.get('resourceType')} "
        f"{entry.get('encodedDataLength', 0)}B "
        + (f"{int(entry['finishedAt']) - int(entry['startedAt'])}ms" if entry.get("finishedAt") else "进行中")
        + f" {entry.get('url')}"
        for entry in result.get("page") or []
    ]
    return paged_text("网络请求", result, rows, "（无记录：Network 域自接管时刻起开始收集）")
# 排版日志
def console_text(result: dict[str, Any]) -> str:
    rows = [
        (f"[{entry.get('type')}] " if not entry.get("world") else f"[{entry.get('type')}] {entry.get('world')} · ")
        + str(entry.get("text"))
        + (f" · {entry.get('source')}" + (f":{entry.get('line')}" if entry.get("line") else "") if entry.get("source") else "")
        for entry in result.get("page") or []
    ]
    return paged_text("控制台消息", result, rows, "（无记录：Runtime/Log 域自接管时刻起开始收集）")
# 排版分页
def paged_text(title: str, result: dict[str, Any], rows: list[str], empty: str) -> str:
    return "\n".join([f"# {title} {result.get('total')} 条，倒序第 {result.get('pageIdx', 0)} 页", *(rows or [empty])])
# 排版截图
def screenshot_meta(result: dict[str, Any]) -> str:
    layout = result.get("layout") or {}
    return (
        f"页面 {result.get('pageId')} · {result.get('format')} "
        f"{layout.get('screenshotWidth')}x{layout.get('screenshotHeight')} · {int((result.get('bytes') or 0) / 1024)} KB"
    )
# 排版是否
def yes(value: Any) -> str:
    return "是" if value else "否"
# 排版元素
def elements_text(result: dict[str, Any]) -> str:
    rows: list[str] = []
    for element in result.get("elements") or []:
        rect = element.get("rect") or {}
        attrs = " ".join(f"{item.get('name')}={item.get('value')!r}" for item in element.get("attrs") or [])
        styles = element.get("styles") or {}
        tag = f"{element.get('tag')}"
        if element.get("id"):
            tag += f"#{element.get('id')}"
        if element.get("classes"):
            tag += "." + ".".join(element.get("classes"))
        rows.append(f"<{tag}> 角色={element.get('ariaRole') or element.get('role') or '-'} 路径={element.get('path') or '-'}")
        rows.append(f"文本: {element.get('text')}" if element.get("text") else "文本: （空）")
        if element.get("value") is not None:
            rows.append(f"value: {element.get('value')!r} checked={yes(element.get('checked'))} disabled={yes(element.get('disabled'))}")
        rows.append(
            f"盒: {rect.get('x')},{rect.get('y')} {rect.get('width')}x{rect.get('height')} css px"
            if rect
            else "盒: 无布局盒（display:none 或已脱离文档）"
        )
        rows.append(f"在视口内: {yes(element.get('inViewport'))} · 已渲染: {yes(element.get('rendered'))} · 中心被其他元素遮挡: {yes(element.get('overlapped'))}")
        if attrs:
            rows.append(f"属性: {attrs}")
        if styles:
            rows.append("样式: " + "; ".join(f"{key}={value}" for key, value in styles.items()))
        for listener in element.get("listeners") or []:
            rows.append(f"监听 {listener.get('type')} @ {listener.get('at') or '未知位置'}" + (f" · {listener.get('handler')}" if listener.get("handler") else ""))
        html = str(element.get("outerHtml") or "")
        rows.append(f"HTML: {html}" + (f"（共 {element.get('htmlChars')} 字，可用 htmlChars 放宽）" if html.endswith("…") else ""))
        rows.append("")
    return "\n".join([f"# {result.get('matched')} 个匹配，本次检查 {len(result.get('elements') or [])} 个", "@ 之后为 scriptId:行号，可用 read_script 取回该段源码。", *rows]).rstrip()
# 排版世界
def contexts_text(result: dict[str, Any]) -> str:
    rows = []
    for info in result.get("contexts") or []:
        world = "main" if info.get("isDefault") else info.get("type") or "isolated"
        owner = f"（{info.get('owner')}）" if info.get("owner") else ""
        label = info.get("name") or ""
        rows.append(f"[{info.get('contextId')}] {world} {label} {info.get('origin')}{owner}".rstrip())
    return "\n".join(
        [
          f"# 页面 {result.get('pageId')} 现有 {len(rows)} 个 JS world", *(rows or ["（未采集到：仅接管后新开的上下文会上报）"]), "evaluate_script 的 context 可填此处 contextId、main，或 origin 中的子串（例如某个扩展 ID）。",
          "带 @grant 的油猴脚本运行在其独立的 isolated world：读取其私有变量需选择该 context。",
        ]
    )
# 排版脚本
def scripts_text(result: dict[str, Any]) -> str:
    rows = [
        f"[{item.get('scriptId')}] {item.get('lines')} 行 {'主帧' if item.get('topFrame') else '子帧'} {item.get('url')}"
        for item in result.get("scripts") or []
    ]
    return "\n".join([f"# 脚本索引共 {result.get('total')} 个，展示 {result.get('shown')} 个", *(rows or ["（无记录：该页面未解析过 JS，或刚接管）"]), "read_script 按 scriptId 或 url 子串读取源码；内联脚本与 eval 生成的代码亦在其中。"])
# 排版源码
def script_text(result: dict[str, Any]) -> str:
    return (
        f"// {result.get('url')} · 共 {result.get('lines')} 行，本段为 {result.get('fromLine')}-{result.get('toLine')}"
        + ("（已按 maxChars 截断）" if result.get("truncated") else "")
        + "\n"
        + str(result.get("source") or "")
    )
# 截取短名
def script_short(url: str) -> str:
    return str(url).rsplit("/", 1)[-1] if url else "(内联)"
# 排版断点
def breakpoints_text(result: dict[str, Any]) -> str:
    action = result.get("action")
    if action == "list":
        rows = [
            f"[{item.get('breakpointId')}] {script_short(item.get('url', ''))}:{int(item.get('lineNumber') or 0) + 1}:{item.get('columnNumber')}"
            + (f" 条件 {item.get('condition')}" if item.get("condition") else "")
            for item in result.get("breakpoints") or []
        ]
        return "\n".join([f"# 断点 {len(rows)} 个 · 页面{'停在断点上' if result.get('paused') else '在跑'}", *(rows or ["（无断点）"]), "add 传 url + line（行号从 1 起，与 read_script 一致）。"])
    if action == "add":
        locations = "; ".join(f"{item.get('scriptId')}:{int(item.get('line') or 0) + 1}" for item in result.get("locations") or [])
        return f"断点已设 {result.get('breakpointId')} → {locations or '尚未匹配到位置（脚本可能未加载，加载后生效）'}"
    if action == "clear":
        return f"已移除 {result.get('removed')} 个断点"
    if action in ("add_listener", "remove_listener"):
        watching = result.get("watching") or []
        return f"事件断点 {result.get('eventName')} 已{'添加' if action == 'add_listener' else '移除'}；当前监听：{' / '.join(watching) or '（无）'}"
    if action in ("activate", "deactivate"):
        return f"断点整体{'启用' if result.get('active') else '停用'}（表内保留 {result.get('kept')} 个）"
    return f"已移除断点 {result.get('removed')}，表内剩余 {result.get('left')} 个"
# 排版暂停
def pause_text(result: dict[str, Any]) -> str:
    action = result.get("action") or "state"
    if action == "exceptions":
        return f"异常中断已设为 {result.get('exceptionState')}"
    if action != "state":
        at = result.get("at") or {}
        if not result.get("paused"):
            return f"已 {action}，页面在跑"
        return f"已 {action}，停在 {at.get('function')} @ {script_short(at.get('url', ''))}:{at.get('line')}（已停 {result.get('heldForMs')}ms）"
    if not result.get("paused"):
        return f"页面在跑，未停在断点上（{result.get('url')}）"
    rows = [
        f"[{frame.get('index')}] {frame.get('function')} @ {script_short(frame.get('url', ''))}:{frame.get('line')}:{frame.get('column')}"
        + (f"  作用域 {' / '.join(frame.get('scopes') or [])}" if frame.get("scopes") else "")
        for frame in result.get("frames") or []
    ]
    lines = [
        f"# 停在 {result.get('reason')}（{', '.join(result.get('hitBreakpoints') or []) or '非断点触发'}）"
        f"· 已停 {result.get('heldForMs')}ms，超时后自动放行",
        *(rows or ["（无调用帧）"]),
    ]
    for scope, entries in (result.get("variables") or {}).items():
        lines.append(f"{scope}: " + ", ".join(f"{name}={value}" for name, value in entries.items()))
    if result.get("value") is not None or result.get("unserializable"):
        lines.append(f"该帧求值: {json.dumps(result.get('value'), ensure_ascii=False)}" + (f"（不可序列化：{result.get('unserializable')}）" if result.get("unserializable") else ""))
    lines.append("放行与单步用 resume/step_over；其他工具此时返回 paused。")
    return "\n".join(lines)
# 排版归档
def saved_text(result: dict[str, Any]) -> str:
    return (
        f"已保存整页 mhtml（含 CSS 与内联资源）：{result.get('url')}\n"
        f"标题 {result.get('title')} · {result.get('bytes')} 字节"
    )
# 排版配置
def config_text(result: dict[str, Any]) -> str:
    state = "已连上" if result.get("connected") else "未连上"
    if "previous" in result:
        return (
            f"端口已写入 {result.get('port')}（原为 {result.get('previous')}）· 当前 {state} · {result.get('endpoint')}\n"
            f"扩展最长 2 秒内改连新端口，该连接随后断开：需以 python browseruse.py --port {result.get('port')} 重启集线器。"
        )
    return (
        f"端口 {result.get('port')}（默认 {result.get('defaultPort')}）· {state} · {result.get('endpoint') or 'endpoint 未确定'}\n"
        "修改端口传 port；改完后需以同一端口重启集线器。"
    )
# 排版拦截
def intercept_text(result: dict[str, Any]) -> str:
    action = result.get("action")
    if action == "list":
        rows = [f"  {item.get('match')} → {item.get('action')}" for item in result.get("rules") or []]
        hits = [f"  {item.get('action')} {item.get('method')} {item.get('url')}" for item in (result.get("hits") or [])[:12]]
        return "\n".join(
            [
              f"# 拦截{'已开启' if result.get('on') else '未开启'}" + (f"，剩余 {int(result.get('leftMs') or 0) // 1000}s 后自动停用" if result.get("on") else ""), *(rows or ["（规则表为空）"]),
              f"最近命中 {result.get('hitTotal')} 条：", *(hits or ["（暂无命中记录）"]), "add 传 match（url 子串）与 ruleAction=continue/abort/block/redirect/mock。",
            ]
        )
    if action == "add":
        return f"规则已添加：{result.get('match')} → {result.get('ruleAction')}；拦截{'' if result.get('on') else '未'}启用，{int(result.get('leftMs') or 0) // 1000}s 后自动停用"
    if action == "remove":
        return f"已移除规则 {result.get('match')}，表内剩余 {result.get('rules')} 条，拦截{'已开启' if result.get('on') else '已关闭'}"
    if action == "clear":
        return f"已清空规则并关闭拦截（移除 {result.get('removed')} 条）"
    return f"已关闭拦截（规则表保留 {result.get('kept')} 条，再次添加即自动启用）"
# 排版存储
def storage_text(result: dict[str, Any]) -> str:
    lines = [f"# {result.get('scope')} · 来源 {result.get('origin')}"]
    if result.get("cookies") is not None:
        lines.append(f"cookie {len(result['cookies'])} 条：")
        lines.extend(
            f"  {item.get('name')}={item.get('value')} · domain={item.get('domain')}{item.get('path')} · "
            + ("会话级" if (item.get("expires") or -1) < 0 else f"到期 {item.get('expires')}")
            + (" httpOnly" if item.get("httpOnly") else "")
            + (" secure" if item.get("secure") else "")
            for item in result["cookies"]
        )
    for key in ("local", "session"):
        store = result.get(key)
        if store is None:
            continue
        if store.get("error"):
            lines.append(f"{key}: 读取失败：{store['error']}")
            continue
        items = store.get("items") or {}
        lines.append(f"{key} 共 {store.get('length')} 项，前 {len(items)} 项：")
        lines.extend(f"  {name}={value}" for name, value in items.items())
    if result.get("databases") is not None:
        dbs = result["databases"] or []
        lines.append(f"IndexedDB {len(dbs)} 个库：" + ("".join(f" {item.get('name')}(v{item.get('version')})" for item in dbs) or "（无）"))
    return "\n".join(lines)
# 排版后台
def worker_text(result: dict[str, Any]) -> str:
    action = result.get("action")
    if action == "list":
        rows = [
            f"[{item.get('targetId')}] {item.get('type')} {'已挂' if item.get('attached') else '    '} {item.get('consoleEntries')} 条日志 {item.get('url')}"
            for item in result.get("targets") or []
        ]
        return "\n".join([f"# 可挂接目标 {len(rows)} 个", *(rows or ["（无）"]), result.get("note") or ""])
    if action == "console":
        return console_text(result)
    if action == "evaluate":
        return f"worker 返回值: {json.dumps(result.get('value'), ensure_ascii=False)}" + (f"（不可序列化：{result.get('unserializable')}）" if result.get("unserializable") else "")
    return f"已 {action} target {result.get('targetId')}" + (f" · {result.get('url')}" if result.get("url") else "")
# 排版录制
def trace_text(result: dict[str, Any]) -> str:
    if result.get("action") == "status":
        return (
            f"{'录制中' if result.get('recording') else '未录制'}，已收集 {result.get('events')} 个事件"
            + (f"，剩余 {int(result.get('leftMs') or 0) // 1000}s 后自动收尾" if result.get("recording") else "")
        )
    hot = [
        f"  {item.get('name')}: {item.get('ms')}ms / {item.get('count')} 次" + (f" · {item.get('detail')}" if item.get("detail") else "")
        for item in result.get("hotspots") or []
    ]
    return "\n".join(
        [f"# 录制 {result.get('durationMs', '-')}ms · 事件 {result.get('events')} 个 · 跨度 {result.get('spanMs')}ms · 绘制 {result.get('frames')} 帧", "耗时 Top：", *(hot or ["（无可归因的耗时事件）"])]
    )
# 排版下载
def downloads_text(result: dict[str, Any]) -> str:
    action = result.get("action")
    if action == "list":
        rows = [
            f"[{item.get('id')}] {item.get('state')} {item.get('bytesReceived')}/{item.get('totalBytes')}B {item.get('filename')}"
            for item in result.get("downloads") or []
        ]
        return "\n".join([f"# 最近 {len(rows)} 条下载", *(rows or ["（无下载记录）"]), "wait 等待一条下载完成并返回本机路径。"])
    if action == "cancel":
        return f"已取消下载 {result.get('id')}"
    item = result.get("download") or {}
    return (
        f"下载{item.get('state')}：{item.get('filename')}（{item.get('bytesReceived')}/{item.get('totalBytes')}B，等待 {result.get('waitedMs')}ms）"
        + (f" · danger={item.get('danger')}" if item.get("danger") else "")
    )
# 排版扩展
def extensions_text(result: dict[str, Any]) -> str:
    action = result.get("action")
    if action == "open_options":
        return f"已用新标签页打开 {result.get('name')} 的设置页：{result.get('url')}\n页面 {result.get('pageId')}；select_page 后可继续使用 take_snapshot/click。"
    if action == "list":
        rows = [
            f"{'[自建]' if item.get('self') else '      '} [{'启用' if item.get('enabled') else '停用'}] {item.get('id')} {item.get('name')} v{item.get('version')}"
            for item in result.get("extensions") or []
        ]
        return "\n".join([f"# 已装扩展 {result.get('total')} 个", *(rows or ["（无记录）"]), "enable/disable 切换开关，open_options 用新标签页打开其设置页。"])
    return (f"{result.get('name')} v{result.get('version')} {'启用' if result.get('enabled') else '停用'}（{result.get('id')}）" + (f"\n设置页: {result.get('url')}" if result.get("url") else ""))
# // UID 定义
UID = {"type": "string", "description": 'take_snapshot 行首的 uid，形如 "5_12"，仅最近一次快照内有效'}
STR = {"type": "string"}
BOOL = {"type": "boolean"}
ARR = {"type": "array", "items": STR}
PAGED = {"pageSize": {"type": "integer", "minimum": 1, "maximum": 500}, "pageIdx": {"type": "integer", "minimum": 0}}
# 生成表壳
def input_schema(properties: dict[str, Any], required: list[str] | None = None, scoped: bool = True) -> dict[str, Any]:
    return {
      "type": "object", "properties": {"pageId": {"type": "number", "description": "仅对本次调用生效；未提供时使用 select_page 选定的页面"}, **properties} if scoped else properties,
      **({"required": required} if required else {}),
    }
# // 工具列表
# 合并工具的参数映射：MCP 面收敛为 27 个工具，扩展端方法保持不变
def _map_interact(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    action = str(arguments.get("action", "click"))
    shared = {"includeSnapshot": arguments.get("includeSnapshot", False)}
    page_id = arguments.get("pageId")
    if page_id is not None:
        shared["pageId"] = page_id
    if action == "click":
        if not arguments.get("uid"): raise BrowserError("bad_request", "interact click 需要 uid")
        return "click", {**shared, "uid": arguments.get("uid"), "button": arguments.get("button", "left"), "dblClick": arguments.get("dblClick", False)}
    if action == "hover":
        if not arguments.get("uid"): raise BrowserError("bad_request", "interact hover 需要 uid")
        return "hover", {**shared, "uid": arguments.get("uid")}
    if action == "drag":
        if not arguments.get("uid") or not arguments.get("to_uid"): raise BrowserError("bad_request", "interact drag 需要 uid 与 to_uid")
        return "drag", {**shared, "from_uid": arguments.get("uid"), "to_uid": arguments.get("to_uid"), "duration": arguments.get("duration", 200)}
    if action == "fill":
        if not arguments.get("uid"): raise BrowserError("bad_request", "interact fill 需要 uid")
        return "fill", {**shared, "uid": arguments.get("uid"), "value": arguments.get("value", "")}
    if action == "press_key":
        return "press_key", {**shared, "key": arguments.get("key", "")}
    raise BrowserError("bad_request", f"interact 仅支持 click/hover/drag/fill/press_key")

def _map_scripts(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    action = str(arguments.get("action", "list"))
    shared = {"pageId": arguments.get("pageId")}
    if action == "list":
        return "list_scripts", {**shared, "filter": arguments.get("filter", ""), "limit": arguments.get("limit", 50), "allFrames": arguments.get("allFrames", False)}
    if action == "read":
        return "read_script", {**shared, "scriptId": arguments.get("scriptId"), "url": arguments.get("url"), "fromLine": arguments.get("fromLine"), "toLine": arguments.get("toLine"), "maxChars": arguments.get("maxChars"), "filePath": arguments.get("filePath")}
    raise BrowserError("bad_request", f"scripts 仅支持 list/read")

def _map_logs(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    kind = str(arguments.get("type", "console"))
    shared = {"pageId": arguments.get("pageId"), "pageSize": arguments.get("pageSize"), "pageIdx": arguments.get("pageIdx")}
    if kind == "network":
        return "list_network_requests", {**shared, "resourceTypes": arguments.get("resourceTypes"), "includePreservedRequests": arguments.get("includePreserved", False)}
    if kind == "console":
        return "list_console_messages", {**shared, "types": arguments.get("types"), "includePreservedMessages": arguments.get("includePreserved", False), "includeStackTraces": arguments.get("includeStackTraces", False)}
    raise BrowserError("bad_request", f"logs 仅支持 network/console")

DEBUGGER_BP = {"list", "add", "remove", "clear", "activate", "deactivate", "add_listener", "remove_listener"}

def _map_debugger(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    action = str(arguments.get("action", "state"))
    shared = {"pageId": arguments.get("pageId")}
    if action in DEBUGGER_BP:
        return "handle_breakpoints", {**shared, "action": action, "url": arguments.get("url"), "scriptId": arguments.get("scriptId"), "line": arguments.get("line"), "column": arguments.get("column"), "condition": arguments.get("condition"), "breakpointId": arguments.get("breakpointId"), "eventName": arguments.get("eventName")}
    return "handle_pause", {**shared, "action": action, "frameIndex": arguments.get("frameIndex"), "function": arguments.get("function"), "exceptionState": arguments.get("exceptionState")}

UID = {"type": "string", "description": 'take_snapshot 行首的 uid，形如 "5_12"，仅最近一次快照内有效'}
STR = {"type": "string"}
BOOL = {"type": "boolean"}
ARR = {"type": "array", "items": STR}
PAGED = {"pageSize": {"type": "integer", "minimum": 1, "maximum": 500}, "pageIdx": {"type": "integer", "minimum": 0}}
# 生成表壳
def input_schema(properties: dict[str, Any], required: list[str] | None = None, scoped: bool = True) -> dict[str, Any]:
    return {
      "type": "object", "properties": {"pageId": {"type": "number", "description": "仅对本次调用生效；未提供时使用 select_page 选定的页面"}, **properties} if scoped else properties,
      **({"required": required} if required else {}),
    }
# // 工具列表
TOOLS: list[dict[str, Any]] = [
    {"name": "list_pages", "description": "列出可接管的标签页。", "schema": input_schema({}, scoped=False), "format": pages_text},
    {"name": "select_page", "description": "选定后续调用的目标页面；bringToFront 将窗口置前。", "schema": input_schema({"pageId": {"type": "number", "description": "list_pages 结果方括号内的数字"}, "bringToFront": BOOL}, ["pageId"]),
     "format": lambda r: f"已选中页面 {r.get('pageId')} · {r.get('title')}\nurl: {r.get('url')}\n已接管: {'是' if r.get('attached') else '否（首次调用会自动接管）'}"},
    {"name": "create_page", "description": "开自动化专用页并选定。默认复用上次创建的页面（导航到新 url，不重复开标签页）；mode=tab 后台标签页 / window 新窗口，focused=false 不抢焦点。", "timeout": 60.0,
     "schema": input_schema({"mode": {"type": "string", "enum": ["tab", "window"], "description": "tab=后台标签页（默认），window=新窗口"}, "url": {"type": "string", "description": "初始 url，默认 about:blank"}, "reuse": BOOL, "focused": BOOL, "left": {"type": "integer"}, "top": {"type": "integer"}, "width": {"type": "integer"}, "height": {"type": "integer"}, "active": {"type": "boolean", "description": "tab 模式是否立即激活，默认 false"}}, scoped=False),
     "format": lambda r: (
         f"已{'复用' if r.get('mode') == 'reuse' else '新建' + ('窗口' if r.get('mode') == 'window' else '标签页')}：页面 {r.get('pageId')}"
         + ("·已聚焦" if r.get("focused") else "·后台不抢焦点")
         + f"\nurl: {r.get('url')}"
     )},
    {"name": "close_page", "description": "关闭页面（缺省为当前选定）。", "schema": input_schema({"pageId": {"type": "number", "description": "要关闭的页面，缺省为当前选定页面"}}, scoped=False),
     "format": lambda r: f"已关闭页面 {r.get('closed')}（{r.get('url')}）"},
    {"name": "navigate_page", "description": "导航：url/back/forward/reload，默认等待 load。type=url 可从休眠占位页/chrome:// 页逃生。", "timeout": 130.0,
     "schema": input_schema({"type": {"type": "string", "enum": ["url", "back", "forward", "reload"]}, "url": STR, "ignoreCache": BOOL, "handleBeforeUnload": {"type": "string", "enum": ["accept", "dismiss"]}, "initScript": {"type": "string", "description": "注入到新建文档的脚本"}, "timeout": {"type": "integer"}, "includeSnapshot": BOOL}),
     "format": lambda r: f"已从 {r.get('from')} 导航到 {r.get('to')}\n标题: {r.get('title')}" + (f"\nbeforeunload: {'已放行' if r.get('beforeUnload') == 'accept' else '已取消'}" if r.get("beforeUnload") else "") + inline_snapshot(r)},
    {"name": "take_snapshot", "description": "可访问性树文本快照；行首 [序号] 即 uid，供 interact/inspect 使用。", "schema": input_schema({"verbose": BOOL, "maxNodes": {"type": "integer", "minimum": 1, "maximum": 5000, "description": "最多输出节点数，默认 400"}, "maxDepth": {"type": "integer", "minimum": 1, "maximum": 60}, "maxChars": {"type": "integer", "minimum": 1000}, "filePath": {"type": "string", "description": "写入文件而不占用返回值"}}), "format": window_text},
    {"name": "take_screenshot", "description": "截图（uid 截元素 / fullPage 整页）；窗口被遮挡时自动回退渲染器取帧。", "timeout": 60.0, "image": True,
     "schema": input_schema({"format": {"type": "string", "enum": ["png", "jpeg", "webp"]}, "quality": {"type": "integer", "minimum": 0, "maximum": 100}, "uid": UID, "fullPage": BOOL, "activate": {"type": "boolean", "description": "非前台标签页先自动激活，默认 true"}, "filePath": {"type": "string"}}),
     "format": screenshot_meta},
    {"name": "interact", "map": _map_interact, "description": "页面交互统一入口：action=click/hover/drag/fill/press_key。uid 来自最近一次 take_snapshot。", "timeout": 90.0,
     "schema": input_schema({"action": {"type": "string", "enum": ["click", "hover", "drag", "fill", "press_key"]}, "uid": UID, "to_uid": {"type": "string", "description": "drag 的目标元素"}, "value": STR, "key": {"type": "string", "description": "按键写法如 Enter、Control+A"}, "button": {"type": "string", "enum": ["left", "right", "middle"]}, "dblClick": BOOL, "duration": {"type": "integer", "description": "拖动毫秒数，默认 200"}, "includeSnapshot": BOOL}),
     "format": lambda r: f"{r.get('action', '')}: {json.dumps({k: r.get(k) for k in ('uid', 'at', 'valueLength', 'key', 'from', 'to') if r.get(k) is not None}, ensure_ascii=False)[:140]}" + inline_snapshot(r)},
    {"name": "wait_for", "description": "等待条件成立：text / selector / uid+state / function 至少一项。", "timeout": 130.0,
     "schema": input_schema({"text": {**ARR, "minItems": 1}, "selector": STR, "uid": UID, "function": {"type": "string", "description": "main world 求值为真即通过"}, "state": {"type": "string", "enum": ["visible", "attached", "hidden", "detached"]}, "timeout": {"type": "integer"}}),
     "format": lambda r: f"已等到：{' / '.join(r.get('waitedFor') or [])}（{r.get('elapsedMs')}ms）" + ("（uid 快照已作废，按已消失处理）" if r.get("uidRetired") else "")},
    {"name": "handle_dialog", "description": "应答挂起的 alert/confirm/prompt。", "schema": input_schema({"action": {"type": "string", "enum": ["accept", "dismiss"]}, "promptText": STR}, ["action"]),
     "format": lambda r: f"已{'接受' if r.get('accepted') else '取消'} {r.get('wasType')}：{r.get('message')}"},
    {"name": "upload_file", "description": "向 file input 传入本机文件（filePath 绝对路径）。", "schema": input_schema({"uid": UID, "filePath": STR, "includeSnapshot": BOOL}, ["uid", "filePath"]),
     "format": lambda r: f"已为 {r.get('uid')} 传入 {r.get('filePath')}{inline_snapshot(r)}"},
    {"name": "evaluate_script", "description": "在指定 JS world 执行函数声明并返回结果；args 传元素 uid，context 切换 world。", "timeout": 90.0,
     "schema": input_schema({"function": {"type": "string", "description": "函数声明，如 () => document.title"}, "args": {"type": "array", "items": STR, "description": "作为参数注入的元素 uid"}, "context": {"type": "string", "description": "main（默认）或 list_worlds 的 contextId"}, "dialogAction": {"type": "string", "enum": ["accept", "dismiss"]}, "waitForStableDom": BOOL, "includeSnapshot": BOOL, "filePath": {"type": "string"}}, ["function"]),
     "format": lambda r: f"返回值: {json.dumps(r.get('value'), ensure_ascii=False)}" + (f" · world: {r.get('world')}" if r.get("world") and r.get("world") != "main" else "") + (f"（不可序列化：{r.get('unserializable')}）" if r.get("unserializable") else "") + inline_snapshot(r)},
    {"name": "inspect_element", "description": "查看元素：标签/属性/盒模型/样式/事件监听/outerHTML。", "schema": input_schema({"uid": UID, "selector": {"type": "string", "description": "CSS 选择器，与 uid 二选一"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}, "htmlChars": {"type": "integer"}, "allStyles": BOOL}),
     "format": elements_text},
    {"name": "list_worlds", "description": "列出页面 JS world（main 与各扩展隔离 world）。", "schema": input_schema({}), "format": contexts_text},
    {"name": "scripts", "map": _map_scripts, "description": "页面脚本索引与源码：action=list（filter 过滤）/ read（scriptId 或 url 定位，可按行取段）。",
     "schema": input_schema({"action": {"type": "string", "enum": ["list", "read"]}, "filter": {"type": "string", "description": "url 子串过滤"}, "limit": {"type": "integer", "minimum": 1, "maximum": 500}, "allFrames": BOOL, "scriptId": {"type": "string"}, "url": STR, "fromLine": {"type": "integer", "minimum": 1}, "toLine": {"type": "integer", "minimum": 1}, "maxChars": {"type": "integer"}, "filePath": {"type": "string"}}),
     "format": lambda r: scripts_text(r) if r.get("scripts") is not None else script_text(r)},
    {"name": "logs", "map": _map_logs, "description": "网络请求或控制台日志摘要：type=network/console，分页。", "schema": input_schema({"type": {"type": "string", "enum": ["network", "console"]}, **PAGED, "resourceTypes": {**ARR, "description": "network：按资源类型过滤"}, "types": ARR, "includePreserved": BOOL, "includeStackTraces": BOOL}),
     "format": lambda r: network_text(r) if any("resourceType" in (e or {}) for e in (r.get("page") or [])) else console_text(r)},
    {"name": "debugger", "map": _map_debugger, "description": "断点与中断：action=list/add/remove/clear/activate/deactivate/add_listener/remove_listener（断点表），或 state/resume/step_over/step_into/step_out/pause/exceptions（中断现场）。", "timeout": 90.0,
     "schema": input_schema({"action": {"type": "string", "enum": ["list", "add", "remove", "clear", "activate", "deactivate", "add_listener", "remove_listener", "state", "resume", "step_over", "step_into", "step_out", "pause", "exceptions"]}, "url": {"type": "string", "description": "断点：脚本完整 url"}, "scriptId": {"type": "string"}, "line": {"type": "integer", "minimum": 1, "description": "行号从 1 起"}, "column": {"type": "integer", "minimum": 0}, "condition": STR, "breakpointId": {"type": "string"}, "eventName": {"type": "string", "description": "事件断点名，如 click、fetch"}, "frameIndex": {"type": "integer", "minimum": 0}, "function": {"type": "string", "description": "在中断帧内求值"}, "exceptionState": {"type": "string", "enum": ["none", "uncaught", "all"]}}),
     "format": lambda r: breakpoints_text(r) if any(k in r for k in ("breakpoints", "breakpointId", "watching", "removed", "active", "kept", "locations")) else pause_text(r)},
    {"name": "intercept_requests", "description": "按规则拦截改写请求：continue/abort/block/redirect/mock，默认 2 分钟自动停用。", "schema": input_schema({"action": {"type": "string", "enum": ["list", "add", "remove", "stop", "clear"]}, "match": {"type": "string", "description": "url 子串或 *"}, "ruleAction": {"type": "string", "enum": ["continue", "abort", "block", "redirect", "mock"]}, "redirectTo": STR, "status": {"type": "integer", "minimum": 100, "maximum": 599}, "contentType": STR, "body": STR, "headers": {"type": "object"}, "ttlMs": {"type": "integer"}}, ["action"]),
     "format": intercept_text},
    {"name": "list_storage", "description": "读取 cookies/local/session/IndexedDB。", "schema": input_schema({"scope": {"type": "string", "enum": ["cookies", "local", "session", "databases", "all"]}, "origin": STR}),
     "format": storage_text},
    {"name": "handle_worker", "description": "挂接 service/shared worker：list/attach/detach/console/evaluate。", "schema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["list", "attach", "detach", "console", "evaluate"]}, "targetId": {"type": "string", "description": "list 返回的前 8 位"}, "function": {"type": "string"}}, "required": ["action"]},
     "format": worker_text},
    {"name": "trace_page", "description": "性能录制并回耗时摘要。", "timeout": 90.0,
     "schema": input_schema({"action": {"type": "string", "enum": ["run", "stop", "status"]}, "durationMs": {"type": "integer", "minimum": 200, "maximum": 60000}, "categories": ARR}),
     "format": trace_text},
    {"name": "handle_downloads", "description": "下载：list/wait/cancel，wait 返回本机路径。", "timeout": 130.0,
     "schema": input_schema({"action": {"type": "string", "enum": ["list", "wait", "cancel"]}, "match": STR, "downloadId": {"type": "integer"}, "limit": {"type": "integer", "minimum": 1, "maximum": 50}, "timeout": {"type": "integer"}}, ["action"]),
     "format": downloads_text},
    {"name": "save_page", "description": "整页存档为 mhtml（含 CSS 与内联资源）。", "timeout": 90.0,
     "schema": input_schema({"filePath": {"type": "string", "description": "写入该本机路径"}}), "format": saved_text},
    {"name": "manage_extensions", "description": "管理其它扩展：list/get/enable/disable/open_options。", "schema": input_schema({"action": {"type": "string", "enum": ["list", "get", "enable", "disable", "open_options"]}, "extensionId": {"type": "string"}, "includeOtherTypes": BOOL}, ["action"]),
     "format": extensions_text},
    {"name": "set_bridge_port", "description": "读写集线器端口（改后需以同端口重启集线器）。", "schema": input_schema({"port": {"type": "integer", "minimum": 1024, "maximum": 65535}}, scoped=False), "format": config_text},
    {"name": "status", "description": "桥接状态与诊断面包屑（最近 60 条，可定位卡点）。", "schema": input_schema({}, scoped=False),
     "format": lambda r: "\n".join([f"协议 {r.get('protocol')} · 扩展 v{r.get('extensionVersion')}（{r.get('browser')}）· SW 启动于 {r.get('bootAt')}", f"选定页面: {r.get('selectedPageId')} · 已接管: {r.get('attachedTabs')} · 标签页 {len(r.get('pages') or [])} 个", *(f"  {line}" for line in (r.get('debugLog') or [])[-20:])])},
    {"name": "detach", "description": "摘除所有调试接管（「正在被调试」提示条消失）。", "schema": input_schema({}, scoped=False),
     "format": lambda r: f"已摘除 {len(r.get('detached') or [])} 个页面的接管"},
]

# // 名称索引
TOOL_BY_NAME = {tool["name"]: tool for tool in TOOLS}
# // 异步函数类型
AskFn = Callable[[str, dict[str, Any], float], Awaitable[Any]]
# // Job 元组类型
Job = tuple[str, str, dict[str, Any], float, asyncio.Future[Any]]
# 集线中枢
class Hub:
    # 构造对象
    def __init__(self, port: int, allow_any_origin: bool = False, extension_id: str | None = None) -> None:
        self.port = port
        self.allow_any_origin = allow_any_origin
        self.extension_id = extension_id or None
        self.extension: WsConnection | None = None
        self.agents: list[WsConnection] = []
        self.pending: dict[str, asyncio.Future[Any]] = {}
        self.queue: asyncio.Queue[Job] = asyncio.Queue()
        self.seq = 0
    # 排队请求
    async def ask(self, method: str, params: dict[str, Any], timeout: float = DEFAULT_TIMEOUT) -> Any:
        self.seq += 1
        request_id = f"own{self.seq}"
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self.pending[request_id] = future
        await self.queue.put((request_id, method, params, timeout, future))
        try:
            await asyncio.wait_for(asyncio.shield(future), timeout + 5)
            return future.result()
        except asyncio.TimeoutError:
            self.pending.pop(request_id, None)
# // 取消任务
            future.cancel()
            raise BrowserError("timeout", f"扩展在 {timeout}s 内未回应 {method}") from None
    # 串行下发
    async def pump(self) -> None:
        while True:
            request_id, method, params, timeout, future = await self.queue.get()
            extension = self.extension
            if extension is None:
                if not future.done():
                    future.set_exception(BrowserError("extension_offline", OFFLINE_HINT))
                continue
            try:
                await extension.send({"t": "req", "id": request_id, "method": method, "params": params, "timeoutMs": timeout * 1000})
            except WsError as error:
                if not future.done():
                    future.set_exception(BrowserError("extension_offline", str(error)))
                continue
            await asyncio.wait({future})
    # 定时保活
    async def heartbeat(self) -> None:
        while True:
            await asyncio.sleep(20.0)
            if self.extension: self.extension.ping()
    # 作废待答
    def fail_pending(self, code: str, message: str) -> None:
        for future in self.pending.values():
            if not future.done():
                future.set_exception(BrowserError(code, message))
        self.pending.clear()
    # 接受连接
    async def accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            path, headers = await read_http_headers(reader)
        except (WsError, ValueError, asyncio.IncompleteReadError):
            writer.close()
            return
        if path.rstrip("/") == "/agents":
            await self._agent(reader, writer, headers)
        else:
            await self._extension(reader, writer, headers)
    # 服务扩展
    async def _extension(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, headers: dict[str, str]) -> None:
        origin = headers.get("origin", "")
        # 浏览器对扩展发起的 WebSocket 固定携带 chrome-extension:// 扩展ID 形式的 Origin；
        # 未打包扩展的实际 ID 随浏览器与版本可能偏离 manifest.key 的推导值，故默认接受任意扩展来源并记录。
        if not origin.startswith("chrome-extension://") and not self.allow_any_origin:
            log(f"接入失败：Origin {origin or '未知来源'} 不是 chrome-extension:// 扩展来源")
            writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        if self.extension_id and not origin.startswith(f"chrome-extension://{self.extension_id}"):
            log(f"接入失败：Origin {origin} 与 --extension-id {self.extension_id} 不符")
            writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        if not await accept_handshake(reader, writer, headers):
            writer.close()
            return
        connection = WsConnection(reader, writer, masked_out=False)
        hello = await read_hello(connection)
        if hello is None:
            await connection.close()
            return
        if self.extension is not None:
            await self.extension.close()
        self.extension = connection
        log(f"扩展接入：{hello.get('browser')} v{hello.get('version')} · 来源 {origin}")
        try:
            while True:
                frame = await connection.receive()
                if frame is None:
                    break
                kind = frame.get("t")
                if kind == "evt":
# // 事件日志
                    log(f"扩展事件：{frame.get('name')} {json.dumps(frame.get('payload') or {}, ensure_ascii=False)}")
                    continue
                if kind != "res":
                    continue
                future = self.pending.pop(str(frame.get("id", "")), None)
                if future is None or future.done():
                    continue
                if frame.get("ok"):
                    future.set_result(frame.get("result"))
                else:
                    error = frame.get("error") or {}
                    future.set_exception(BrowserError(error.get("code", "failed"), error.get("message", "扩展未给出原因")))
        finally:
            if self.extension is connection:
                self.extension = None
                log("扩展断开")
            self.fail_pending("extension_offline", "扩展连接已断开")
            await connection.close()
    # 服务门面
    async def _agent(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, headers: dict[str, str]) -> None:
        if not await accept_handshake(reader, writer, headers):
            writer.close()
            return
        connection = WsConnection(reader, writer, masked_out=False)
        if await read_hello(connection) is None:
            await connection.close()
            return
        self.agents.append(connection)
        log(f"MCP 会话接入，共 {len(self.agents)} 个")
        try:
            while True:
                frame = await connection.receive()
                if frame is None:
                    break
                if frame.get("t") != "req":
                    continue
                timeout = float(frame.get("timeoutMs") or DEFAULT_TIMEOUT * 1000) / 1000.0
                try:
                    result = await self.ask(str(frame.get("method", "")), frame.get("params") or {}, timeout)
                    await connection.send({"t": "res", "id": frame.get("id"), "ok": True, "result": result})
                except BrowserError as error:
                    await connection.send({"t": "res", "id": frame.get("id"), "ok": False, "error": {"code": error.code, "message": error.message}})
        finally:
            if connection in self.agents:
                self.agents.remove(connection)
                log(f"MCP 会话断开，剩余 {len(self.agents)} 个")
            await connection.close()
# 记录日志
def log(message: str) -> None:
    print(f"[browseruse] {message}", file=sys.stderr, flush=True)
# 接入门面
class AgentClient:
    # 构造对象
    def __init__(self) -> None:
        self.connection: WsConnection | None = None
        self.pending: dict[str, asyncio.Future[Any]] = {}
        self.seq = 0
        self.pump_task: asyncio.Task[None] | None = None
    # 建立连接
    async def connect(self, port: int) -> None:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        await client_handshake(reader, writer, "/agents", port)
        self.connection = WsConnection(reader, writer, masked_out=True)
        await self.connection.send({"t": "hello", "role": "extension", "protocol": PROTOCOL_VERSION, "version": VERSION})
        self.pump_task = asyncio.create_task(self._pump())
    # 接收响应
    async def _pump(self) -> None:
        assert self.connection is not None
        while True:
            frame = await self.connection.receive()
            if frame is None:
                return
            if frame.get("t") != "res":
                continue
            future = self.pending.pop(str(frame.get("id", "")), None)
            if future is None or future.done():
                continue
            if frame.get("ok"):
                future.set_result(frame.get("result"))
            else:
                error = frame.get("error") or {}
                future.set_exception(BrowserError(error.get("code", "failed"), error.get("message", "")))
    # 排队请求
    async def ask(self, method: str, params: dict[str, Any], timeout: float = DEFAULT_TIMEOUT) -> Any:
        if self.connection is None:
            raise BrowserError("host_offline", "尚未连上集线器")
        self.seq += 1
        request_id = f"c{self.seq}"
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self.pending[request_id] = future
        try:
            await self.connection.send({"t": "req", "id": request_id, "method": method, "params": params, "timeoutMs": timeout * 1000})
            return await asyncio.wait_for(future, timeout + 10)
        except asyncio.TimeoutError:
            self.pending.pop(request_id, None)
            raise BrowserError("timeout", f"{method} 在 {timeout}s 内未完成") from None
        except WsError as error:
            self.pending.pop(request_id, None)
            raise BrowserError("host_offline", str(error)) from None
    # 关闭连接
    async def close(self) -> None:
        if self.pump_task:
            self.pump_task.cancel()
        if self.connection:
            await self.connection.close()
# 用完即断
@asynccontextmanager
# 取用会话
async def session(port: int) -> AsyncIterator[AgentClient]:
    client = AgentClient()
    await client.connect(port)
    try:
        yield client
    finally:
        await client.close()
# 同步门面
class Bridge:
    # 构造对象
    def __init__(self, port: int = DEFAULT_PORT) -> None:
        self.port = port
    # 调用一次
    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = DEFAULT_TIMEOUT) -> Any:
        # 执行协程
        async def run() -> Any:
            async with session(self.port) as client:
                return await client.ask(method, params or {}, timeout)
# // 桥接调用
        return asyncio.run(run())
    # 排版调用
    def tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        # 执行协程
        async def run() -> dict[str, Any]:
            async with session(self.port) as client:
                return await handle_tool(client.ask, name, arguments or {})
# // MCP 工具调用
        return asyncio.run(run())
TYPES: dict[str, tuple[type, ...]] = {"string": (str,), "number": (int, float), "integer": (int,), "boolean": (bool,), "array": (list,), "object": (dict,)}
# 校验参数
def validate_arguments(tool: dict[str, Any], arguments: dict[str, Any]) -> str | None:
    schema = tool.get("schema") or {}
    properties = schema.get("properties") or {}
    for key in schema.get("required") or []:
        value = arguments.get(key)
        if value is None or value == "":
            return f"缺少必填参数 {key}（{((properties.get(key) or {}).get('description')) or '见工具说明'}）"
    for key, value in arguments.items():
        spec = properties.get(key)
        if spec is None:
            return f"未知参数 {key}；本工具接受：{', '.join(properties) or '（无参数）'}"
        expected = TYPES.get(str(spec.get("type", "")))
        if expected is not None and not isinstance(value, expected):
            return f"参数 {key} 类型应为 {spec.get('type')}"
        allowed = spec.get("enum")
        if allowed and value not in allowed:
            return f"参数 {key} 只能是 {' / '.join(map(str, allowed))}"
    return None
# 执行工具
async def handle_tool(ask: AskFn, name: str, arguments: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
    tool = TOOL_BY_NAME.get(name)
    if tool is None:
        return error_result("unsupported", f"未知工具 {name}")
    invalid = validate_arguments(tool, arguments)
    if invalid:
        return error_result("bad_request", invalid)
    file_path = arguments.get("filePath")
    if name == "upload_file" and isinstance(file_path, str) and not os.path.isfile(file_path):
        return error_result("file_not_found", f"本地文件不存在：{file_path}")
    send_name, send_params = name, arguments
    mapper = tool.get("map")
    if mapper is not None:
        try:
            send_name, send_params = mapper(arguments)
        except BrowserError as error:
            return error_result(error.code, error.message)
    try:
        wait = float(timeout) if timeout is not None else float(tool.get("timeout", DEFAULT_TIMEOUT))
        result = await ask(send_name, send_params, wait)
    except BrowserError as error:
        return error_result(error.code, error.message)
    except asyncio.TimeoutError:
        return error_result("timeout", f"{name} 超时")
    if not isinstance(result, dict):
        result = {}
    if isinstance(file_path, str) and name in {"take_screenshot", "take_snapshot", "evaluate_script", "read_script", "save_page"}:
        write_out(name, file_path, result)
    return tool_result(tool, result)
# 封装结果
def tool_result(tool: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "text", "text": tool["format"](result)}]
    if tool.get("image") and result.get("base64"):
        content.append({"type": "image", "data": result["base64"], "mimeType": f"image/{result.get('format', 'png')}"})
    return {"content": content}
# 封装错误
def error_result(code: str, message: str) -> dict[str, Any]:
    body = json.dumps({"error": {"code": code, "message": message}}, ensure_ascii=False)
    return {"content": [{"type": "text", "text": body}], "isError": True}
# 写出文件
def write_out(name: str, path: str, result: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if name == "take_screenshot" and result.get("base64"):
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(result["base64"]))
        return
    if name == "save_page":
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(str(result.get("mhtml") or ""))
        return
    if name in ("read_script", "scripts"):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(f"// {result.get('url')}\n" + str(result.get("source") or ""))
        return
    body = window_text(result) if name == "take_snapshot" else json.dumps(result.get("value"), ensure_ascii=False)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(body)
# 发送消息
def write_message(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()
# 门面收发
async def serve_stdio(ask: AskFn) -> None:
    while True:
        raw = await asyncio.to_thread(sys.stdin.buffer.readline)
        if not raw:
            return
        try:
            request = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            continue
        method = request.get("method")
        request_id = request.get("id")
        if method == "initialize":
            write_message(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                      "protocolVersion": (request.get("params") or {}).get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                      "serverInfo": {"name": "browser-use", "version": VERSION}, "instructions": INSTRUCTIONS,
                    },
                }
            )
        elif method in ("notifications/initialized", "notifications/cancelled"):
            continue
        elif method == "tools/list":
            write_message(
                { "jsonrpc": "2.0", "id": request_id, "result": { "tools": [{"name": tool["name"], "description": tool["description"], "inputSchema": tool["schema"]} for tool in TOOLS]}}
            )
        elif method == "tools/call":
            params = request.get("params") or {}
            write_message({"jsonrpc": "2.0", "id": request_id, "result": await handle_tool(ask, str(params.get("name", "")), params.get("arguments") or {})})
        elif method == "ping":
            write_message({"jsonrpc": "2.0", "id": request_id, "result": {}})
        elif request_id is not None:
            write_message({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"不支持的方法 {method}"}})
# 占用端口
async def own_the_port(hub: Hub, serve_only: bool) -> None:
    server = await asyncio.start_server(hub.accept, "127.0.0.1", hub.port)
    tasks = [asyncio.create_task(hub.pump()), asyncio.create_task(hub.heartbeat())]
    log(f"监听 ws://127.0.0.1:{hub.port}/ ，{len(TOOLS)} 个工具就绪")
    async with server:
        if serve_only:
            await server.serve_forever()
        else:
            await serve_stdio(hub.ask)
    for task in tasks:
        task.cancel()
# 接入已有
async def join_existing(port: int) -> None:
    log("降级为 agent：接入已有集线器的浏览器通道，本进程只提供 stdio 门面")
    async with session(port) as client:
        await serve_stdio(client.ask)
# 一次调用
def one_shot(method: str, params: dict[str, Any], port: int, timeout: float = 60.0) -> int:
    # 执行协程
    async def run() -> Any:
        async with session(port) as client:
            # 走 handle_tool 以对齐 MCP 行为：参数校验 + filePath 落盘 + 文案排版
            return await handle_tool(client.ask, method, params, timeout)
# // accept_handshake
    try:
        print(json.dumps(asyncio.run(run()), ensure_ascii=False, indent=2))
        return 0
    except BrowserError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 1
    except (OSError, WsError) as error:
# // 解析参数
# // WsError 异常
        print(
            f"host_offline: 127.0.0.1:{port} 上没有集线器（{error}）。"
            f"先运行 python browseruse.py --serve-only --port {port} 常驻，或直接运行 python browseruse.py 由该 MCP 会话持有端口。",
            file=sys.stderr,
        )
        return 1
# 程序入口
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="BrowserUse 本地侧：WebSocket 集线器 + MCP stdio server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"扩展接入的固定端口，默认 {DEFAULT_PORT}")
    parser.add_argument("--serve-only", action="store_true", help="仅作为常驻集线器，不接管 stdio MCP")
    parser.add_argument("--allow-any-origin", action="store_true", help="不校验 Origin（调试用）")
    parser.add_argument("--extension-id", default=None, help="只接受指定 ID 的扩展接入（默认接受任意 chrome-extension:// 来源）")
    parser.add_argument("--call", metavar="METHOD", help="调用一次扩展方法后退出，配合 --params 传参")
    parser.add_argument("--params", default="{}", help="JSON 参数")
    parser.add_argument("--timeout", type=float, default=60.0, help="--call 的等待上限，默认 60 秒")
    arguments = parser.parse_args(argv)
# // 解析参数
    if arguments.call:
        return one_shot(arguments.call, json.loads(arguments.params), arguments.port, arguments.timeout)
# // 单次调用
    hub = Hub(arguments.port, arguments.allow_any_origin, arguments.extension_id)
    try:
        asyncio.run(own_the_port(hub, arguments.serve_only))
    except OSError as error:
# // 端口失败
        log(f"端口绑定失败：{arguments.port}（{error}）；改走接入已有集线器")
        try:
            asyncio.run(join_existing(arguments.port))
        except (OSError, WsError, BrowserError) as join_error:
            print(f"{getattr(join_error, 'code', 'host_offline')}: {join_error}", file=sys.stderr)
            return 1
    except KeyboardInterrupt:
        pass
    return 0
if __name__ == "__main__":
    sys.exit(main())
