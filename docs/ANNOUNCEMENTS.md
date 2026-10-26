# 更新公告

## 2026-10-26 · 0.8.3 结构快照优化与撤销修复

本次更新以 v0.8.3 提供源码及下载包；v0.8.2 下载包不包含本次改动。运行代码已生成，保留目录结构后导入 figma/manifest.json，无需构建。

### 有哪些变化

- 大页面的手动布局创建、复制、移动与排序保存更小的结构快照，减少对无关组件实例子层的遍历。
- 修复本次 PR 审查发现的问题：容器跨入/跨出自动布局后撤销，原有嵌套子图层会保留；原 PR 的这个缺陷未包含在已发布的 v0.8.2 中。
- 失败回滚移除新增根节点，避免直接删除受保护的实例继承子层。新增子树的后续修改仍触发撤销冲突保护。
- 单份快照上限 48 MiB、历史总预算 96 MiB，最多 20 次写入；这些是序列化估算预算，实际内存占用可能更高。

### 验证与升级

15 组隔离测试与代码一致性检查通过，补测覆盖移动、撤销、失败回滚和后续编辑冲突。另完成 Windows Figma Desktop 126.9.16 Design 实机验收，双向撤销、子层保留、冲突保护及失败回滚均通过。[实机记录与边界](LIVE-VALIDATION-2026-10-26.md)。macOS、FigJam、Slides 和 Dev Inspect 未在本轮重新实测。

先确认未完成请求的最终状态，再更新源码并重新运行 Figma 插件；重新打开插件会清空桥接撤销历史。包/服务为 0.8.3、runtime v11，需核对 `api.performance.structuralSnapshots = 1` 以及 bridgePackageVersion/serverVersion 为 0.8.3。

感谢 [tok-24](https://github.com/tok-24) 在 [PR #1](https://github.com/mengkong30/codex-local-bridge/pull/1) 中贡献初始结构快照优化。

[完整更新记录](../CHANGELOG.md) · [撤销与可靠性说明](../RELIABILITY.md)
