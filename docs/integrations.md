# 连接方式与验证范围

画布独立运行，本机服务保存 `.research-canvas/project.json`。薄 VS Code 扩展读取这份项目记录并打开实际代码文件；Codex 插件的 MCP 工具读取已保存模块和当前选择。安装插件不会导入或同步 Codex 桌面聊天历史。

## 从画布发起 Codex 任务

`integrations/codex.ts` 使用 [Codex App Server 官方接口](https://learn.chatgpt.com/docs/app-server)，通过子进程标准输入输出交换 JSONL。流程是 `initialize` → `initialized` → `thread/start` → `turn/start`，并接收输出和任务结束事件。

界面上的“检测 Codex”仅检查本机二进制版本并执行初始化握手，不发送模型任务、不验证账户推理权限。点击真正的“启动任务”后才会调用模型，使用本机 Codex 已配置的认证、模型及账户额度。应用不会读取或保存认证文件。

- 调研、方案任务使用只读沙箱；此类任务不会接受提升权限的审批。
- 实现任务使用工作区写入沙箱和 `on-request` 审批策略。命令或文件修改审批会保留服务器请求以及先前的命令/差异信息，由用户在画布明确批准或拒绝；不自动批准。
- 实现前调用同一 `workspaceWrite` 策略的 `command/exec` 写入唯一临时标记，并由本地服务回读、清理；失败则在创建模型线程前结束。请检查目录权限和沙箱配置，或选择通过写入检查的工作区。画布保存和 Codex 沙箱写入是独立能力。
- 任务取消会请求 `turn/interrupt` 并关闭对应进程。终态记录保存在 `.research-canvas/tasks/`，保留最近加载的最多 100 条历史和最多约 100000 字符的输出。
- 尚未支持的交互请求（例如模型要求用户回答问题）会显式结束任务并提示在 Codex 桌面继续，不替用户作答。
- 首版没有自动恢复运行中任务。每次启动创建独立 Codex 线程，无法接管当前桌面聊天。

二进制发现顺序：`CODEX_BINARY` 完整可执行文件路径 → Windows Codex App 安装目录 → `PATH` 中的可执行文件。Windows 的 `.cmd` 包装器不会通过 shell 执行，可将 `CODEX_BINARY` 指向 `codex.exe`。

适配器使用 `on-request`、`read-only`、`workspace-write` 等协议字段。如果 Codex 升级后拒绝字段，会显示协议错误；应按安装版本的 `app-server generate-ts` 输出更新适配器。协议握手、模块读取和模型完成任务需要分别验证。

## VS Code

扩展源码位于 `extensions/vscode/`，提供打开画布、选择关联文件、复制模块上下文三个命令。文件通过 [VS Code 文档 API](https://code.visualstudio.com/api/references/vscode-api) 打开，外部画布通过 `env.openExternal` 打开。

扩展 URI：`vscode://research-canvas.research-canvas/open?fileId=<文件ID>&projectId=<项目ID>`。处理器只在已打开工作区的已保存映射中查找文件；相对路径越界和指向工作区外的符号链接会被拒绝。未创建的代码路径会给出错误，不伪装成已存在文件。

按 [VS Code 官方打包说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) 使用锁定版本的官方 vsce 生成 VSIX。安装后如已打开的编辑器窗口未显示扩展，可重载窗口后再试用。

## 可移植 Codex 插件

发布包使用 portable `plugin.json` / `mcp.json`，通过 `${PLUGIN_ROOT}` 定位编译后的服务，不写死开发者工作区。`use_workspace` 仅改变当前 MCP 连接；`open_canvas` 为所选目录启动本地服务，同目录复用，不同目录的端口冲突明确报错。读取模块的三个工具保持只读。完整包包含依赖与授权文本，运行时无需 `node_modules`。

## 验证方式

`npm run test:plugin-install` 在隔离配置中检查插件安装、缓存复制及五个 MCP 工具的发现和调用，不发起模型任务。它使用安装版本提供的插件协议；面向用户的安装步骤见 [分发文档](release.md)。

`npm run test:release` 检查编译 ZIP 在没有 npm 依赖的干净目录中运行。可选源码重建和 VSIX 隔离安装检查见分发文档。VS Code 的命令与路径边界另有模拟 API 测试。

协议测试覆盖流式输出、显式审批、只读策略、取消、失败、写入探测以及带来源模块和设计版本的任务历史。任务预览返回已保存版本；设计在预览后改变时，启动请求会被拒绝并要求重新预览。

显式运行 `scripts/smoke-codex.ts --run` 可检查真实模型连接，`scripts/e2e-codex.ts --run` 可验证调研、方案和代码生成流程，并对生成代码执行收敛、次数上限、初始即收敛、零次迭代、非法数值参数五项检查。这些任务使用账户额度；测试夹具仅验证流程，调研结果仍需人工核验。测试报告保存在不纳入发布的 `artifacts/` 中。
