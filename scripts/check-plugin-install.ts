/**
 * Opt-in local Codex plugin installation acceptance check.
 * Uses the installed CLI's official App Server methods and an isolated CODEX_HOME.
 * Never starts a model turn, reads authentication files, or changes user configuration.
 * Run after npm run build: node --import tsx scripts/check-plugin-install.ts --run
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerConnection, findCodexBinary } from '../integrations/codex.js';
import { createExampleProject } from '../src/shared/model.js';
import { ProjectStore } from '../server/store.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = path.join(repository, 'artifacts', 'plugin-install-check.json');
if (!process.argv.includes('--run')) {
  console.log('Opt-in check: node --import tsx scripts/check-plugin-install.ts --run');
  process.exit(0);
}

const evidence: Record<string, any> = {
  checkedAt: new Date().toISOString(), status: 'running',
  scope: 'Official installed Codex App Server, isolated temporary CODEX_HOME and sample workspace',
  inferenceStarted: false, modelTurnsStarted: 0,
  methods: [], checks: {},
};
let connection: AppServerConnection | undefined;
function message(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/((?:authorization\s*[:=]\s*bearer|(?:access_token|refresh_token|api_key)\s*["']?\s*[:=]\s*["']?)\s*)[^\s,"']+/gi, '$1[redacted]')
    .slice(0, 4000);
}
async function findCachedRoots(directory: string, results: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8) return results;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(directory, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(child, 'plugin.json'), 'utf8'));
      if (manifest.name === 'research-canvas') { results.push(child); continue; }
    } catch { /* Search bounded cache descendants, never authentication files. */ }
    await findCachedRoots(child, results, depth + 1);
  }
  return results;
}
async function request(method: string, params: Record<string, unknown>): Promise<any> {
  assert.ok(connection);
  assert.notEqual(method, 'turn/start', 'This acceptance check must not perform inference');
  evidence.methods.push(method);
  return connection.request(method, params);
}

