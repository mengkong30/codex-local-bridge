# Reliable writes (0.6.0 / runtime v9)

All writes require an explicit page/file binding, plus runtime v9. `update-node`, batch, undo and DSL use the 60 s write deadline; ordinary reads use 15 s; PNG export and layout validation use 60 s. Commands remain serial per file. Timeout never implies cancellation: use `/operations` before considering another write.

## Preview and diff

Add `dryRun:true` to any write. It returns `writes:0` and a plan of target nodes/fields or planned creations. It performs no document mutation and creates no undo record. Resolved steps can show before/after properties; batch references to future results remain symbolic until execution. Preview is not a reservation or a promise that fonts/resources will still be available. Native API setter/font failures are reported during execution and supported changes are rolled back.

Successful writes return `operationId`, `diff:[{id,kind,path,action,properties:[{property,before,after}]}]`, `undo` and normal command results. Resource diffs use collection/variable/style IDs. Batch failures include `details.failedStep`, `completedSteps` and `rollback:{ok,errors}`. A false rollback status requires inspection; do not continue automatically.

## Idempotency and result query

HTTP `/command` accepts `idempotencyKey` (1–160 chars) with a binding. Use one key per intended payload; dry-run and execute use different keys. Reusing a key with different payload yields 409. In-flight repeat yields 202 with `operation.requestId`, completed repeat returns the saved result, and failed repeat returns the same failure. A dispatched timeout stays `uncertain` until its actual late result arrives. Uncertain connections reject new work; retrying the **same** existing key still returns its record without redispatch.

`GET /operations?connectionId=...&clientId=...&requestId=...` (or `idempotencyKey`) queries queued/running/uncertain/succeeded/failed state and complete result. It does not queue a Figma command and accepts records after disconnection. MCP: `local_figma_operation` with a binding created by this MCP process. DSH: `operation <requestId> --connection ... --client ...`.

Retention: keys/results are in service memory for 24 hours after completion, max 1000 write records; pending/uncertain entries are never evicted to make room. Capacity rejects new writes. Health and query responses expose `instanceId`. **Service restart, new connection/client, or expired retention starts a new idempotency domain. Unknown writes must not be replayed blindly.** This is not durable crash recovery. Read/export results are not retained unless a key is explicitly supplied.

## Atomic batch

```json
{"type":"batch","idempotencyKey":"tokens-and-component-v1","commands":[
 {"stepId":"tokens","type":"create-variable-collection","name":"Dashboard tokens"},
 {"stepId":"component","type":"create-component","key":"kpi","name":"KPI","width":280,"height":132,"tokenCollectionId":{"$ref":"tokens.id"}}
]}
```

File binding is required if any nested step changes file resources. Up to 100 individual write steps; no nested batch, explicit step routing, undo, or non-undoable operations. `$ref` resolves result fields from an earlier `stepId`. In 0.8.2, simple edits snapshot their dependency roots and resource-only commands snapshot resources. The 0.8.3 structural optimization scopes supported structural batches to their containers and affected roots; mixed/result-reference batches retain the bound page (or full file/resource) snapshot. Failures restore original values/topology and remove creations, then compare restoration against the snapshot.

## Undo

`{type:"undo-operation", operationId:"...", dryRun:true}` previews reverse diff. Remove dryRun to restore. MCP has `local_figma_undo`; DSH has `undo <operationId>`. Undo checks the saved after-state against the live scope first: later AI/user modifications cause a conflict, with no overwrite. Page operations can be undone from the same page binding or file binding; file operations require exclusive file scope. Latest compatible state must match; reverse sequential batches in reverse order.

History is local to the running Figma plugin, max 20 writes / 96 MiB total snapshots; an individual snapshot is limited to 48 MiB. Reopening clears it. `operation-history` lists retained IDs. This is intentionally separate from Figma's native undo history (`commitUndo` marks successful bridge operations).

Supported: node build/update, high-level templates, auto-layout, pages, variables/collections, text/effect styles, variable/style bindings, descriptions, clone-component and replace-instance. `replace-instance` creates an instance and **hides/renames** the source to 原始备份; undo removes the new instance and restores source visibility/name.

Non-undoable: image-store insertion, component property definitions, and variant-combining metadata. Dry-run discloses the limitation; explicit `allowNonUndoable:true` is required for standalone execution. Atomic batches reject them. Arbitrary user deletion, remote-library changes, new Figma files, and cross-file transactions are outside this API.

## 0.8.2 快照范围与响应性

普通 update-node、set-text-ranges、set-reactions、set-variable-mode、apply-auto-layout 保存目标子树；父级为自动布局时向上扩展连续自动布局祖先，以覆盖子项重排和尺寸变化。简单 batch 合并这些依赖。变量/样式命令只保存资源。

本地结构快照优化：create-node、build-section、clone-node、move-node、reorder-node 以及仅含这些操作且不带结果引用的批次，保存相关父容器的子节点顺序和受影响根节点，不展开手动布局实例的继承子层。自动布局和 GROUP 祖先仍完整保存必要依赖；存在这些依赖时，移动目标根也始终在前后快照中完整保存，即使操作前已被祖先覆盖，防止跨入/跨出依赖范围时误删原有子层。新增子树使用流式指纹保护撤销冲突，指纹不保存整份子树数据；回滚只移除新增根节点，不直接删除实例继承子层。包含结果引用、其他操作或混合范围的复杂批次仍使用保守的页面/文件快照。运行时通过 api.performance.structuralSnapshots=1 标识此优化。

撤销只检查和恢复该依赖范围，范围内后续修改仍返回冲突；范围外修改不再阻止撤销，也不会被恢复覆盖。视觉回执保存审查根、明确纳入的外部节点和布局依赖，另有 16 MiB 估算保留预算。扫描和比较分批让出主线程，历史快照大小按 UTF-16 字符串长度估算并缓存；实际对象内存可能更高。

## 0.8.1 恢复性能与迟到结果

撤销仍比较完整页面/文件快照以拒绝覆盖后续修改。恢复时只对变化的拓扑、节点属性和资源执行 API 写入，无关文字不加载字体；需要的字体在一次恢复内去重。文字纯位置或旋转修改也无需加载字体。`restoring` 进度包含变化/总节点数量。

请求超时不代表执行失败。若心跳同时过期，worker 使用原连接 ID 与 `activeRequestId` 恢复该未完成请求；匹配的迟到进度/结果可重新激活原连接。结果固定回传至任务最初的服务/连接，确认后恢复面板。未知请求、请求不匹配及服务实例改变时继续拒绝自动切换，不重放写入。

## 0.8.0 扩展恢复边界

统一字段定义覆盖原型 reactions、显式变量模式及四类样式的快照。最新 20 条撤销记录按时间从新到旧保留。真实删除/解组/布尔/flatten、实例内部操作、资源删除/导入和编辑器专用元数据不承诺桥接恢复；它们需要 allowNonUndoable:true，返回 undo.supported:false，并被原子 batch 拒绝。type/action 必须为字面字符串，解析引用后仍复核不可撤销限制。详见 docs/EXPANDED-API.md。
