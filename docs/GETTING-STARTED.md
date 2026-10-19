# 安装、连接与升级

[返回首页](../README.md)

## 准备

- Figma Desktop，打开你有权修改的 文件。
- Node.js 22 或更新的受支持版本，node 可以从 PATH 启动。
- 支持本地 stdio MCP 的 AI 客户端。插件本身不包含 AI 模型或服务额度。

## 下载

从 [Releases](https://github.com/mengkong30/codex-local-bridge/releases/latest) 下载 ZIP，按同页 SHA256SUMS.txt 核对校验值，解压并保留目录结构。发布包含已生成的 Figma 代码，无需 npm install 或构建即可运行。

## 连接 AI 客户端

支持 Agent Plugins 的宿主使用根目录 plugin.json 和 mcp.json；兼容旧 Codex 格式的宿主可使用 .codex-plugin/plugin.json 和 .mcp.json。不同宿主的安装入口不同，仓库不会修改全局配置。配置中的 PLUGIN_ROOT 由插件宿主展开，Node 不会自动展开它。

仅支持普通 MCP 的客户端可使用：

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

将路径换成本机实际位置。Windows JSON 路径可用正斜杠，例如 C:/path/to/codex-local-bridge/mcp-server.mjs。宿主找不到 node 时，将 command 换成实际 Node 可执行文件路径。保存后按宿主方式重新加载 MCP。

## 连接 Figma

1. 在 Figma Desktop 打开目标文件。
2. Plugins → Development → Import plugin from manifest，选择本包 figma/manifest.json。
3. 运行 Codex Local Bridge，保持窗口打开。每份需要接入的文件都要运行插件。
4. 让助手连接并读取目标文件；底层工具为 local_figma_connect。仅服务启动或显示在线，不能替代文档读取成功。
5. 写入前指定 connectionId 和 pageId，使用 local_figma_bind。文件级资源修改需要独占文件绑定。

第一个接入的现代插件窗口通常成为主控，其他窗口显示精简状态条。显示模式与 AI 绑定目标互相独立。

## 其他编辑器

主 manifest 支持 Design、FigJam 与 Slides。FigJam/Slides 命令只能在对应编辑器执行。团队库读取/导入使用 teamlibrary 权限，库仍需要用户在 Figma 中启用。

Dev Mode 使用单独的 figma/manifest-dev.json，在 Inspect 插件入口运行。它提供 CSS、节点、资源链接和导出等只读能力；服务端与运行时都会拒绝写入。这不是完整代码生成器，也不会绕过 Figma 的权限或席位要求。

更新后让 MCP 宿主重新加载工具，调用 local_figma_capabilities 核对 runtime v11 和 api.protocol 1。

## 平时使用

打开目标文件并运行 Figma 插件，再让助手连接。MCP 调用可以自动启动本机服务。命令行适配器用法见 `node adapters/dsh-bridge.mjs help`。

需要明确进程生命周期时，在终端运行 `node bridge-server.mjs`，结束时按 Ctrl+C 并关闭 Figma 插件。自动启动的后台服务可能在助手会话结束后保留；不要按端口盲目终止未知进程。

## 升级到 0.8.1

关闭旧 Figma 插件实例，停止已确认归属的旧桥接服务，更新宿主插件包；重新导入本版 manifest，再在各文件打开插件。旧实例不会自动加载新版代码。

对应版本为：插件包 0.8.1、后台服务 0.8.1、Figma runtime v11。可通过 local_figma_settings、/health.serverVersion 和 bridge-capabilities 核对。三个版本号代表不同组件。

连接设置保存在插件缓存之外；服务重启或窗口重连后，旧绑定不能继续使用，需要重新绑定。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 找不到 node | 在终端运行 node --version，或在 MCP 配置中指定可执行文件绝对路径 |
| 服务在线但没有文件 | 确认在目标文件运行了插件，并让助手成功回读文档 |
| 接入多份文件后目标不明确 | 从连接状态中选择确切的 connectionId 与页面，不按文件名猜测 |
| 提示版本不兼容 | 停止已确认的旧服务，重新导入新版 manifest 并重开插件 |
| 切换端口后无法连接 | 默认允许 37821–37828；范围外端口需要同步修改开发 manifest 并重新导入 |
| 写入超时 | 查询原操作结果并检查画布；超时不代表未执行，不直接重放命令 |

连接设置与配置隔离见 [CONNECTIONS.md](../CONNECTIONS.md)，操作恢复见 [RELIABILITY.md](../RELIABILITY.md)。
