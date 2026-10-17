# 本地 API 与能力边界

默认地址 `http://localhost:37821`。`GET /health` 查看活连接、服务版本、进度、最近结果；`POST /command` 使用 JSON 对象，字段 `type` 和可选 `connectionId`。多连接必须显式指定。错误响应 `ok:false`，不能只看 HTTP 200。

读取命令：`ping`、`bridge-capabilities`、`get-document-info`、`get-pages`、`get-node`（nodeId/depth，深度上限50）、`get-fonts`、`export-node`（nodeId/format PNG或SVG/scale，MCP限制0.1–4）。导出回传 base64，不将整段数据打印到日志。

写入命令：

- `import-image`：base64 → imageHash。
- `build-section`：parentId、nodes、可选 focus。节点 kind 为 FRAME/COMPONENT/RECTANGLE/ELLIPSE/TEXT/SVG/INSTANCE。字体使用本机可用 fontName；TEXT 需要明确字体。SVG 用 svg 字符串，实例用 componentId。预加载去重字体；本批构建失败清理本批创建节点，已派发超时不保证已回滚。
- `update-node`：nodeId、props。支持 x/y/name/fills/strokes/opacity/fontSize/characters/textAlignHorizontal/textAlignVertical/lineHeight/letterSpacing/visible/clipsContent；width 与 height 同时提供才 resize。创建和更新白名单不同，未支持字段可能被忽略，务必回读。
- `design-system`：action 为 inspect/page/collection/variable/text-style/effect-style/bind/variants/property/describe/clone-component/replace-instance。字段以 figma/code.js 当前实现为准；不是事务。replace-instance 会隐藏原节点，不删除；按原宽度缩放实例并保持边界。

创建支持圆角、布局、填充等字段，但 `visible` 不在创建白名单；需要时追加更新。文字对齐支持 TOP/CENTER/BOTTOM 与 LEFT/CENTER/RIGHT/JUSTIFIED，拒绝非法值或非 TEXT。混合字体的更新可能失败，应先检查节点字体状态。

注册/轮询/进度/回传端点由插件使用，connectionId 是路由而不是权限证明。读15秒，构建/设计系统/图片导入/导出60秒；超时派发后锁定，迟到结果可解锁。其他已排队请求在结果未知时停止。检查 progress 和 lastResult 后核对画布，禁止盲重试。

BRIDGE_PORT 和 BRIDGE_READ_TIMEOUT_MS / BRIDGE_WRITE_TIMEOUT_MS 供测试或受控调试使用；Figma iframe 与 manifest 默认固定37821，改端口须同步这两处并重新导入，不能只改环境变量。请求体上限32MiB（base64 会膨胀），超过返回413；超大图片应先在本地适当处理。
