# BrowserUse

**一个供 MCP 客户端使用的浏览器桥接扩展**  
Chrome/Edge 扩展 + Python 固定端口集线器

---

## ⭐ 项目支持

如果这个项目对您有帮助，请给我一个 ⭐️ Star！

**👥 用户交流 & 问题反馈**：[QQ 群：855571352](https://jq.qq.com/?_wv=1027&k=example)

---

## 📌 功能说明

### 核心能力

- **页面接管（Attach）**：通过 CDP（Chrome DevTools Protocol）控制浏览器标签页
- **元素快照**：基于 accessibility tree 的元素树快照，使用 `uid` 精确定位交互对象
- **自动化操作**：点击、悬停、拖拽、输入、按键、文件上传
- **导航控制**：URL 跳转、前进/后退、刷新，可处理 beforeunload 弹窗
- **网络调试**：请求/响应拦截、日志记录、存储读写（cookies/localStorage/sessionStorage/indexedDB）
- **脚本执行**：在指定执行上下文（world）中运行 JS，支持传入 uid 参数
- **调试器集成**：断点管理、暂停控制、调用栈查看、worker 挂接
- **性能录制**：trace_page 采集性能数据
- **扩展管理**：列出、启用/禁用其它扩展
- **下载监控**：列表、等待完成、取消下载

### 工具清单

| 类别 | 方法 |
|------|------|
| **状态查询** | `status`, `list_pages`, `select_page` |
| **页面导航** | `navigate_page`, `save_page` |
| **交互操作** | `click`, `hover`, `drag`, `fill`, `press_key`, `upload_file` |
| **截图与快照** | `take_screenshot`, `take_snapshot`, `inspect_element` |
| **等待机制** | `wait_for`（文本/元素/函数条件） |
| **弹窗处理** | `handle_dialog`（alert/confirm/prompt/beforeunload） |
| **脚本执行** | `evaluate_script`（支持多个 world） |
| **调试器** | `handle_breakpoints`, `handle_pause`, `list_scripts`, `read_script` |
| **网络** | `intercept_requests`, `list_network_requests`, `list_console_messages`, `list_storage` |
| **后台任务** | `handle_worker`（service worker 挂接） |
| **性能** | `trace_page` |
| **其他** | `manage_extensions`, `handle_downloads`, `detach` |

共计 **36 个工具方法**，覆盖浏览器控制的完整链路。

---

## 🔧 安装步骤

### 前置条件

- **Node.js** ≥ 18.x（构建用）
- **Python 3.10+**（MCP 集线器用）
- **Chrome / Edge** 浏览器（支持 CDP）

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
   - 打开浏览器地址栏：`chrome://extensions/`（或 `edge://extensions/`）
   - 开启右上角 **"开发者模式"**
   - 点击 **"加载已解压缩的扩展程序"**
   - 选择项目中生成的 `dist/` 目录

4. **启动 MCP 服务器**（可选）

   ```bash
   npm run mcp
   ```

   或仅启动 WebSocket 监听：

   ```bash
   npm run serve
   ```

---

## 🤖 AI Agent 提示词

```text
你是一个浏览器自动化助手，当前需要安装 BrowserUse 扩展来接管浏览器。请按以下步骤操作：

【环境检查】
1. 确认本机已安装 Node.js 18+ 和 Python 3.10+
2. 确认已安装 Chrome 或 Edge 浏览器

【安装流程】
1. 克隆仓库：`git clone https://github.com/YisRime/BrowserUse.git && cd BrowserUse`
2. 安装依赖并构建：`npm install && npm run build`
3. 打开浏览器，访问 chrome://extensions/（Edge 为 edge://extensions/）
4. 开启"开发者模式"，点击"加载已解压缩的扩展程序"
5. 选择当前项目根目录下的 `dist` 文件夹

【验证安装】
- 浏览器扩展列表应显示 "BrowserUse"
- 扩展图标右下角应出现蓝色角标 "on"（表示 WebSocket 连接正常）
- 运行 `npm run mcp` 测试 MCP 服务器是否正常
```
