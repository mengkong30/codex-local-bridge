# 0.4.0 多 AI 控制

此版本用于个人电脑：一个本地桥接服务、每份 Figma 文件一个插件实例。
无云端 API Key。AI 名称由控制端声明；clientId / bindingId 用于路由与协调，不代表身份认证。

## 目标与归属

- 每个任务先注册客户端（aiName + name），再绑定明确的 connectionId 和 pageId。
- 同一页面只能存在一个绑定；同一客户端重复申请同一目标返回原绑定。
- 同文件的不同页面可以分别归属于不同 AI，命令按文件串行；不同文件独立并行。
- 所有写入必须带 clientId、bindingId；读取和导出也建议使用绑定。未绑定的文件级读取仍兼容。
- 页面绑定会在实际 Figma 执行前核查 nodeId、parentId、childId、sourceId、nodeIds 的所属页面。
- componentId 是可跨页面引用的组件源，不会因此获得对组件所在页面的修改权。
- 删除目标页面、连接失效、释放绑定都会导致后续命令失败，不能回退到当前页面。
- 手动切页不改绑定；后台操作不自动切换页面，focus 仅允许目标页面已可见时使用。
- 页面创建、变量集合、变量、文字样式、效果样式、图片资产导入属于文件操作，需 scope:file 独占绑定。
- file 绑定可以操作该文件所有页面，绑定时的 pageId 用作默认创建位置。

## HTTP 控制协议

基础地址 `http://localhost:37821`，POST 统一使用 application/json。

| 接口 | 字段 | 行为 |
|---|---|---|
| GET /health | 无 | 服务版本、连接、每个连接的页面绑定与执行状态 |
| POST /clients/register | aiName, name | 返回新的 clientId |
| POST /bindings | clientId, connectionId, pageId, scope? | scope 默认 page；冲突返回 409 |
| POST /bindings/heartbeat | clientId, bindingId | 更新租约 |
| POST /bindings/release | clientId, bindingId | 释放自己的空闲绑定 |
| GET /connection?connectionId=… | connectionId | 插件界面读取该文件状态 |
| POST /bindings/revoke | connectionId, bindingId | 插件用户确认后释放空闲绑定 |
| POST /disconnect | connectionId | 断开空闲插件并释放其全部绑定 |
| POST /command | type, clientId, bindingId, 命令字段 | 桥接注入 target，不接受调用者覆盖 target |

每次绑定、心跳、命令和完成结果续租五分钟。MCP 进程每 30 秒续租自己的绑定；任务结束调用 release。
DSH CLI 无后台进程，长时间规划期间每分钟 heartbeat。控制进程丢失后，空闲租约最多五分钟释放。
Figma 心跳丢失 45 秒视为断开；新的插件会话使用新连接 ID，旧绑定不得复用。
运行、排队和结果未确认的绑定均不可释放。已发出的超时命令继续占用文件，等待真实结果或重开插件核对。

文件级队列保守串行，避免 Figma 全局状态引起竞争。本版本无跨文件事务、通用撤销或自动重放。
在同一 Figma 文件中使用同一个插件实例承载多个控制端；未保存文件没有可依赖的全局 fileKey，不能通过文件名推断相同文件身份。

## Codex 使用

1. local_figma_status 读取连接与页面 ID。
2. local_figma_bind 指定 connectionId、pageId、aiName、clientName。
3. 将 bindingId 用于 local_figma_document / node / export / command。
4. local_figma_command 的 command 只含 type/nodes/props 等业务字段，不能混入目标路由。
5. local_figma_release 释放任务绑定。

示例中的名称会出现在 Figma 面板。区分同一 AI 的两个任务时，使用不同 clientName。

## DSH 使用

`scripts/figma-bridge.mjs bind --connection <id> --page <id> --ai DeepSeek --name <任务名>`

返回 binding.clientId 与 binding.bindingId。之后所有针对性命令加 `--client <id> --binding <id>`。
`heartbeat` 与 `release` 使用相同两个参数。使用已有 clientId 绑定时，沿用其注册名称。

## 验证与升级

- `node test-isolation.mjs`：隔离临时端口上的路由、并发、冲突、超时恢复，以及真实插件源码的模拟 Figma 执行。
- `node test-mcp-isolation.mjs`：两个独立 MCP 进程分别注册、绑定、执行、查询和释放。
- `node test-ui.cjs`：本地 HTML 的浏览器交互、模拟网络故障与界面截图，需要 Playwright 和 Edge。
- `test-reliability.mjs` / `test-mcp.mjs` 保留为兼容入口。
- DSH 适配器另有独立 fixture 测试，位于本次交付目录。

升级必须更新服务和 Figma 插件两端。要求 /health.serverVersion=0.4.0、controllerProtocol=1、bridge-capabilities.version=7。
重新打开 Figma 开发插件以加载 UI 与 code.js。重新加载宿主插件以发现新增 MCP 工具。
模拟测试和浏览器截图不等于真实 Figma 文件验收；需要在两个实际目标文件中运行新版插件再确认。
