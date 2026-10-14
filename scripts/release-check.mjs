import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { zip, unzip } from './release-archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const release = path.join(root, 'artifacts', 'releases', version);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const line of (await readFile(path.join(release, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
  const [hash, filename] = line.split('  ');
  assert.equal(digest(await readFile(path.join(release, filename))), hash, `checksum ${filename}`);
}
const archive = await readFile(path.join(release, `research-canvas-codex-${version}.zip`));
assert.deepEqual(zip(unzip(archive)), archive, 'release ZIP must have canonical ordering and timestamps');
const temporary = await mkdtemp(path.join(tmpdir(), 'research-canvas-relocated-'));
const workspace = path.join(temporary, 'a project with spaces');
const installed = path.join(temporary, 'research-canvas');
const client = new Client({ name: 'research-canvas-release-check', version });
let server;
let startedCanvasPid;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
}
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options });
    let output = '';
    child.stdout?.on('data', value => { output += value; }); child.stderr?.on('data', value => { output += value; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output}`)));
  });
}
try {
  for (const entry of unzip(archive)) {
    const target = path.resolve(temporary, entry.name);
    assert.ok(target.startsWith(temporary + path.sep), 'archive extraction must stay in temporary directory');
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, entry.data);
  }
  await assert.rejects(stat(path.join(temporary, 'node_modules')));
  await mkdir(workspace);
  const listen = await port(), url = `http://127.0.0.1:${listen}`;
  server = spawn(process.execPath, [path.join(installed, 'server', 'canvas.mjs'), '--workspace', workspace, '--port', String(listen)], { cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let serverOutput = '';
  server.stdout.on('data', value => { serverOutput += value; }); server.stderr.on('data', value => { serverOutput += value; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/project')).ok) break; } catch {}
    if (server.exitCode !== null || i === 99) throw new Error(`Relocated canvas did not start: ${serverOutput}`);
    await sleep(50);
  }
  const html = await (await fetch(url)).text();
  assert.match(html, /<div id="root"/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)/g)].map(match => match[1]);
  assert.ok(assets.length >= 2);
  for (const asset of assets) assert.equal((await fetch(url + asset)).status, 200, `compiled browser asset ${asset}`);
  const { project } = await (await fetch(url + '/api/project')).json();
  project.name = 'Relocated release verification';
  project.nodes.push({ id: 'release-node', parentId: null, name: 'Portable module', description: 'Actual saved release test data', position: { x: 100, y: 100 }, inputs: [], outputs: [], branchRule: '' });
  assert.equal((await fetch(url + '/api/project', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, expectedRevision: 0 }) })).status, 200);
  assert.equal((await fetch(url + '/api/selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: 'release-node' }) })).status, 200);

  const config = JSON.parse(await readFile(path.join(installed, 'mcp.json'), 'utf8')).mcpServers['research-canvas'];
  assert.equal(config.type, 'stdio'); assert.equal(config.command, 'node');
  const substitute = value => value.replaceAll('${PLUGIN_ROOT}', installed);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: config.args.map(substitute), cwd: substitute(config.cwd), stderr: 'pipe' }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['get_module_context', 'get_selected_module', 'list_modules', 'open_canvas', 'use_workspace']);
  assert.equal((await client.callTool({ name: 'list_modules', arguments: {} })).isError, true, 'workspace is explicitly selected, never package cwd');
  assert.equal((await client.callTool({ name: 'use_workspace', arguments: { workspacePath: './relative' } })).isError, true);
  assert.ok(!(await client.callTool({ name: 'use_workspace', arguments: { workspacePath: workspace } })).isError);
  const selected = await client.callTool({ name: 'get_selected_module', arguments: {} });
  assert.ok(!selected.isError); assert.match(JSON.stringify(selected.content), /Portable module/);
  const canvas = await client.callTool({ name: 'open_canvas', arguments: { port: listen } });
  assert.ok(!canvas.isError, JSON.stringify(canvas)); assert.match(JSON.stringify(canvas.content), new RegExp(`127\\.0\\.0\\.1:${listen}`));
  assert.equal((await (await fetch(url + '/api/project')).json()).workspaceRoot, await realpath(workspace));
  const another = path.join(temporary, 'another workspace');
  await mkdir(another);
  assert.ok(!(await client.callTool({ name: 'use_workspace', arguments: { workspacePath: another } })).isError);
  const conflict = await client.callTool({ name: 'open_canvas', arguments: { port: listen } });
  assert.equal(conflict.isError, true, 'open_canvas cannot reuse another workspace server');
  assert.match(JSON.stringify(conflict.content), /其他工作区/);
  const ownPort = await port();
  const opened = await client.callTool({ name: 'open_canvas', arguments: { port: ownPort } });
  assert.ok(!opened.isError, JSON.stringify(opened));
  const launched = JSON.parse(opened.content.find(content => content.type === 'text').text);
  startedCanvasPid = launched.pid;
  assert.ok(Number.isSafeInteger(startedCanvasPid) && startedCanvasPid > 0);
  assert.equal(launched.reused, false);
  assert.equal((await (await fetch(launched.url + '/api/project')).json()).workspaceRoot, await realpath(another));
  assert.match(await (await fetch(launched.url)).text(), /<div id="root"/);
  console.log('PASS: relocated compiled canvas + five MCP tools + explicit workspace + HTTP persistence + new/reused canvas + conflicting workspace + ZIP/checksums (no node_modules).');

  const codeIndex = process.argv.indexOf('--code');
  if (codeIndex >= 0) {
    const code = path.resolve(process.argv[codeIndex + 1]);
    const cli = path.join(path.dirname(code), 'resources', 'app', 'out', 'cli.js');
    const options = { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } };
    const common = [cli, '--user-data-dir', path.join(temporary, 'vscode-profile'), '--extensions-dir', path.join(temporary, 'vscode-extensions')];
    const vsix = path.join(release, `research-canvas-${version}.vsix`);
    await run(code, [...common, '--install-extension', vsix, '--force'], options);
    const listing = await run(code, [...common, '--list-extensions', '--show-versions'], options);
    assert.match(listing, new RegExp(`research-canvas\\.research-canvas@${version.replaceAll('.', '\\.')}`));
    console.log('PASS: actual VS Code installs and lists the VSIX in an isolated profile/extensions directory.');
  }
  if (process.argv.includes('--source')) {
    const sourceArchive = await readFile(path.join(release, `research-canvas-source-${version}.zip`));
    assert.deepEqual(zip(unzip(sourceArchive)), sourceArchive, 'source ZIP must be canonical');
    for (const entry of unzip(sourceArchive)) {
      const target = path.resolve(temporary, entry.name);
      assert.ok(target.startsWith(temporary + path.sep));
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, entry.data);
    }
    const checkout = path.join(temporary, 'research-canvas-source');
    await assert.rejects(stat(path.join(checkout, 'plugins', 'research-canvas', 'server')));
    const npmIndex = process.argv.indexOf('--npm-cli');
    const npm = npmIndex >= 0 ? path.resolve(process.argv[npmIndex + 1]) : process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    try { await stat(npm); } catch { throw new Error('Source rebuild needs --npm-cli /absolute/path/to/npm-cli.js (or run through npm).'); }
    const options = { cwd: checkout, env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') } };
    await run(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    await run(process.execPath, [npm, 'run', 'build'], options);
    assert.match(await readFile(path.join(checkout, 'plugins', 'research-canvas', 'server', 'canvas.mjs'), 'utf8'), /Research Canvas/);
    console.log('PASS: source ZIP installs its exact lockfile and rebuilds the web app + portable plugin from a clean directory.');
  }
} finally {
  await client.close();
  if (startedCanvasPid) {
    try { process.kill(startedCanvasPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await sleep(200);
  }
  if (server && server.exitCode === null) {
    await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  }
  const verified = await realpath(temporary);
  assert.ok(verified.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(verified).startsWith('research-canvas-relocated-'));
  await rm(verified, { recursive: true, force: true });
}
