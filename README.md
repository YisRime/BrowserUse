# BrowserUse

**一个供 MCP 客户端使用的浏览器桥接扩展**  
Chrome/Edge 扩展 + Python 集线器（WebSocket 固定端口 + MCP stdio）

在你的**真实浏览器**里完成自动化：接管已登录会话的标签页，读取可访问性树、点击/填表/截图/存档/抓接口——数据不出本机。

---

## ⭐ 项目支持

如果这个项目对您有帮助，请给我一个 ⭐️ Star！

**👥 用户交流 & 问题反馈**：[QQ 群：855571352](https://jq.qq.com/?_wv=1027&k=example)

---

## 📌 功能说明

### 核心能力

- **页面接管（Attach）**：通过 CDP（Chrome DevTools Protocol）控制标签页；后台标签页、休眠标签页（Auto Tab Discard 等）自动唤醒
- **元素快照**：基于 accessibility tree 的文本快照，行首 `uid` 精确定位交互对象，支持 maxNodes/maxDepth/maxChars 预算控制
- **统一交互**：`interact` 一个工具覆盖 click / hover / drag / fill / press_key，派发真实输入事件（`isTrusted=true`）
- **导航控制**：URL / 前进 / 后退 / 刷新，可处理 beforeunload 确认框，可从休眠占位页逃生
- **大响应完整回传**：WS 分片帧重组，整页截图（数百 KB base64）与 mhtml 存档不再丢失
- **遮挡可用**：窗口被遮挡时截图自动回退渲染器取帧
- **网络调试**：请求拦截改写（mock / redirect / abort）、网络与控制台日志（`logs`）、存储读取（cookies / localStorage / IndexedDB）
- **脚本执行**：在任意 JS world（含扩展隔离 world）执行函数，支持元素 uid 注参
- **调试器集成**：断点 / 事件断点 / 调用栈与变量查看 / worker 挂接（`debugger`、`handle_worker`）
- **页面复用**：`create_page` 默认复用同一个自动化专用页，不重复开标签页、不抢焦点
- **性能录制**：`trace_page` 采集并归耗时 Top
- **诊断自包含**：`status` 输出 SW 启动时间与最近 60 条调试面包屑，无需调试端口即可定位卡点

### 工具清单（27 个）

| 类别 | 工具 |
|------|------|
| **页面管理** | `list_pages`, `select_page`, `create_page`（默认复用专用页）, `close_page`, `detach` |
| **导航与观察** | `navigate_page`, `take_snapshot`, `take_screenshot`, `inspect_element`, `save_page` |
| **交互** | `interact`（click/hover/drag/fill/press_key）, `upload_file`, `handle_dialog`, `wait_for` |
| **脚本** | `evaluate_script`, `scripts`（list/read）, `list_worlds` |
| **调试** | `debugger`（断点表 + 中断现场）, `handle_worker`, `trace_page` |
| **网络与存储** | `logs`（network/console）, `intercept_requests`, `list_storage` |
| **浏览器周边** | `handle_downloads`, `manage_extensions` |
| **桥接自身** | `status`, `set_bridge_port` |

---

## 🔧 安装步骤

### 前置条件

- **Node.js** ≥ 18.x（构建用）
- **Python 3.10+**（集线器 / MCP server）
- **Chrome / Edge** 浏览器

> ⚠️ Chrome 136+ 已忽略 `--load-extension` 启动参数，请按下方步骤在 `chrome://extensions` 手动加载（Edge 仍兼容该参数）。

### 从源码安装

1. **克隆仓库**

   ```bash
   git clone https://github.com/YisRime/BrowserUse.git
   cd BrowserUse
   ```

2. **安装依赖并构建**

   ```bash
   npm install
   npm run build
   ```

3. **加载到浏览器**
   - 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
   - 开启右上角 **"开发者模式"**
   - 点击 **"加载已解压缩的扩展程序"**
   - 选择项目中生成的 **`.output/chrome-mv3`** 目录（Edge 用 `.output/edge-mv3`）

4. **接入 MCP 客户端**

   ```bash
   python browseruse.py
   ```

   该命令同时做两件事：在 `127.0.0.1:8712` 监听扩展的 WebSocket，并以 stdio 方式提供 MCP 服务（tools/list 返回 27 个工具）。把它注册进任意 MCP 客户端即可：

   ```json
   { "command": "python", "args": ["D:\\path\\to\\BrowserUse\\browseruse.py"] }
   ```

   多客户端共存：第一个进程持有端口，后续进程自动降级为"接入已有集线器"。也可以只常驻集线器：

   ```bash
   python browseruse.py --serve-only        # 仅监听扩展
   python browseruse.py --call list_pages   # 单次调用验证链路
   ```

---

## 🤖 AI Agent 提示词

```text
你是一个浏览器自动化助手，当前需要安装 BrowserUse 扩展来接管浏览器。请按以下步骤操作：

【环境检查】
1. 确认本机已安装 Node.js 18+ 和 Python 3.10+
2. 确认已安装 Chrome 或 Edge 浏览器

【安装流程】
1. 克隆仓库：git clone https://github.com/YisRime/BrowserUse.git && cd BrowserUse
2. 安装依赖并构建：npm install && npm run build
3. 打开浏览器访问 chrome://extensions/，开启"开发者模式"
4. 点击"加载已解压缩的扩展程序"，选择项目下的 .output/chrome-mv3 目录
5. 常驻集线器：python browseruse.py --serve-only（或直接注册为 MCP server）

【验证安装】
- chrome://extensions 列表显示 "BrowserUse"，工具栏图标出现蓝色角标 "on"
- 运行 python browseruse.py --call status 查看桥接状态与诊断信息
- 若连接失败，运行 python browseruse.py --call status 按提示排查；扩展与集线器版本需一致
```
