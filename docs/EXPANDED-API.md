# 0.8 扩展命令

[首页](../README.md) · [能力范围](CAPABILITIES.md) · [可靠写入](../RELIABILITY.md)

服务 / 包 0.8.3，runtime v11。先调用 local_figma_capabilities，再将下列对象放进 local_figma_command 的 command 字段，外层传 bindingId。connectionId、pageId、clientId、target 不放在 command 内。每个实际写入使用唯一 idempotencyKey；dry-run 使用另一个 key。

## 命令一览

| type | 主要字段 |
| --- | --- |
| create-node | parentId?，node:{kind, name?, ...属性, children?} |
| delete-node | nodeId，allowLocked?，allowNonUndoable:true |
| clone-node | nodeId，parentId?，index?，name?，preserveAbsolute?（默认 true） |
| move-node | nodeId，parentId，index?，preserveAbsolute? |
| reorder-node | nodeId，index（0 起始） |
| group-nodes | nodeIds，parentId?，index?，name? |
| ungroup-node | nodeId（GROUP），allowNonUndoable:true |
| boolean-operation | nodeIds，operation:UNION/SUBTRACT/INTERSECT/EXCLUDE，parentId?，name?，allowNonUndoable:true |
| flatten-nodes | nodeIds，parentId?，allowNonUndoable:true |
| update-node | nodeId，props（与创建共用字段清单，width/height 可以分别更新） |
| set-text-ranges | nodeId，ranges:[{start,end,props}]，偏移量为 UTF-16，下限包含，上限不包含 |
| instance-action | nodeId，action:set-properties/swap/detach/reset-overrides，properties?，componentId? 或 componentKey?，allowNonUndoable:true |
| variable-action | action:collection-create/collection-rename/collection-remove/mode-add/mode-rename/mode-remove/create/update/remove/import，详见下文 |
| style-action | action:create/update/remove/import，styleType:PAINT/GRID/TEXT/EFFECT，styleId?，name?，props?，key? |
| set-variable-mode | nodeId，collectionId，modeId；或 clear:true |
| import-library | kind:component/componentSet/style/variable，key，allowNonUndoable:true |
| set-reactions | nodeId，reactions（官方 Reaction 数组） |
| export-node | nodeId，format:PNG/SVG/JPG/PDF，scale?，settings? |
| get-library | collectionKey?；不传时列出已启用库的变量集合，传入时列出集合变量 |
| get-css | nodeId |
| get-dev-resources | nodeId，includeChildren? |
| dev-resource-action | nodeId，action:add/edit/remove，url，name?，value?，allowNonUndoable:true（仅可写编辑器） |
| get-editor-info | 返回编辑器、字段、命令与能力边界 |
| get-slides | Slides 专用，返回网格内的 slide 信息 |
| figjam-action | action:sticky/shape/connector/table/table-cell，详见下文，allowNonUndoable:true |
| slides-action | action:create-slide/create-row/set-grid/set-transition/skip，详见下文，allowNonUndoable:true |

变量/样式、import-library、Slides 操作及通过 componentKey 导入交换实例需要 scope:file。属性/节点引用仍须属于本文件；页面绑定拒绝跨页面写入。不能把不可撤销操作放进 batch，type/action 也不能通过结果引用动态替换。

## 创建与属性

kind 支持 FRAME、COMPONENT、RECTANGLE、ELLIPSE、TEXT、VECTOR、LINE、POLYGON、STAR、SECTION、SLICE，以及 SVG（svg 字符串）和 INSTANCE（componentId）。TEXT 需要 fontName。库组件先用 import-library 导入，再引用返回的 componentId。

```json
{"type":"create-node","node":{"kind":"FRAME","name":"Card","width":320,"height":180,"cornerRadius":16,"rotation":0,"children":[{"kind":"TEXT","name":"Title","fontName":{"family":"Inter","style":"Regular"},"characters":"Overview","x":20,"y":20,"fontSize":24}]}}
```

以 local_figma_capabilities 返回的 nodeProperties 为准。包括常用几何、外观、文字、布局、尺寸约束、样式 ID、遮罩、路径和 vectorNetwork。未支持的字段或节点类型会报错。gridPosition 是桥接字段 {row,column}，由 setGridChildPosition 应用；轨道数组使用 {type:FLEX/FIXED/HUG,value?}。

```json
{"type":"update-node","nodeId":"node-id","props":{"rotation":15,"cornerRadius":12,"strokeWeight":2,"width":360}}
```

apply-auto-layout 保留 direction/gap/padding 等简写，并新增 props 与 childLayouts:[{nodeId,props}]；childLayouts 仅接受直接子节点。

## 文字范围

