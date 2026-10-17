# Codex Local Bridge

**v0.3.0 · MIT · 独立社区项目 / Unofficial community project**

让本地支持 MCP 的助手连接 Figma Desktop，读取文档、页面和选区，编辑原生图层/组件，并导出 PNG/SVG。无需 Figma API 密钥，无 npm 运行依赖。不是 OpenAI 或 Figma 官方插件，也不属于其认证产品。

> **本地服务无身份鉴权，监听 localhost:37821。能访问本机服务的程序可读写已连接文件。来源检查不是身份验证。请先阅读 [安全说明](SECURITY.md)、[隐私说明](PRIVACY.md) 和 [免责声明](DISCLAIMER.md)，重要设计先复制或保留版本历史。**

## 安装与启动

1. 安装 Node.js 22 或更新的受支持版本，并确保 `node` 在 PATH 中。
2. 下载 Release ZIP 并校验同页 SHA256SUMS，或克隆本仓库。保留目录结构。
3. 支持 Agent Plugins 的客户端使用根目录 `plugin.json` 和 `mcp.json`；旧 Codex 客户端可使用 `.codex-plugin/plugin.json` 和 `.mcp.json`。`${PLUGIN_ROOT}` 必须由宿主展开。不同宿主安装入口不同，本仓库不自动修改你的全局配置。
4. 若宿主只支持普通 MCP 配置，使用下例，**将目录替换为实际绝对路径**。`PLUGIN_ROOT` 是插件宿主变量，不是 Node 自动展开的系统变量。
5. 在 Figma Desktop 中选择 Plugins → Development → Import plugin from manifest，导入本仓库 `figma/manifest.json`，运行插件并保持窗口打开。
6. 调用 `local_figma_connect`。只有成功回读目标文档才算连接完成；服务运行不代表文件已连接。

```json
{
  "mcpServers": {
    "codex-local-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/codex-local-bridge/mcp-server.mjs"]
    }
  }
}
```

Windows JSON 路径可用正斜杠，如 `C:/path/to/codex-local-bridge/mcp-server.mjs`。若宿主无法找到 node，将 command 改成你实际的 Node 可执行文件路径，不要复制别人的用户目录。

MCP 调用可自动启动服务。手动启动和停止便于管理：

```sh
node bridge-server.mjs
# 在该终端按 Ctrl+C 停止；Figma 侧也应关闭插件窗口。
```

自动启动的后台进程可能在助手会话结束后继续运行。不要按端口盲目终止未知进程；需要确定生命周期时采用手动启动方式。升级后重启服务、重新导入对应 manifest，并在每个文件中重开插件，确认 `/health.serverVersion` 与 `bridge-capabilities.version`。

## 工具和能力

六个 MCP 工具均为读取/导出：`local_figma_connect`、`local_figma_status`、`local_figma_document`、`local_figma_pages`、`local_figma_node`、`local_figma_export`。

本地 HTTP `/command` 另支持结构化写入、导入图片与设计系统操作。没有任意 JavaScript 执行接口。详细边界见 [API](docs/API.md)。创建字体、页面、变量与组件可能直接修改当前文件；设计系统操作不是全局事务。

每份文件分别运行插件。连接列表返回 connectionId，多连接时必须显式指定，不能猜目标。同一连接串行，不同连接可并行；无跨文件事务。连接 ID 是路由标识，**不是密码**。

读超时默认15秒；构建、设计系统、导入图片和导出60秒。已派发超时会锁定该连接，等待迟到结果。先核对 `/health` 中 progress、lastResult 和画布，不要直接重放写入；重启不撤销已执行的修改。

## 验证与已知限制

```sh
npm run check
npm test
```

测试使用本机隔离测试端口、模拟 Figma API 和 JSON-RPC，不需要打开设计文件，不导出真实设计。它们覆盖连接隔离、超时锁定/恢复、回传重试、字体预加载、构建回滚、来源/请求体限制及 MCP 行为；不证明所有 Figma API 或宿主版本均兼容。`docs/TESTING.md` 说明真实文件的人工烟测方法。

不包含设计项目截图、源设计、账号配置、第三方字体、AI 模型或服务额度。读取内容若交给云端助手处理，可能离开本机；“本地桥接”不等于整个 AI 工作流离线。详见 [隐私说明](PRIVACY.md)。

## 许可、贡献和反馈

[MIT License](LICENSE) 适用于有权许可的仓库代码与文本；第三方软件、字体、设计和商标不由此取得授权。[免责声明](DISCLAIMER.md) 不为 MIT 增加许可限制。

欢迎提交公开的最小复现及版本号。不要在 Issue、日志或截图中附带密钥、客户设计、文件 key、连接信息或个人路径。安全问题先按 [SECURITY.md](SECURITY.md) 处理。改动后运行测试，不要提交真实设计数据。
