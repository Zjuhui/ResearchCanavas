const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function boundedFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || /[\0\r\n]/.test(relative)) throw new Error('代码映射必须为工作区内的相对路径。');
  const actualRoot = await fs.realpath(root);
  const target = path.resolve(actualRoot, relative);
  if (!inside(actualRoot, target)) throw new Error('文件路径超出当前工作区。');
  const actual = await fs.realpath(target);
  if (!inside(actualRoot, actual)) throw new Error('符号链接指向当前工作区之外，无法打开。');
  if (!(await fs.stat(actual)).isFile()) throw new Error('映射没有指向文件。');
  return actual;
}
async function chooseWorkspace(projectId) {
  const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
  if (!folders.length) throw new Error('请先在 VS Code 中打开项目文件夹。');
  if (projectId) {
    for (const folder of folders) {
      try { const project = await readProject(folder); if (project.id === projectId) return { folder, project }; } catch { /* next workspace */ }
    }
    throw new Error('当前 VS Code 窗口没有打开该画布项目，请打开对应工作区后重试。');
  }
  const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: '选择画布项目所在工作区' }))?.folder;
  if (!folder) return undefined;
  return { folder, project: await readProject(folder) };
}
async function readProject(folder) {
  const file = await boundedFile(folder.uri.fsPath, path.join('.research-canvas', 'project.json'));
  if ((await fs.stat(file)).size > 2_000_000) throw new Error('画布项目文件过大，无法读取。');
  const project = JSON.parse(await fs.readFile(file, 'utf8'));
  if (project.schemaVersion !== 1 || !Array.isArray(project.nodes) || !Array.isArray(project.files) || !Array.isArray(project.fileRefs) || !Array.isArray(project.edges)) throw new Error('无法识别画布项目格式。请从当前版本 Research Canvas 保存项目。');
  return project;
}
async function openMappedFile(input) {
  const request = input && typeof input === 'object' ? input : {};
  const selected = await chooseWorkspace(request.projectId);
  if (!selected) return;
  const { folder, project } = selected;
  let file;
  if (request.fileId) {
    file = project.files.find(file => file.id === request.fileId);
    if (!file) throw new Error('代码文件映射不存在，请先保存画布后重试。');
  } else {
    const files = project.files.filter(file => !request.nodeId || project.fileRefs.some(ref => ref.nodeId === request.nodeId && ref.fileId === file.id));
    if (!files.length) throw new Error('尚未添加代码文件映射，请先在第三层画布添加并保存。');
    file = (await vscode.window.showQuickPick(files.map(file => ({
      label: file.path,
      description: project.fileRefs.filter(ref => ref.fileId === file.id).map(ref => project.nodes.find(node => node.id === ref.nodeId)?.name).filter(Boolean).join(' · '),
      detail: file.description || '', file,
    })), { placeHolder: '选择关联代码文件' }))?.file;
  }
  if (!file) return;
  const target = await boundedFile(folder.uri.fsPath, file.path);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  await vscode.window.showTextDocument(document, { preview: false });
}
function moduleContext(project, node) {
  const parent = project.nodes.find(candidate => candidate.id === node.parentId);
  const related = project.edges.filter(edge => edge.source === node.id || edge.target === node.id);
  const children = project.nodes.filter(child => child.parentId === node.id);
  const files = project.fileRefs.filter(ref => ref.nodeId === node.id || children.some(child => child.id === ref.nodeId)).map(ref => ({ ...ref, file: project.files.find(file => file.id === ref.fileId) }));
  return [
    `# Research Canvas：${node.name}`,
    `项目：${project.name}（${project.id}，修订 ${project.revision}）`,
    `模块 ID：${node.id}`,
    parent ? `上级模块：${parent.name}` : '层级：整体框架模块',
    node.description || '尚未填写模块说明。',
    '',
    '以下内容是设计记录。自然语言连线条件未经确认，不视为可执行逻辑；文献仅按记录状态描述，不声称已验证。',
    JSON.stringify({ inputs: node.inputs, outputs: node.outputs, branchRule: node.branchRule, children, connections: related, bindings: (project.bindings || []).filter(binding => binding.moduleId === node.id || binding.childNodeId === node.id), codeMappings: files, research: (project.research || []).filter(record => record.nodeId === node.id), proposals: (project.proposals || []).filter(proposal => proposal.nodeId === node.id) }, null, 2),
  ].join('\n');
}
async function copyModuleContext() {
  const selected = await chooseWorkspace();
  if (!selected) return;
  const { project } = selected;
  if (!project.nodes.length) throw new Error('项目还没有模块，请先添加节点并保存。');
  const chosen = await vscode.window.showQuickPick(project.nodes.map(node => ({ label: node.name, description: project.nodes.find(parent => parent.id === node.parentId)?.name || '整体模块', detail: node.description || '', node })), { placeHolder: '选择要与 Codex 讨论的模块' });
  if (!chosen) return;
  await vscode.env.clipboard.writeText(moduleContext(project, chosen.node));
  await vscode.window.showInformationMessage('已复制模块上下文，可粘贴到 Codex 聊天继续讨论。');
}
function guard(action) {
  return async (...args) => {
    try { await action(...args); }
    catch (error) { await vscode.window.showErrorMessage(`Research Canvas：${error instanceof Error ? error.message : String(error)}`); }
  };
}
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('researchCanvas.open', guard(async () => {
      const value = vscode.workspace.getConfiguration('researchCanvas').get('url', 'http://127.0.0.1:3177');
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('画布地址必须为本机 localhost 地址。');
      if (!(await vscode.env.openExternal(vscode.Uri.parse(url.toString())))) throw new Error('无法打开画布，请先启动本地服务。');
    })),
    vscode.commands.registerCommand('researchCanvas.openMappedFile', guard(openMappedFile)),
    vscode.commands.registerCommand('researchCanvas.copyModuleContext', guard(copyModuleContext)),
    vscode.window.registerUriHandler({ handleUri: guard(async uri => {
      if (uri.path !== '/open') throw new Error('无法识别的画布链接。');
      const query = new URLSearchParams(uri.query);
      const fileId = query.get('fileId');
      if (!fileId) throw new Error('画布链接缺少文件映射 ID。');
      await openMappedFile({ fileId, projectId: query.get('projectId') || undefined });
    }) }),
  );
}
module.exports = { activate, deactivate() {}, _test: { boundedFile, moduleContext } };
