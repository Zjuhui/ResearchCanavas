# Research Canvas

[English](README.md) | **简体中文**

本地研究设计画布：手动建立模块、细分功能、连接输入输出，把设计关联到真实代码，并在 Codex 中围绕模块调研、比较方案和实现。

当前版本 **0.2.0**，采用 MIT 许可证，面向开源仓库与本地插件分发。画布、Codex 插件、薄 VS Code 扩展独立协作。图用于描述设计，运行的是实际代码项目；自然语言条件需要澄清后实现。

## 快速开始

### 1. 下载并启动画布

准备 [Node.js](https://nodejs.org/) **20.12 或更新版本**。从 [v0.2.0 发布页](https://github.com/Zjuhui/ResearchCanavas/releases/tag/v0.2.0)下载 [research-canvas-codex-0.2.0.zip](https://github.com/Zjuhui/ResearchCanavas/releases/download/v0.2.0/research-canvas-codex-0.2.0.zip)，解压后进入其中的 `research-canvas` 目录，在终端运行：

```powershell
node server/canvas.mjs --workspace "D:\Research\my-project" --port 3177
```

将 `D:\Research\my-project` **替换为你已存在的项目文件夹绝对路径**；这是示例路径，不是固定安装位置。无需运行 `npm install`。浏览器打开 [http://127.0.0.1:3177](http://127.0.0.1:3177)，即可开始设计；保存记录写入所选项目的 `.research-canvas/`。保持终端运行，按 `Ctrl+C` 停止服务。

### 2. 建立第一张三层画布

1. 点击“添加模块”，创建 A、B、C，选中节点填写目标、说明和命名输入输出。
2. 从输出端口拖线到另一个节点的输入，或点击“添加连接”；点击连线填写条件、判断规则或循环说明。
3. 双击模块进入第二层，点击“添加功能”细分模块；通过“接口绑定”关联外层与内部输入输出。
4. 双击功能进入第三层，点击“关联代码文件”，填写如 `src/optimizer.py` 的项目相对路径。可以先记录规划路径，映射操作不会创建文件。
5. 点击“保存项目”。回到任意模块或功能，继续补充调研与候选方案。

至此已可独立使用画布。要让 Codex 参与调研和代码实现，继续下面的连接步骤。

### 3. 连接 Codex 与 VS Code（按需）

**在画布中发起任务：**安装并登录 Codex CLI，确保终端能运行 `codex --version`。选中已保存节点，点击“与 Codex 研究和实现”，选择“调研”或“比较方案”，先“预览任务上下文”，再“发起 Codex 任务”。确认结果后，将依据和方案记录到模块；选定并保存一个方案后，才可发起“实现代码”。画布任务使用独立会话和已有登录状态。

**在当前 Codex 桌面聊天讨论节点：**按[插件安装步骤](docs/release.md#安装-codex-插件)将解压包加入本地 marketplace 并安装。若使用下方的源码构建方式，可在完成构建后于仓库根目录执行：

```powershell
codex plugin marketplace add .
```

重启支持本地插件的 Codex 桌面应用，在插件目录选择 Research Canvas 本地源并安装，再开启新聊天。告诉 Codex：“使用 Research Canvas，选择工作区 `<你的项目绝对路径>`，打开画布。”保存画布并选中节点后，可以说：“读取所选模块，和我讨论输入输出与实现方案。”插件安装目录与代码项目分别指定。命令依据见 [OpenAI 官方插件文档](https://developers.openai.com/plugins/build/plugins)。

**在 VS Code 定位代码：**下载 [research-canvas-0.2.0.vsix](https://github.com/Zjuhui/ResearchCanavas/releases/download/v0.2.0/research-canvas-0.2.0.vsix)，在 VS Code 1.95 或更新版本中选择“扩展 → 从 VSIX 安装”。打开同一个项目文件夹，保持画布服务运行，再从命令面板执行 `Research Canvas: 打开画布`、`Research Canvas: 打开关联代码文件`或 `Research Canvas: 复制模块上下文`。

安装包校验和、ZIP 插件源配置和完整安装说明见[本地分发与发布验收](docs/release.md)。公共插件市场随后推进。

## 从源码开发

需要 Node.js **22 或更新版本**。克隆仓库或解压发布页的源码包后，在源码根目录运行：

```powershell
npm ci
npm run check
npm start -- --workspace "D:\Research\my-project" --port 3177
```

将工作区替换为自己的项目目录，再打开 `http://127.0.0.1:3177`。`npm run check` 包含测试与构建；省略工作区参数时使用当前目录，`npm run dev` 启用界面开发模式。

## 画布与端口绑定

- 第一层手动添加整体模块，第二层添加模块内部功能，第三层关联代码文件。第三层不继续细分。
- 点击模块编辑说明，双击逐层进入，也可在外层展开内部节点、连线和边界端口。展开是当前视图状态，保存的功能坐标属于其内部画布。
- 每个节点可添加多个命名输入输出；名称和自然语言说明先填，类型和张量形状可稍后补充。
- 普通连线连接同层节点；模块输入通过接口绑定传给内部功能输入，内部功能输出通过绑定对应模块输出。同一个模块输入允许分发到多个功能。
- 多个内部来源可以作为设计记录绑定到同一外层输出。界面和 Codex 上下文会提示明确合并或选择规则，不自动决定拼接、求和或分支行为。
- 连线的关系、转换、条件与循环说明自由填写。移动节点只改变布局，流程关系由连线和绑定表达。
- 一个功能可引用多个文件，同一个文件可被多个功能引用；移除映射只解除当前关联，不删除代码。

示例项目需主动载入，所有示例内容有明确标记；示例路径不代表实际文件存在。

## 保存与代码定位

保存到工作区 `.research-canvas/project.json`，上个保存版本保留为 `project.backup.json`。JSON 导入后先编辑，再保存；导出可用于备份或纳入版本控制。旧版缺少 `bindings` 的项目会以空绑定读取。

跨窗口保存使用版本校验与文件锁；过期保存被拒绝。遇到冲突先导出当前修改，再重新读取并合并。第三层允许填写规划路径和选择实际文件，打开代码时会验证文件存在且真实路径未越出工作区。

## Codex 插件

插件使用 portable `plugin.json` 与 `mcp.json`，并保留兼容清单。`${PLUGIN_ROOT}` 在安装后解析为插件目录，不包含开发者机器的绝对路径。MCP 服务与画布后端已编译，依赖授权文本随包提供。

五个工具：

| 工具 | 用途 |
| --- | --- |
| `use_workspace` | 选择本次 MCP 连接使用的项目绝对路径，不写全局配置 |
| `open_canvas` | 为所选工作区启动或复用本地画布，返回 URL |
| `list_modules` | 列出已保存模块和功能 |
| `get_selected_module` | 读取画布所选节点及设计上下文 |
| `get_module_context` | 按 ID 读取模块、子功能、端口绑定、文件引用与方案 |

保存后选择节点，再让 Codex 读取所选模块。插件不导入或同步桌面聊天历史；源代码的读取和修改仍由 Codex 自身的代码工具完成。MCP 连接重启后需要重新选择工作区。

## 从画布调研与实现

先保存模块，再预览任务上下文，主动发起任务。预览后的设计若已改变，服务要求重新预览。任务使用本地 Codex App Server 和已有登录环境，创建独立会话，不要求在画布填写 API 密钥。

调研与方案任务保持只读；实现任务要求该模块已保存并选定方案，并使用工作区写入沙箱。需要审批时显示请求详情，由用户明确处理。尚未支持的交互请求会提示转到桌面聊天。任务输出和来源模块版本保存在 `.research-canvas/tasks/`；输出不会自动成为已核验的调研记录或已选方案。

实现任务先通过同一沙箱写入临时标记并回读确认。若检查失败，界面会提示工作区写入限制；请使用能够通过探测的项目目录后重试。

可通过 `CODEX_BINARY` 指定 Codex 可执行文件，通过 `VSCODE_BINARY` 指定 VS Code。连接检测只验证版本与协议初始化，真实任务完成有单独的验收。实现细节与检查范围见 [接入文档](docs/integrations.md)。

## 检查与发布

```powershell
npm run check
npm run test:ui
npm run test:plugin-install
npm run release
npm run test:release
```

自动检查覆盖模型与迁移、跨层输入分发、共享文件、保存冲突、HTTP、真实 MCP 通信、Codex 协议和扩展命令。浏览器检查在独立临时工作区验证手动编辑、展开、绑定、三层边界、保存恢复和窗口缩放；Windows 使用本机 Edge，其他平台需要安装 Playwright Chromium。

`test:plugin-install` 使用隔离的 Codex 配置验证实际安装、缓存复制和工具调用，不发起模型任务。可选 `node scripts/release-check.mjs --source --npm-cli /absolute/path/to/npm-cli.js --code /absolute/path/to/Code.exe` 验证源码包干净重建和隔离 VSIX 安装。

显式真实模型检查：`node --import tsx scripts/smoke-codex.ts --run`；三阶段验收：`node --import tsx scripts/e2e-codex.ts --run`。这两项使用账户额度，后者在隔离的临时工作区生成代码，并运行独立测试，将报告写到 `artifacts/`。验收夹具不构成研究成果。

发布包包括确定性 ZIP、VSIX、源码包、文件清单与 SHA-256；不会携带项目数据、日志、认证信息或 Node/Codex/VS Code 可执行程序。尚未在其他操作系统进行完整安装验收。

## 贡献者

本项目按 [All Contributors 规范](https://allcontributors.org/en/reference/specification/) 记录代码、设计和文档等贡献。Codex 是 AI 编程助手，没有独立 GitHub 账号；此表为公开致谢，不代表 GitHub 原生账号贡献者列表。

| 贡献者 | 贡献类型 |
| --- | --- |
| [Zjuhui](https://github.com/Zjuhui) | [🤔 想法](https://allcontributors.org/en/emoji-key/) · [🎨 设计](https://allcontributors.org/en/emoji-key/) · [📆 项目管理](https://allcontributors.org/en/emoji-key/) |
| [OpenAI Codex（AI 编程助手）](https://openai.com/codex/) | [💻 代码](https://allcontributors.org/en/emoji-key/) · [⚠️ 测试](https://allcontributors.org/en/emoji-key/) · [📖 文档](https://allcontributors.org/en/emoji-key/) · [🎨 设计](https://allcontributors.org/en/emoji-key/) |
