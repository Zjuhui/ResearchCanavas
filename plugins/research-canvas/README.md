# Research Canvas plugin

本插件读取用户明确选择的本地研究项目，让 Codex 围绕模块设计、输入输出、跨层绑定、调研和代码文件映射继续讨论。它不会读取或同步其他聊天历史。

需要 Node.js 20.12 或更新版本，以及支持本地插件的 Codex 桌面环境。画布发起真实任务还需要可用并已登录的 Codex CLI；打开代码需要 VS Code。

本包包含已编译的 MCP 服务与 Web 画布，无需安装 npm 依赖。解压到任意目录后，可在该目录运行：

```powershell
node server/canvas.mjs --workspace "D:\your-project" --port 3177
```

在浏览器打开 `http://127.0.0.1:3177`，添加并保存模块。将插件加入本地 marketplace 后安装；首次使用时明确告诉 Codex 工作区的绝对路径，让它调用 `use_workspace` 选择该项目。也可让 Codex 调用 `open_canvas` 启动画布并返回地址。

MCP 提供五个工具：`use_workspace` 选择当前连接的项目，`open_canvas` 启动或复用该项目的本地服务，`list_modules` 列模块，`get_selected_module` 读取画布所选模块，`get_module_context` 读取指定模块。选择工作区只作用于当前连接，不修改全局配置；重新连接后需要重新选择。文件映射是设计信息，尚未创建的文件不会因此自动出现。

`mcp.json` 使用官方支持的 `${PLUGIN_ROOT}` 占位符，安装目录与工作区分开，不包含开发者电脑路径。`LICENSE` 是项目 MIT 授权；打包依赖的授权全文见 `THIRD_PARTY_NOTICES.txt`。

这是通过开源仓库和本地插件源分发的版本。Codex 公共目录审核及 VS Code Marketplace 发布另行处理；当前包没有伪造发布者账户或仓库地址。
