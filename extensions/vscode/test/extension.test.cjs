const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const commands = new Map();
const shown = [], errors = [], urls = [];
let clipboard = '';
const vscode = {
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => 'http://127.0.0.1:3177' }),
    openTextDocument: async uri => ({ uri }),
  },
  Uri: { file: fsPath => ({ scheme: 'file', fsPath }), parse: value => ({ value }) },
  window: {
    showQuickPick: async items => items[0],
    showTextDocument: async document => shown.push(document.uri.fsPath),
    showInformationMessage: async () => {}, showErrorMessage: async message => errors.push(message),
    registerUriHandler: handler => { vscode.uriHandler = handler; return { dispose() {} }; },
  },
  env: { openExternal: async uri => { urls.push(uri.value); return true; }, clipboard: { writeText: async text => { clipboard = text; } } },
  commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; } },
};
const originalLoad = Module._load;
Module._load = function (id, parent, main) { return id === 'vscode' ? vscode : originalLoad.call(this, id, parent, main); };
const extension = require('../extension.cjs');
Module._load = originalLoad;

test('extension commands read saved mapping and copy module context without shell execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'research-canvas-extension-'));
  try {
    await fs.mkdir(path.join(root, '.research-canvas'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'shared.ts'), 'export const shared = true;');
    const project = { schemaVersion: 1, id: 'p', name: 'Example', revision: 3, nodes: [{ id: 'a', parentId: null, name: 'Prepare', description: 'Prepare data', inputs: [], outputs: [], branchRule: '' }], edges: [], bindings: [{ id: 'binding', moduleId: 'a', direction: 'input', modulePortId: 'samples', childNodeId: 'child', childPortId: 'data', description: 'Samples fan out to preprocessing' }], files: [{ id: 'f', path: 'src/shared.ts', description: 'Shared implementation' }], fileRefs: [{ id: 'r', nodeId: 'a', fileId: 'f' }], research: [], proposals: [] };
    await fs.writeFile(path.join(root, '.research-canvas', 'project.json'), JSON.stringify(project));
    vscode.workspace.workspaceFolders = [{ name: 'Example', uri: { scheme: 'file', fsPath: root } }];
    extension.activate({ subscriptions: [] });
    await commands.get('researchCanvas.open')();
    assert.equal(urls[0], 'http://127.0.0.1:3177/');
    await commands.get('researchCanvas.openMappedFile')();
    assert.equal(shown[0], await fs.realpath(path.join(root, 'src', 'shared.ts')));
    await commands.get('researchCanvas.copyModuleContext')();
    assert.match(clipboard, /模块 ID：a/);
    assert.match(clipboard, /src\/shared.ts/);
    assert.match(clipboard, /Samples fan out to preprocessing/);
    await vscode.uriHandler.handleUri({ path: '/open', query: 'fileId=f&projectId=p' });
    assert.equal(shown.length, 2);
    assert.deepEqual(errors, []);
    await vscode.uriHandler.handleUri({ path: '/open', query: 'fileId=f&projectId=other' });
    assert.match(errors[0], /没有打开/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('mapped files reject path traversal and links outside the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'research-canvas-extension-path-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'research-canvas-extension-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'private.txt'), 'outside');
    await assert.rejects(extension._test.boundedFile(root, '../outside.txt'), /超出/);
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(extension._test.boundedFile(root, 'linked/private.txt'), /符号链接/);
    await assert.rejects(extension._test.boundedFile(root, path.join(outside, 'private.txt')), /相对路径/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});
