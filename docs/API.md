# 本地 API 与能力边界

默认在 http://localhost:37821 至 37828 发现服务，只绑定 IPv4 回环地址。GET /health 返回服务版本、实例、配置、连接、绑定和执行进度；错误响应的 ok:false 必须处理。

先通过 /clients/register 注册任务，再通过 /bindings 显式绑定页面或独占文件。写入携带对应 connectionId、clientId 和 bindingId；页面绑定拒绝跨页面修改，全局资源操作需要文件绑定。ID 用于路由和冲突控制，不是身份凭据。完整字段见 [CONTROLLERS.md](../CONTROLLERS.md)。

读取包括 ping、bridge-capabilities、get-document-info、get-pages、get-node、get-fonts、export-node、validate-layout、review-layout 和 operation-history。PNG/SVG 导出返回数据，不应把整段 base64 打印到公开日志。

写入包括 build-section、update-node、import-image、design-system、batch、undo-operation、repair-layout，以及面板、KPI、折线图、环图、示意地图、组件、变量集合和自动布局命令。无任意 JavaScript 执行端点。字段以源码和实时能力为准，写入后回读验证。

复杂操作先 dryRun；每次有意写入使用独立 idempotencyKey，重试保持相同载荷。GET /operations 可查询已排队、未知或完成的操作；结果受服务实例和保留期限制。已派发超时不代表失败，不能盲目重放。支持的原子批次会尝试回滚，检查 rollback.ok；撤销只覆盖支持操作并具有冲突保护。见 [RELIABILITY.md](../RELIABILITY.md)。

其他协议见 [主控](../HUB.md)、[连接设置](../CONNECTIONS.md)、[布局](../LAYOUT.md)、[视觉复检](../VISUAL-REVIEW.md) 和 [高层构建](../DSL.md)。

默认读取等待 15 秒，写入和导出 60 秒。BRIDGE_PORT、BRIDGE_PROFILE、BRIDGE_DISCOVERY_PORTS、BRIDGE_STATE_DIR 与超时变量用于本机配置/测试。Figma manifest 默认允许八个端口；范围外端口必须同步允许并重新导入。32 MiB 请求体上限包含 base64 膨胀。

## 0.8.0

新增 17 工具中的 local_figma_capabilities 和一组扩展命令。完整 type/action/字段、JPG/PDF 返回格式、编辑器入口和恢复边界见 [EXPANDED-API.md](EXPANDED-API.md)。api-contract.json 是服务与生成 runtime 的共同契约。新命令要求 runtime v11；Dev 连接在服务端也拒绝写入。
