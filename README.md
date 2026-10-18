# Codex Local Bridge

**v0.7.2 · 服务 0.7.0 · Figma runtime v10 · MIT · 独立社区项目 / Unofficial community project**

让支持 MCP 的本地助手连接 Figma Desktop，读取文档、编辑原生图层与组件、检查布局并导出 PNG/SVG。无需 Figma API 密钥，运行时无 npm 第三方依赖。不是 OpenAI 或 Figma 官方插件，也不属于其认证产品。

> 本机服务无身份鉴权，只绑定回环地址，默认在 localhost:37821–37828 发现服务。本机程序可以读写接入的文件；页面绑定用于路由和冲突隔离，来源检查不是身份认证。参阅 [安全说明](SECURITY.md)、[隐私说明](PRIVACY.md) 和 [免责声明](DISCLAIMER.md)。重要设计保留版本历史。

## 本次更新

- 多个 AI 分别绑定页面或独占文件，拒绝跨页面写入，显示任务和执行进度。
- 一个统一主控窗口管理接入文件，其他窗口使用精简状态条；支持切换主控、刷新和删除断线记录。
- dry-run、幂等写入、结果查询、结构化 diff、受支持批次的回滚和冲突保护撤销。
- 可编辑面板、KPI、折线图、环图、示意地图、组件、变量与自动布局构建，以及布局检查、截图审阅和有界修复。
- 端口自动发现、同配置单实例、独立连接配置、兼容性检查，以及在已有文件中创建页面。

本地 0.4.x–0.7.1 的变化合并到本次公开发布，没有补造中间版本的 GitHub Release。

## 安装与启动

1. 安装 Node.js 22 或更新的受支持版本，确保 node 在 PATH 中。
2. 下载 [最新 Release](https://github.com/mengkong30/codex-local-bridge/releases/latest) 的 ZIP，按同页 SHA256SUMS.txt 校验；也可克隆仓库。保留目录结构。
3. Agent Plugins 客户端使用根目录 plugin.json 和 mcp.json；旧 Codex 客户端可使用 .codex-plugin/plugin.json 和 .mcp.json。PLUGIN_ROOT 由宿主展开；本仓库不会修改全局配置。
4. 普通 MCP 客户端使用下面的配置，将路径替换为本机实际绝对路径。
5. 在 Figma Desktop 的 Plugins → Development → Import plugin from manifest 导入本包 figma/manifest.json，运行并保持窗口打开。每个目标文件都需要运行插件。
6. 调用 local_figma_connect 并回读目标文档。服务运行不等于文件已连接；写入前先 local_figma_bind。

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

Windows JSON 路径可用正斜杠，如 C:/path/to/codex-local-bridge/mcp-server.mjs。宿主找不到 node 时，指定实际 Node 可执行文件路径。发布 ZIP 包含生成的 code.js，导入前无需安装依赖或构建。

MCP 调用可自动启动后台服务；需要明确生命周期时，也可在终端运行 `node bridge-server.mjs`，结束时按 Ctrl+C 并关闭 Figma 插件。自动启动的服务可能在助手会话结束后保留；不要按端口盲目结束未知进程。

## 从 v0.3.0 升级

关闭旧 Figma 插件实例，停止已确认归属的旧桥接服务，更新宿主插件包；重新导入本版 manifest，再在每份文件中打开插件。旧实例不会自动加载新代码。

核对插件包 **0.7.2**、`/health.serverVersion` 为 **0.7.0**、`bridge-capabilities.version` 为 **10**。三个版本号代表不同组件。默认发现端口为 37821–37828；范围外端口需要同步修改开发 manifest。

## 工具与协议

提供 16 个 MCP 工具：连接/状态/设置，文档/页面/图层/导出，绑定/释放，结构化命令、创建页面、操作查询、撤销、布局检查、截图审阅与修复。没有任意 JavaScript 执行接口。

- [控制协议](CONTROLLERS.md)：AI 身份、页面/文件绑定、目标隔离与执行进度。
- [主控面板](HUB.md)：主控、精简条、断线记录与显示切换。
- [可靠写入](RELIABILITY.md)：dry-run、幂等键、批次回滚、diff、撤销与恢复限制。
- [高层构建](DSL.md)、[布局检查](LAYOUT.md) 与 [视觉复检](VISUAL-REVIEW.md)。
- [连接设置](CONNECTIONS.md) 与 [HTTP API](docs/API.md)。

同一文件连接串行，不同文件可并行；没有跨文件事务。操作已派发后超时不代表失败，先查询结果并核对画布，不能盲目重放。幂等结果只在原服务实例和保留期内有效。回滚与撤销仅覆盖明确支持的操作。

命令行适配器可运行 `node adapters/dsh-bridge.mjs help` 查看用法。新建 Figma 文件不受支持，可在已有文件内使用独占文件绑定创建页面。

## 开发与验证

```sh
npm run check
npm test
npm run scan
```

默认检查和测试只使用 Node 内置模块、隔离端口、合成数据、模拟 Figma API 与 JSON-RPC，无需打开真实设计。修改 figma/runtime-*.js 或 figma/code-main.js 后运行 `npm run build`；检查会验证生成的 figma/code.js 是否同步。

可选 UI 测试需要 Playwright 开发依赖与 Chromium：`npm install`、`npx playwright install chromium`、`npm run test:ui`。详情、覆盖范围及真实文件烟测步骤见 [验证说明](docs/TESTING.md)。模拟通过不证明所有 Figma API 或宿主版本兼容。

## 许可与反馈

[MIT](LICENSE) 适用于有权许可的代码和文本；第三方软件、字体、设计与商标不由此取得授权。[免责声明](DISCLAIMER.md) 不为 MIT 增加许可限制。

公开包不含真实设计、项目截图、账号配置、第三方字体或 AI 模型额度。若助手使用云端模型，设计内容可能离开本机；本地桥接不代表整个 AI 工作流离线。

反馈请提供版本号和脱敏的最小复现，不要附带密钥、客户设计、文件 key、连接信息或个人路径。安全问题按 [SECURITY.md](SECURITY.md) 处理。
