# Research Canvas for VS Code

薄扩展负责打开独立画布、定位代码和复制模块上下文。需要先启动本地 Research Canvas 服务，并在画布中保存项目。

命令面板：

- `Research Canvas: 打开画布`：打开本机 Web 画布，默认 `http://127.0.0.1:3177`。
- `Research Canvas: 打开关联代码文件`：从当前工作区 `.research-canvas/project.json` 读取映射，选择并打开实际存在的文件。
- `Research Canvas: 复制模块上下文`：选择已保存模块，将设计记录复制到剪贴板，供 Codex 对话使用。

文件映射限定在当前工作区内；越界路径和指向工作区外的符号链接会被拒绝。尚未创建的代码文件保留为设计映射，扩展会说明文件无法打开。移除画布映射不会删除实际文件。

发布包提供 `research-canvas-0.2.0.vsix`，可通过“扩展 → 从 VSIX 安装”手动安装。首次安装采用本地 VSIX，不需要 VS Code Marketplace 账号。

开发时在 VS Code 打开此扩展目录，并使用“运行和调试 → 启动扩展”启动扩展开发宿主。重新打包时，使用 Node.js 22 或更新版本，在仓库根目录执行 `npm run release`；官方 `@vscode/vsce` 负责包结构检查，脚本同时生成 Codex 插件 ZIP、文件清单与 SHA-256 校验和。打包与安装不会自动完成 Codex 插件接入。

本扩展没有自动读取或同步 Codex 聊天历史的功能。Codex 桌面读取画布记录由项目中的 MCP 插件提供。
