# 验证范围

Node.js 22+：运行 `npm run check`、`npm test` 和 `npm run scan`。默认测试只使用内置模块，无需下载依赖。检查包含 JavaScript 语法、JSON、版本一致性、便携 MCP 配置和生成运行时代码同步。

11 个隔离测试入口覆盖安全边界、页面/文件绑定、MCP 进程归属、主控切换、幂等写入与超时恢复、模拟 Figma runtime、端到端 MCP/命令行适配器、服务发现、截图回执/修复与持久连接设置。部分入口复用 runtime 测试。这些测试使用合成数据，不能作为真实 Figma 全功能验证。

测试使用独立的本机端口（以 test 文件中的常量为准），端口冲突时失败，不终止无关进程。公共运行器使用临时状态目录，不读取用户连接设置。

UI 测试需要可选开发依赖：

```sh
npm install
npx playwright install chromium
npm run test:ui
```

BRIDGE_BROWSER_CHANNEL 可选已安装的 msedge/chrome；BRIDGE_PLAYWRIGHT_MODULE 可指定已有 Playwright 模块。UI 测试使用模拟宿主和本机端口 37832，覆盖主控/精简条、设置、刷新、任务状态、断线删除和明暗主题。合成截图默认输出到被 Git 忽略的 output/ui，可通过 BRIDGE_UI_OUTPUT 指定其他目录。

修改 Figma 源模块后运行 `npm run build` 再检查；发布 ZIP 含生成代码，导入 manifest 前无需构建。

真实烟测应在获授权的副本内进行：启动本版服务并运行本版 manifest，核对插件包 0.8.0、服务 0.8.0、runtime v11；绑定临时页面，创建文字 FRAME，回读文字对齐，导出并核对尺寸，结束后关闭插件。记录真实客户端版本。没有完成的项应明确记录。

公开测试不含真实设计，也不为原型、变量所有字段、跨版本字体或平台审核提供认证。

新增 test-api.mjs 和 test-api-integration.mjs 验收统一属性、拓扑/绝对位置、富文本交叠与撤销、Grid/布局、原型回读、JPG/PDF、变量模式、样式快照、库作用域、实例操作、FigJam/Slides 基础命令、Dev 只读、旧 worker 拒绝及 MCP 资源格式。另验证超过 20 条时保留最新撤销记录、禁止引用动态改变 batch 类型。

真实验收尚需在 Design/FigJam/Slides/Dev Inspect 中分别导入对应 manifest，检查字体、API 可用性、原型播放、库与套餐权限；自动模拟没有覆盖真实客户端的所有这些差异。