try {
  await mkdir(path.dirname(evidencePath), { recursive: true });
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), 'research-canvas-plugin-install-'));
  const codexHome = path.join(isolatedRoot, 'codex-home');
  const workspace = path.join(isolatedRoot, 'sample-workspace');
  await mkdir(codexHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const isolatedConfig = '[features]\nplugins = true\n\n' + [repository, workspace].map(directory => `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`).join('\n');
  await writeFile(path.join(codexHome, 'config.toml'), isolatedConfig, { flag: 'wx' });
  const store = new ProjectStore(workspace);
  const project = await store.save(createExampleProject(), 0);
  await store.select('a');
  evidence.isolatedRoot = isolatedRoot;
  evidence.workspace = workspace;
  evidence.project = { id: project.id, name: project.name, revision: project.revision, nodeCount: project.nodes.length, bindingCount: project.bindings.length };

  const binary = await findCodexBinary();
  evidence.codexVersion = await new Promise<string>((resolve, reject) => execFile(binary, ['--version'], { windowsHide: true, timeout: 10_000, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  const environment = { ...process.env, CODEX_HOME: codexHome, RESEARCH_CANVAS_WORKSPACE: '', PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '') };
  for (const key of Object.keys(environment)) if (/^(?:OPENAI_API_KEY|CODEX_API_KEY|OPENAI_ACCESS_TOKEN|CODEX_ACCESS_TOKEN)$/i.test(key)) delete environment[key as keyof typeof environment];
  const spawnProcess = ((command: string, args: string[], options: Record<string, unknown>) => spawn(command, args, { ...options, env: environment, windowsHide: true, shell: false })) as typeof spawn;
  async function connect(): Promise<AppServerConnection> {
    const next = new AppServerConnection(binary, workspace, { spawnProcess, requestTimeoutMs: 25_000, persist: false });
    next.onServerRequest = notification => {
      if (notification.id !== undefined) next.reject(notification.id, 'Noninteractive installation acceptance check does not grant approvals.');
    };
    next.onFailure = error => { evidence.transportError = message(error); };
    await next.initialize();
    return next;
  }

  connection = await connect();
  const listed = await request('plugin/list', { cwds: [repository], marketplaceKinds: ['local'], forceRefetch: false });
  const marketplace = listed.marketplaces?.find((item: any) => item.name === 'research-canvas-local');
  evidence.marketplaceLoadErrors = listed.marketplaceLoadErrors;
  assert.ok(marketplace?.path, 'Repo marketplace must be discovered through plugin/list');
  const available = marketplace.plugins.find((item: any) => item.name === 'research-canvas');
  assert.ok(available, 'Research Canvas must appear in the official local plugin list');
  evidence.marketplace = { name: marketplace.name, path: marketplace.path, pluginId: available.id, installedBefore: available.installed };
  const installed = await request('plugin/install', { marketplacePath: marketplace.path, pluginName: 'research-canvas', installAttemptId: 'research-canvas-isolated-acceptance' });
  evidence.install = { authPolicy: installed.authPolicy, appsNeedingAuth: installed.appsNeedingAuth?.length ?? 0 };
  assert.equal(evidence.install.appsNeedingAuth, 0);
  const inventory = await request('plugin/installed', { cwds: [repository] });
  const summary = inventory.marketplaces?.flatMap((item: any) => item.plugins).find((item: any) => item.name === 'research-canvas');
  assert.ok(summary?.installed && summary.enabled, 'Installed plugin must be enabled');
  const detail = await request('plugin/read', { marketplacePath: marketplace.path, pluginName: 'research-canvas' });
  evidence.installed = { id: summary.id, installed: summary.installed, enabled: summary.enabled, version: summary.localVersion ?? summary.version, skills: detail.plugin?.skills?.map((item: any) => ({ name: item.name, enabled: item.enabled, path: item.path })), mcpServers: detail.plugin?.mcpServers };

  const cachedRoots = await findCachedRoots(path.join(codexHome, 'plugins', 'cache'));
  assert.equal(cachedRoots.length, 1, 'Plugin install must materialize one copied package in isolated CODEX_HOME');
  const cachedRoot = await realpath(cachedRoots[0]);
  assert.notEqual(cachedRoot, await realpath(path.join(repository, 'plugins', 'research-canvas')));
  const cachedMcp = JSON.parse(await readFile(path.join(cachedRoot, 'mcp.json'), 'utf8'));
  assert.equal(cachedMcp.mcpServers['research-canvas'].command, 'node');
  assert.deepEqual(cachedMcp.mcpServers['research-canvas'].args, ['${PLUGIN_ROOT}/server/mcp.mjs']);
  assert.ok((await stat(path.join(cachedRoot, 'server', 'mcp.mjs'))).isFile());
  assert.ok((await stat(path.join(cachedRoot, 'server', 'canvas.mjs'))).isFile());
  assert.ok((await stat(path.join(cachedRoot, 'web', 'index.html'))).isFile());
  evidence.cache = { root: cachedRoot, portablePlaceholder: '${PLUGIN_ROOT}', containsMcpBundle: true, containsCanvasBundle: true, containsWeb: true };
  evidence.checks.installCopy = true;

  // A fresh connection reflects a normal post-install runtime without touching the running desktop chat.
  connection.close();
  connection = await connect();
  const thread = await request('thread/start', { cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', ephemeral: true, serviceName: 'research_canvas_plugin_acceptance' });
  assert.ok(thread.thread?.id);
  evidence.thread = { id: thread.thread.id, sandbox: thread.sandbox, ephemeral: true, turnsStarted: 0 };
  const statuses = await request('mcpServerStatus/list', { threadId: thread.thread.id, detail: 'full' });
  const server = statuses.data?.find((item: any) => item.pluginId === summary.id || item.name.includes('research-canvas'));
  evidence.runtimeServers = statuses.data?.map((item: any) => ({ name: item.name, pluginId: item.pluginId, runtimeStatus: item.runtimeStatus, tools: Object.keys(item.tools ?? {}), toolsError: item.toolsError }));
  assert.ok(server, 'Installed plugin MCP server must be loaded into a fresh thread');
  const tools = Object.keys(server.tools ?? {}).sort();
  assert.deepEqual(tools, ['get_module_context', 'get_selected_module', 'list_modules', 'open_canvas', 'use_workspace']);
  assert.equal(server.runtimeStatus, 'connected');
  evidence.checks.pluginRuntimeDiscovery = true;
  const call = (tool: string, args: Record<string, unknown>) => request('mcpServer/tool/call', { threadId: thread.thread.id, server: server.name, tool, arguments: args });
  const selected = await call('use_workspace', { workspacePath: workspace });
  assert.ok(!selected.isError, 'Official runtime must invoke installed use_workspace');
  const modules = await call('list_modules', {});
  assert.ok(!modules.isError);
  const moduleText = modules.content?.find((item: any) => item.type === 'text')?.text;
  assert.equal(JSON.parse(moduleText).nodes.length, project.nodes.length);
  const context = await call('get_selected_module', {});
  assert.ok(!context.isError);
  const contextText = context.content?.find((item: any) => item.type === 'text')?.text ?? '';
  assert.match(contextText, /"bindings"/);
  assert.match(contextText, /bind-a-input-check/);
  evidence.toolCalls = { use_workspace: 'passed', list_modules: { status: 'passed', nodeCount: project.nodes.length }, get_selected_module: { status: 'passed', bindingsIncluded: true } };
  evidence.checks.installedToolsReadSavedProject = true;
  evidence.checks.noModelTurn = true;
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = message(error);
  process.exitCode = 1;
} finally {
  connection?.close();
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, codexVersion: evidence.codexVersion, checks: evidence.checks, error: evidence.error, evidence: evidencePath }, null, 2));
}
