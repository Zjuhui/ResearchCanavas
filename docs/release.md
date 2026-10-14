# 本地分发与发布验收

当前采用 MIT 开源授权，通过 [Zjuhui/ResearchCanavas](https://github.com/Zjuhui/ResearchCanavas)、本地 Codex marketplace 和 VSIX 分发。这里的“发布包”表示可交给其他开发者安装的本地软件包；公共插件目录审核仍需另行申请。

## 构建发布包

构建发布包使用 Node.js 22 或更新版本（官方 `@vscode/vsce@4.0.0` 的要求）；安装后的 Codex 插件和画布运行时只需要 Node.js 20.12 或更新版本。

```powershell
npm ci
npm run check
node --test extensions/vscode/test/extension.test.cjs
npm run release
node scripts/release-check.mjs
```

可选的深度检查：`node scripts/release-check.mjs --source --npm-cli /absolute/path/to/npm-cli.js` 从源码 ZIP 建立干净目录，按锁文件安装依赖并重新构建。加 `--code /absolute/path/to/Code.exe` 会使用独立的 profile 和扩展目录执行真实 VSIX 安装，不改动日常编辑器环境。

输出到 `artifacts/releases/0.2.0/`：

- `research-canvas-codex-0.2.0.zip`：一个顶层插件目录，内含 MCP、已编译 Web 画布、技能和依赖授权文本。
- `research-canvas-source-0.2.0.zip`：使用明确目录和文件白名单生成的开源源码包；包含锁文件和构建脚本，解压后 `npm ci` 与 `npm run build` 即可重新构建。
- `research-canvas-0.2.0.vsix`：由官方 vsce 生成的 VS Code 扩展。
- `FILE_INVENTORY.json`：Codex 包内各文件大小和 SHA-256。
- `SOURCE_FILE_INVENTORY.json`：源码包内各文件大小和 SHA-256。
- `SHA256SUMS`：安装包、源码包与两个文件清单的 SHA-256。

ZIP 时间戳、文件顺序与压缩参数固定。相同源码、锁文件、Node 版本和构建工具版本的构建可重复；不承诺不同压缩实现或 Node 大版本间字节相同。发布脚本使用白名单包目录，拒绝符号链接、项目记录、`.env`、日志、源映射和开发者工作区绝对路径。包内不包含 Node、Codex 或 VS Code 可执行程序，也不携带登录凭据。

## 安装 Codex 插件

从仓库构建后，仓库根目录含 `.agents/plugins/marketplace.json`，插件位于 `plugins/research-canvas/`。在仓库根目录执行：

```powershell
codex plugin marketplace add .
```

然后重启 Codex 桌面应用，在插件目录中选取 Research Canvas 本地源并安装。这个命令仅在用户执行安装步骤时登记插件源；构建、测试和发布脚本不会修改日常 Codex 配置。

若只下载 ZIP，将插件解压后放进一个本地 marketplace 根目录的 `plugins/research-canvas/`，并在该根目录创建 `.agents/plugins/marketplace.json`：

```json
{
  "name": "research-canvas-local",
  "interface": { "displayName": "Research Canvas" },
  "plugins": [{
    "name": "research-canvas",
    "source": { "source": "local", "path": "./plugins/research-canvas" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

新聊天中明确说：“使用 Research Canvas，选择工作区 D:\我的项目，打开画布。”插件将先选择当前连接的工作区，再启动或复用本地服务。工作区不会因插件安装目录改变，也不会写进全局配置。要讨论某个模块，先在画布保存项目并选中节点，再让 Codex 读取所选模块。

插件使用官方 portable `plugin.json` / `mcp.json`，并保留兼容清单。`${PLUGIN_ROOT}` 指向安装后的插件目录；工作区由 `use_workspace` 指定。支持本地 MCP 的桌面环境需要能在 PATH 找到 `node`。

## 安装 VS Code 扩展

在 VS Code 使用“扩展 → 从 VSIX 安装”，选择发布包的 `.vsix`。然后打开与画布相同的工作区，使用命令面板里的三个 Research Canvas 命令。打开关联文件会验证真实文件路径仍在该工作区内；未创建的代码文件只保留设计映射。

`publisher: research-canvas` 是本地扩展身份，不表示已注册同名 Marketplace 发布者。以后发布到 VS Code Marketplace 时，需由维护者提供实际账号和最终发布者身份；若需要改名，应在公开发布前处理。

## 验收边界

自动化发布检查在全新临时目录解压并运行实际编译包，不依赖源码目录或 npm 包；验证 HTTP 保存和已选模块读取、工作区切换约束、MCP 工具与清单、SHA-256 和确定性 ZIP。VSIX 使用官方 vsce 打包；隔离 profile 的安装检查与模拟 VS Code API 的命令测试分别记录，不能代替真实用户在编辑器中点击验收。

检查范围包括核心模型、HTTP、MCP、Codex 协议、VS Code 扩展命令，以及浏览器中的三层画布、输入分发、连线编辑和保存恢复。真实模型验收使用明确标注的测试夹具，覆盖调研、方案和代码生成；研究结果仍需使用者核验。当前完成 Windows 环境验证，其他操作系统尚未完成完整安装验收。

实现任务会先检查工作区在 Codex 沙箱内是否可写。检查失败时会在调用模型前结束；请检查权限与沙箱配置，或选择通过写入检查的工作区。画布保存与 Codex 沙箱写入分别验证。

开发者机器的安装状态、路径、诊断日志和验收过程只保存在本地 `artifacts/` 中，不纳入 Git 或发布包。公开文档记录安装方法、产品行为、可复现的检查步骤与适用范围。

真实 Codex 任务执行另有单独检查。协议握手、MCP 返回设计和模型完成任务是三项独立结果；任何超时都不能当作模型已成功执行。调研引用需要实际查证，自然语言条件需要讨论后落到代码，画布不自动执行图。

公开源码仓库已确定。未来提交公共插件目录或 VS Code Marketplace 时，仍需维护者提供对应市场的最终发布者身份并确认已验证项目与限制。公共 OpenAI 目录的本地 MCP 提交目前还要求受支持的合作伙伴准入；这不妨碍开源仓库和本地源分发。

官方依据：[插件打包与本地 marketplace](https://developers.openai.com/plugins/build/plugins)、[本地 MCP 与桌面插件提交](https://developers.openai.com/plugins/deploy/desktop-only)。