```json
{"type":"set-text-ranges","nodeId":"text-id","ranges":[{"start":0,"end":5,"props":{"fontSize":24,"fontName":{"family":"Inter","style":"Bold"}}},{"start":6,"end":11,"props":{"hyperlink":{"type":"URL","value":"https://example.com"}}}]}
```

支持字体、字号、颜色 fills、行高、字距、大小写、装饰、超链接、列表、缩进、段落间距、文字/颜色样式 ID。先预加载字体，再写入；范围越界在预检时拒绝。不要把 Unicode 码点索引直接当成 UTF-16 偏移。

## 变量、样式与库

variable-action 的 create 需要 collectionId、name、dataType:COLOR/FLOAT/STRING/BOOLEAN；update/remove 使用 variableId。value 可配 modeId，或者 valuesByMode:{modeId:value}。变量别名沿用官方 {type:VARIABLE_ALIAS,id} 结构。可设置 description、scopes 和 codeSyntax:{WEB,ANDROID,iOS}；对应值为 null 时移除该平台语法。

collection-create 使用 name、可选 modeName；collection-rename/remove 与 mode-add/rename/remove 使用 collectionId；mode-add/rename 使用 name，mode-rename/remove 还需 modeId。模式数量限制由 Figma 套餐决定。

style-action 的 create 使用 styleType、name 和 props；update/remove 使用 styleId；import 使用 key。props 按类型使用 paints、layoutGrids、effects 或字体字段，可设 name/description。删除和导入需要 allowNonUndoable:true。

get-library 查询已启用库的变量集合；库启用与发布仍由 Figma UI/权限控制。已知 key 的组件、组件集、样式或变量可用 import-library 导入，不需要 REST API 密钥。

## 原型与导出

set-reactions 直接传递 Figma 的 Reaction/Trigger/Action 结构，支持官方动作组合。示例：

写入前校验 Trigger、非空 actions 及条件动作中的节点目标。NAVIGATE/SWAP/OVERLAY 的目标需为顶层 FRAME/COMPONENT/INSTANCE，允许处于 Section 中；SCROLL_TO 和 CHANGE_TO 保留各自的目标语义，其他原生限制由 Figma API 校验。错误包含命令、源节点及 reactions/actions 参数位置。[官方 Action 语义](https://developers.figma.com/docs/plugins/api/Action/)。

```json
{"type":"set-reactions","nodeId":"button-id","reactions":[{"trigger":{"type":"ON_CLICK"},"actions":[{"type":"NODE","destinationId":"frame-id","navigation":"NAVIGATE","transition":null,"preserveScrollPosition":false}]}]}
```

导出 settings 支持 contentsOnly、useAbsoluteBounds、suffix、colorProfile；PNG/JPG 可设 constraint:{type:SCALE/WIDTH/HEIGHT,value}，SVG 可设 svgOutlineText、svgIdAttribute、svgSimplifyStroke。格式不适用的字段会报错。scale 最大 4，按宽/高最大 16384。

local_figma_export 返回 PNG/JPG 的 MCP 图片块，PDF 返回 application/pdf 的嵌入资源（宿主是否直接展示取决于其支持），SVG 返回数据。CLI export 同样支持四种格式并写入文件。

## FigJam、Slides 与 Dev Inspect

FigJam 使用主 manifest。figjam-action 的 sticky/shape 支持 text、fontName、props；shape 另有 shapeType。connector 支持官方 connectorStart/connectorEnd、connectorLineType 和端点线帽。table 使用 rows/columns，最多 1000 格；table-cell 使用 nodeId、row、column、text、fontName?。

Slides 的 create-slide 使用 row?/column?/props?；create-row 使用 row?；set-grid 使用 grid:[[slideId,...],...]；skip 使用 nodeId/skipped；set-transition 使用 nodeId/transition。transition 沿用官方 {style,duration,curve,timing}。

Dev Mode 通过单独的 figma/manifest-dev.json 注册 Inspect 入口，支持 get-css、get-dev-resources、节点读取和导出；所有写入在服务与 runtime 两层拒绝。dev-resource-action 只能在可写 Design 中维护资源链接。此入口不包含任意代码生成或账户管理。

## 恢复边界

真实删除、解组、布尔、flatten、实例内部操作、资源删除/导入和编辑器专用操作需要 allowNonUndoable:true，并返回 undo.supported:false。执行前后建立 Figma 原生 undo 边界，供用户人工撤销；桥接不尝试重建原 ID。其他支持快照的操作仍需检查 undo/diff 和 rollback.ok。

API 字段以 [Figma 官方文档](https://developers.figma.com/docs/plugins/api/figma/) 和当前运行时为准；示例中的 node-id 等占位符必须替换为真实读取的 ID。
