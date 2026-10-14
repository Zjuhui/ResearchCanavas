# Research Canvas

**English** | [简体中文](README.zh-CN.md)

An open-source visual canvas for turning research ideas into code. Design modules, functions, and file mappings across three levels, then work with Codex and VS Code to research, implement, and navigate the project.

Version **0.2.0** is distributed under the MIT license through this repository and local plugin packages. The canvas, Codex plugin, and lightweight VS Code extension work together. The graph describes your design; your actual code project runs the implementation. Natural-language conditions must be clarified and translated into code.

## Quick start

### 1. Download and start the canvas

Install [Node.js](https://nodejs.org/) **20.12 or later**. Download [research-canvas-codex-0.2.0.zip](https://github.com/Zjuhui/ResearchCanavas/releases/download/v0.2.0/research-canvas-codex-0.2.0.zip) from the [v0.2.0 release](https://github.com/Zjuhui/ResearchCanavas/releases/tag/v0.2.0), extract it, and open a terminal in the extracted `research-canvas` directory:

```powershell
node server/canvas.mjs --workspace "D:\Research\my-project" --port 3177
```

**Replace `D:\Research\my-project` with the absolute path to an existing project folder.** This is an example path, not a required installation location. No `npm install` is needed. Open [http://127.0.0.1:3177](http://127.0.0.1:3177) in your browser. Saved designs are stored in that project's `.research-canvas/` directory. Keep the terminal running; press `Ctrl+C` to stop the service.

### 2. Build your first three-level design

The current interface uses Chinese labels. The steps below include their English meanings.

1. Click **添加模块** (Add module) to create A, B, and C. Select a node to describe its goal and add named inputs and outputs.
2. Drag from an output port to another node's input, or click **添加连接** (Add connection). Select a connection to describe its conditions, decision rules, or loop behavior.
3. Double-click a module to enter level two. Click **添加功能** (Add function) to break it down, and use **接口绑定** (Interface bindings) to connect outer ports to internal ports.
4. Double-click a function to enter level three. Click **关联代码文件** (Link code file) and enter a project-relative path such as `src/optimizer.py`. You can record a planned path before the file exists; linking a file does not create it.
5. Click **保存项目** (Save project). Return to any module or function to add research notes and candidate approaches.

You can now use the canvas on its own. Continue below to involve Codex in research and implementation.

### 3. Connect Codex and VS Code when needed

**Start tasks from the canvas:** Install and sign in to Codex CLI, and confirm that `codex --version` works in your terminal. Select a saved node and click **与 Codex 研究和实现** (Research and implement with Codex). Choose **调研** (Research) or **比较方案** (Compare approaches), click **预览任务上下文** (Preview task context), and then **发起 Codex 任务** (Start Codex task). Review the results and record the evidence and approaches in the module. Select and save an approach before starting **实现代码** (Implement code). Canvas tasks use a separate session and your existing local login.

**Discuss a node in a Codex desktop chat:** Follow the [plugin installation steps (Chinese)](docs/release.md#安装-codex-插件) to add the extracted package to a local marketplace and install it. If you build from source as described below, run this command from the repository root **after the build completes**:

```powershell
codex plugin marketplace add .
```

Restart a Codex desktop client that supports local plugins, select the Research Canvas local source in the plugin directory, install it, and start a new chat. Ask: "Use Research Canvas, select workspace `<absolute path to your project>`, and open the canvas." After saving the canvas and selecting a node, ask: "Read the selected module and discuss its inputs, outputs, and implementation approaches with me." The plugin installation directory and your code workspace are specified separately. The marketplace command is documented in the [official OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins).

**Navigate code in VS Code:** Download [research-canvas-0.2.0.vsix](https://github.com/Zjuhui/ResearchCanavas/releases/download/v0.2.0/research-canvas-0.2.0.vsix). In VS Code **1.95 or later**, choose **Extensions → Install from VSIX**. Open the same project folder and keep the canvas service running. Use these commands from the Command Palette:

- `Research Canvas: 打开画布` — Open canvas.
- `Research Canvas: 打开关联代码文件` — Open a linked code file.
- `Research Canvas: 复制模块上下文` — Copy module context.

See [distribution and release verification (Chinese)](docs/release.md) for checksums, ZIP marketplace configuration, and complete installation instructions. Public plugin marketplace distribution is planned separately.

## Develop from source

Source development requires Node.js **22 or later**. Clone the repository or extract the source archive from the release page, then run these commands from the source root:

```powershell
npm ci
npm run check
npm start -- --workspace "D:\Research\my-project" --port 3177
```

Replace the workspace with your own project folder, then open `http://127.0.0.1:3177`. `npm run check` runs tests and builds the application. Omitting `--workspace` uses the current directory. `npm run dev` starts UI development mode.

## Canvas and port bindings

- Add overall modules at level one, internal functions at level two, and code file mappings at level three. Level three cannot be subdivided further.
- Click a node to edit its description, or double-click to enter the next level. You can also expand internal nodes, connections, and boundary ports within the outer canvas. Expansion affects the current view; saved function positions belong to their internal canvas.
- Each node supports multiple named inputs and outputs. Start with names and natural-language descriptions; add data types and tensor shapes later.
- Ordinary connections join nodes at the same level. Interface bindings connect module inputs to internal function inputs and internal function outputs to module outputs. One module input can feed multiple functions.
- Multiple internal sources can be recorded against one outer output. The UI and Codex context ask you to specify a merge or selection rule; the canvas does not decide whether to concatenate, sum, or branch.
- Freely describe relationships, transformations, conditions, and loops on connections. Moving a node changes its layout; connections and bindings define the relationships.
- One function can reference multiple files, and multiple functions can reference the same file. Removing a mapping removes that reference without deleting the code.

Example projects load only when requested and are clearly labeled. Example paths do not imply that files actually exist.

## Saving and code navigation

Designs are saved to `.research-canvas/project.json` in your workspace. The previous saved version is retained as `project.backup.json`. Importing JSON changes the editable canvas; save it to write it to the workspace. Export designs for backups or version control. Older projects without `bindings` load with an empty binding list.

Revision checks and file locks prevent stale saves across windows. If a conflict occurs, export your changes, reload the saved design, and merge them. At level three, you can enter planned paths or choose existing files. Opening a linked file checks that it exists and that its resolved path remains inside the workspace.

## Codex plugin

The plugin uses portable `plugin.json` and `mcp.json` manifests and includes compatibility manifests. `${PLUGIN_ROOT}` resolves to the installed plugin directory; it contains no developer-specific absolute path. The MCP server and canvas backend are compiled, and dependency license texts are included.

The plugin exposes five tools:

| Tool | Purpose |
| --- | --- |
| `use_workspace` | Select the project's absolute path for the current MCP connection without changing global configuration. |
| `open_canvas` | Start or reuse a local canvas for the selected workspace and return its URL. |
| `list_modules` | List saved modules and functions. |
| `get_selected_module` | Read the selected canvas node and its design context. |
| `get_module_context` | Read a module by ID, including child functions, port bindings, file references, and approaches. |

Save the design and select a node before asking Codex to read it. The plugin does not import or synchronize desktop chat history. Codex's own code tools read and modify source files. Select the workspace again after the MCP connection restarts.

## Research and implementation from the canvas

Save the module, preview its task context, and explicitly start the task. If the design changes after the preview, the service requires a new preview. Tasks use the local Codex App Server and existing login environment, create independent sessions, and do not require an API key in the canvas.

Research and approach-comparison tasks are read-only. Implementation requires a saved module with a selected approach and uses a workspace-write sandbox. Approval requests display their details for you to decide. Unsupported interactive requests direct you to the desktop chat. Task output and the source design revision are stored in `.research-canvas/tasks/`. Output does not automatically become verified research or a selected approach.

Before implementation, the service writes and reads back a temporary marker through the same sandbox. If this check fails, the UI reports the workspace write restriction. Choose a project folder that passes the probe and try again.

Set `CODEX_BINARY` to specify the Codex executable, or `VSCODE_BINARY` to specify VS Code. Connection checks verify the version and protocol initialization; actual task completion is verified separately. See the [integration documentation (Chinese)](docs/integrations.md) for implementation details and verification scope.

## Checks and releases

```powershell
npm run check
npm run test:ui
npm run test:plugin-install
npm run release
npm run test:release
```

Automated checks cover the data model and migration, cross-layer input distribution, shared file references, save conflicts, HTTP, actual MCP communication, the Codex protocol, and extension commands. Browser checks use an isolated temporary workspace to verify manual editing, expansion, bindings, the three-level boundary, saving and reloading, and window resizing. They use the installed Edge browser on Windows; other platforms require Playwright Chromium.

`test:plugin-install` uses isolated Codex configuration to verify installation, cache copying, and tool calls without starting model tasks. Optionally run `node scripts/release-check.mjs --source --npm-cli /absolute/path/to/npm-cli.js --code /absolute/path/to/Code.exe` to verify a clean source archive rebuild and isolated VSIX installation.

To explicitly run a real model smoke check, use `node --import tsx scripts/smoke-codex.ts --run`. For the three-stage flow, use `node --import tsx scripts/e2e-codex.ts --run`. Both consume account usage. The latter generates code in an isolated temporary workspace, runs independent tests, and writes reports to `artifacts/`. Verification fixtures are not research results.

Release packages include deterministic ZIP archives, a VSIX, a source archive, file inventories, and SHA-256 checksums. They exclude project data, logs, authentication information, and Node/Codex/VS Code executables. Full installation verification has not yet been performed on operating systems other than Windows.

## Contributors

This project follows the [All Contributors specification](https://allcontributors.org/en/reference/specification/) to acknowledge code, design, documentation, and other contributions. Codex is an AI coding assistant without an independent GitHub account. This table provides public acknowledgment; it does not represent GitHub's native account-based contributor list.

| Contributor | Contributions |
| --- | --- |
| [Zjuhui](https://github.com/Zjuhui) | [🤔 Ideas](https://allcontributors.org/en/emoji-key/) · [🎨 Design](https://allcontributors.org/en/emoji-key/) · [📆 Project management](https://allcontributors.org/en/emoji-key/) |
| [OpenAI Codex (AI coding assistant)](https://openai.com/codex/) | [💻 Code](https://allcontributors.org/en/emoji-key/) · [⚠️ Tests](https://allcontributors.org/en/emoji-key/) · [📖 Documentation](https://allcontributors.org/en/emoji-key/) · [🎨 Design](https://allcontributors.org/en/emoji-key/) |
