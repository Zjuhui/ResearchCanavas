import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { zip, unzip } from './release-archive.mjs';

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Release packaging requires Node.js >=22 for the official VS Code packaging tool. Plugin runtime requires Node.js >=20.12.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const destination = path.join(root, 'artifacts', 'releases', manifest.version);
const pluginRoot = path.join(root, 'plugins', 'research-canvas');
await mkdir(destination, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const privatePaths = [...new Set([root, homedir()].flatMap(value => [value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')]))].map(value => value.toLowerCase());
function checkPrivatePaths(entry) {
  const content = entry.data.toString('utf8').toLowerCase();
  if (privatePaths.some(value => content.includes(value))) throw new Error(`Machine-specific path found in release: ${entry.name}`);
}
async function files(directory, prefix = '') {
  const entries = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (item.isSymbolicLink()) throw new Error(`Release cannot contain symlinks: ${prefix}${item.name}`);
    const filename = path.join(directory, item.name), name = prefix + item.name;
    if (item.isDirectory()) entries.push(...await files(filename, name + '/'));
    else if (item.isFile()) entries.push({ name, data: await readFile(filename) });
  }
  return entries;
}
const entries = await files(pluginRoot);
for (const name of ['plugin.json', 'mcp.json', '.codex-plugin/plugin.json', 'server/mcp.mjs', 'server/canvas.mjs', 'web/index.html', 'skills/research-canvas/SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
  if (!entries.some(entry => entry.name === name)) throw new Error(`Run npm run build before packaging: missing ${name}`);
}
for (const entry of entries) {
  if (/(^|\/)(node_modules|\.research-canvas|\.git|\.env(?:\..*)?)(\/|$)/.test(entry.name) || /\.(log|map|vsix|zip)$/.test(entry.name)) throw new Error(`Excluded data in release: ${entry.name}`);
  checkPrivatePaths(entry);
}
const portable = JSON.parse(entries.find(entry => entry.name === 'plugin.json').data);
if (portable.version !== manifest.version) throw new Error('Build and release versions do not match');
const inventory = entries.map(entry => ({ path: entry.name, bytes: entry.data.length, sha256: digest(entry.data) }));
const pluginZip = `research-canvas-codex-${manifest.version}.zip`;
await writeFile(path.join(destination, pluginZip), zip(entries.map(entry => ({ ...entry, name: 'research-canvas/' + entry.name }))));
await writeFile(path.join(destination, 'FILE_INVENTORY.json'), JSON.stringify(inventory, null, 2) + '\n');

// The repository archive contains source only. Exact roots and extension files
// are allowlisted so a user's canvas records and local diagnostics never enter it.
const source = [];
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'README.md', 'LICENSE', 'AGENTS.md', '.gitignore']) {
  source.push({ name, data: await readFile(path.join(root, name)) });
}
for (const directory of ['src', 'server', 'integrations', 'tests', 'scripts', 'docs']) {
  for (const entry of await files(path.join(root, directory), directory + '/')) {
    if (/\.(?:[cm]?js|tsx?|css|svg|json|md|yml|yaml)$/.test(entry.name)) source.push(entry);
  }
}
for (const name of ['plugin.json', 'mcp.json', '.mcp.json', '.codex-plugin/plugin.json', 'README.md']) source.push({ name: 'plugins/research-canvas/' + name, data: await readFile(path.join(pluginRoot, name)) });
for (const entry of await files(path.join(pluginRoot, 'skills'), 'plugins/research-canvas/skills/')) source.push(entry);
for (const name of ['package.json', 'extension.cjs', 'README.md', 'LICENSE', '.vscodeignore']) source.push({ name: 'extensions/vscode/' + name, data: await readFile(path.join(root, 'extensions', 'vscode', name)) });
for (const entry of await files(path.join(root, 'extensions', 'vscode', 'test'), 'extensions/vscode/test/')) source.push(entry);
for (const directory of ['extensions/vscode/.vscode', '.github']) {
  try { source.push(...await files(path.join(root, directory), directory + '/')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
source.push({ name: '.agents/plugins/marketplace.json', data: await readFile(path.join(root, '.agents', 'plugins', 'marketplace.json')) });
for (const entry of source) {
  if (/(^|\/)(node_modules|artifacts|\.research-canvas|\.git|\.env(?:\..*)?)(\/|$)/.test(entry.name) || /\.(log|map|vsix|zip)$/.test(entry.name)) throw new Error(`Excluded data in source release: ${entry.name}`);
  checkPrivatePaths(entry);
}
const sourceZip = `research-canvas-source-${manifest.version}.zip`;
await writeFile(path.join(destination, sourceZip), zip(source.map(entry => ({ ...entry, name: 'research-canvas-source/' + entry.name }))));
await writeFile(path.join(destination, 'SOURCE_FILE_INVENTORY.json'), JSON.stringify(source.map(entry => ({ path: entry.name, bytes: entry.data.length, sha256: digest(entry.data) })), null, 2) + '\n');

// Official vsce owns the VSIX manifest and package validation. Normalize only ZIP
// ordering and timestamps afterward; file contents remain exactly as vsce emitted.
const require = createRequire(import.meta.url);
const vsce = require.resolve('@vscode/vsce/vsce');
const extension = path.join(root, 'extensions', 'vscode');
const extensionManifest = JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8'));
if (extensionManifest.version !== manifest.version) throw new Error('VS Code extension version does not match project');
const vsix = `research-canvas-${manifest.version}.vsix`, output = path.join(destination, vsix);
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--out', output], { cwd: extension, stdio: 'inherit', windowsHide: true, shell: false });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`vsce exited ${code}`)));
});
await writeFile(output, zip(unzip(await readFile(output))));
await cp(output, path.join(extension, vsix));
await writeFile(path.join(destination, 'SHA256SUMS'), (await Promise.all([pluginZip, sourceZip, vsix, 'FILE_INVENTORY.json', 'SOURCE_FILE_INVENTORY.json'].map(async name => `${digest(await readFile(path.join(destination, name)))}  ${name}`))).join('\n') + '\n');
console.log(`Release files: ${destination}`);
