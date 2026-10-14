import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readdir, realpath, mkdir, writeFile, rename, readFile, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export type TaskKind = 'research' | 'plan' | 'implement';
export type TaskStatus = 'starting' | 'running' | 'needs-approval' | 'completed' | 'failed' | 'cancelled';
export interface Approval { id: string; method: string; params: Record<string, unknown> }
export interface TaskSnapshot {
  id: string; kind: TaskKind; status: TaskStatus; threadId?: string;
  output: string; error?: string; approvals: Approval[]; createdAt: string; updatedAt: string;
  context?: { nodeId:string; nodeName:string; projectId:string; revision:number };
}
export interface TaskManagerOptions {
  binary?: string;
  spawnProcess?: typeof spawn;
  requestTimeoutMs?: number;
  persist?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  model?: string;
}
type WireMessage = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: any; error?: { message?: string; code?: number } };
const terminal = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
const outputLimit = 100_000;
const clone = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 4000);
function redact(text: string): string {
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[credential redacted]')
    .replace(/((?:authorization\s*[:=]\s*bearer|(?:access_token|refresh_token|api_key)\s*["']?\s*[:=]\s*["']?)\s*)[^\s,"']+/gi, '$1[redacted]');
}

/** No shell is involved in discovery or launching. CODEX_BINARY must point to an executable. */
export async function findCodexBinary(): Promise<string> {
  if (process.env.CODEX_BINARY) {
    const candidate = path.resolve(process.env.CODEX_BINARY);
    await access(candidate, constants.X_OK);
    return candidate;
  }
  const candidates: string[] = [];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const appBin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const entries = await readdir(appBin, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter(entry => entry.isDirectory()).reverse()) candidates.push(path.join(appBin, entry.name, 'codex.exe'));
  }
  for (const entry of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  }
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next candidate */ }
  }
  throw new Error('未找到 Codex 可执行文件。请安装 Codex CLI，或将 CODEX_BINARY 设置为可执行文件的完整路径。');
}

/** JSONL stdio transport. Never starts a turn by itself. */
export class AppServerConnection {
  private process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = '';
  private stopped = false;
  private pending = new Map<string | number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onNotification: (message: WireMessage) => void = () => {};
  onServerRequest: (message: WireMessage) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(binary: string, cwd: string, private options: TaskManagerOptions = {}) {
    this.process = (options.spawnProcess ?? spawn)(binary, ['app-server', '--listen', 'stdio://'], {
      cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    }) as ChildProcessWithoutNullStreams;
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.consume(chunk));
    // Drain stderr without displaying configuration, credentials, or inherited environment details.
    this.process.stderr.resume();
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => {
      if (!this.stopped) this.fail(new Error(`Codex App Server 提前退出（${signal ?? code ?? 'unknown'}）。`));
    });
    this.process.stdin.on('error', error => this.fail(error));
  }

  async initialize(): Promise<any> {
    const result = await this.request('initialize', {
      clientInfo: { name: 'research_canvas', title: 'Research Canvas', version: '0.2.0' },
      capabilities: null,
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('Codex 连接已关闭。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, this.options.requestTimeoutMs ?? 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id: string | number, result: Record<string, unknown>): void { this.send({ id, result }); }
  reject(id: string | number, message: string): void { this.send({ id, error: { code: -32601, message } }); }
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex 连接已关闭。')); }
    this.pending.clear();
    this.process.stdin.end();
    this.process.kill();
  }

  private send(message: WireMessage): void {
    if (this.stopped) throw new Error('Codex 连接已关闭。');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  private fail(error: Error): void {
    if (this.stopped) return;
    this.close();
    this.onFailure(error);
  }
  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4_000_000) { this.fail(new Error('Codex 消息超过大小上限。')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: WireMessage;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('Codex App Server 返回了无效 JSON 消息。')); return; }
      if (!message || typeof message !== 'object') { this.fail(new Error('Codex App Server 返回了无效协议消息。')); return; }
      if (message.method) {
        if (message.id !== undefined) this.onServerRequest(message);
        else this.onNotification(message);
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? `Codex 协议错误 ${message.error.code}`));
        else pending.resolve(message.result);
      }
    }
  }
}

export async function probeCodex(): Promise<{ available: boolean; version?: string; error?: string }> {
  let connection: AppServerConnection | undefined;
  let version: string | undefined;
  try {
    const binary = await findCodexBinary();
    version = await new Promise<string>((resolve, reject) => execFile(binary, ['--version'], { windowsHide: true, timeout: 10_000, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(redact(stdout.trim()))));
    connection = new AppServerConnection(binary, process.cwd());
    await connection.initialize();
    return { available: true, version };
  } catch (error) { return { available: false, version, error: errorText(error) }; }
  finally { connection?.close(); }
}

/** Verify the actual scoped sandbox can write; never relax its permissions on failure. */
export async function verifyWorkspaceWrite(connection: AppServerConnection, cwd: string): Promise<void> {
  const directory=path.join(cwd,'.research-canvas');
  await mkdir(directory,{recursive:true});
  const realDirectory=await realpath(directory),relative=path.relative(cwd,realDirectory);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('写入检查目录超出工作区');
  const filename=path.join(realDirectory,`write-check-${randomUUID()}.tmp`),marker=randomUUID();
  try {
    const program="require('node:fs').writeFileSync(process.argv[1],process.argv[2],{flag:'wx'});process.stdout.write('written');";
    const result=await connection.request('command/exec',{command:[process.execPath,'-e',program,filename,marker],cwd,timeoutMs:10000,sandboxPolicy:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});
    if(result?.exitCode!==0)throw new Error(errorText(result?.stderr||'沙箱写入命令失败').slice(0,800));
    if(await readFile(filename,'utf8')!==marker)throw new Error('无法在实际文件系统中确认沙箱写入');
  }catch(error){
    throw new Error(`工作区沙箱写入检查失败，尚未调用模型。请检查工作区权限与沙箱配置，或选择通过写入检查的目录。${errorText(error)}`);
  }finally{await unlink(filename).catch(()=>{})}
}

interface ManagedTask {
  snapshot: TaskSnapshot; connection?: AppServerConnection; turnId?: string;
  requestIds: Map<string, string | number>; items: Map<string, Record<string, unknown>>;
  streamedItems: Set<string>; lastError?: string;
}

export class TaskManager {
  private tasks = new Map<string, ManagedTask>();
  private persistence: Promise<void> = Promise.resolve();
  private ready: Promise<void>;
  constructor(private workspaceRoot: string, private options: TaskManagerOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.ready = this.loadHistory();
  }

  async initialize(): Promise<void> { await this.ready; }

  async start(input: { prompt: string; kind: TaskKind; context?:TaskSnapshot['context'] }): Promise<TaskSnapshot> {
    await this.ready;
    if (!['research', 'plan', 'implement'].includes(input.kind)) throw new Error('任务类型无效。');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 100_000) throw new Error('任务说明必须为 1 至 100000 个字符。');
    if ([...this.tasks.values()].some(task => !terminal.has(task.snapshot.status))) throw new Error('已有任务正在进行，请等待完成或先取消。');
    const now = new Date().toISOString();
    const task: ManagedTask = {
      snapshot: { id: randomUUID(), kind: input.kind, status: 'starting', output: '', approvals: [], createdAt: now, updatedAt: now, context:input.context?clone(input.context):undefined },
      requestIds: new Map(), items: new Map(), streamedItems: new Set(),
    };
    this.tasks.set(task.snapshot.id, task);
    void this.begin(task, input.prompt);
    return clone(task.snapshot);
  }

  list(): TaskSnapshot[] { return [...this.tasks.values()].map(task => clone(task.snapshot)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): TaskSnapshot | undefined { const task = this.tasks.get(id); return task && clone(task.snapshot); }

  async cancel(id: string): Promise<TaskSnapshot> {
    const task = this.requireTask(id);
    if (terminal.has(task.snapshot.status)) return clone(task.snapshot);
    const connection = task.connection;
    this.finish(task, 'cancelled');
    // Send interruption when a turn is known, then close even if the peer is unresponsive.
    if (connection && task.snapshot.threadId && task.turnId) {
      await Promise.race([
        connection.request('turn/interrupt', { threadId: task.snapshot.threadId, turnId: task.turnId }).catch(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, 1000)),
      ]);
    }
    connection?.close();
    return clone(task.snapshot);
  }

  approve(taskId: string, approvalId: string, decision: 'accept' | 'decline' | 'cancel'): TaskSnapshot {
    const task = this.requireTask(taskId);
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('审批决定无效。');
    if (terminal.has(task.snapshot.status)) throw new Error('任务已结束，审批已失效。');
    const approval = task.snapshot.approvals.find(approval => approval.id === approvalId);
    const wireId = task.requestIds.get(approvalId);
    if (!approval || wireId === undefined || !task.connection) throw new Error('审批不存在或已失效。');
    if (decision === 'accept' && task.snapshot.kind !== 'implement') throw new Error('调研和方案任务保持只读，无法批准提升权限。请拒绝此请求或创建实现任务。');
    task.connection.respond(wireId, { decision });
    task.requestIds.delete(approvalId);
    task.snapshot.approvals = task.snapshot.approvals.filter(approval => approval.id !== approvalId);
    task.snapshot.status = task.snapshot.approvals.length ? 'needs-approval' : 'running';
    this.touch(task);
    return clone(task.snapshot);
  }

  close(): void {
    for (const task of this.tasks.values()) {
      if (!terminal.has(task.snapshot.status)) this.finish(task, 'cancelled');
      task.connection?.close();
    }
  }

  private requireTask(id: string): ManagedTask { const task = this.tasks.get(id); if (!task) throw new Error('任务不存在。'); return task; }
  private touch(task: ManagedTask): void { task.snapshot.updatedAt = new Date().toISOString(); }
  private append(task: ManagedTask, text: string): void {
    const output = redact(task.snapshot.output + text);
    task.snapshot.output = output.length <= outputLimit ? output : '[较早输出已截断]\n' + output.slice(-outputLimit);
    this.touch(task);
  }
  private finish(task: ManagedTask, status: 'completed' | 'failed' | 'cancelled', error?: string): void {
    if (terminal.has(task.snapshot.status)) return;
    task.snapshot.status = status;
    if (status === 'completed') delete task.snapshot.error;
    if (error) task.snapshot.error = errorText(error);
    task.snapshot.approvals = [];
    task.requestIds.clear();
    this.touch(task);
    this.persist(task.snapshot);
  }

  private async begin(task: ManagedTask, prompt: string): Promise<void> {
    try {
      const cwd = await realpath(this.workspaceRoot);
      const binary = this.options.binary ?? await findCodexBinary();
      if (terminal.has(task.snapshot.status)) return;
      const connection = task.connection = new AppServerConnection(binary, cwd, this.options);
      connection.onFailure = error => this.finish(task, 'failed', errorText(error));
      connection.onNotification = message => this.notification(task, message);
      connection.onServerRequest = message => this.serverRequest(task, message);
      await connection.initialize();
      if (terminal.has(task.snapshot.status)) return;
      const implement = task.snapshot.kind === 'implement';
      if(implement)await verifyWorkspaceWrite(connection,cwd);
      if (terminal.has(task.snapshot.status)) return;
      const thread = await connection.request('thread/start', {
        cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandbox: implement ? 'workspace-write' : 'read-only',
        serviceName: 'research_canvas',
        ...(this.options.model ? { model: this.options.model } : {}),
      });
      if (!thread?.thread?.id) throw new Error('Codex 未返回有效 thread.id。');
      task.snapshot.threadId = thread.thread.id;
      if (terminal.has(task.snapshot.status)) return;
      task.snapshot.status = 'running';
      this.touch(task);
      const turn = await connection.request('turn/start', {
        threadId: task.snapshot.threadId, cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(this.options.reasoningEffort ? { effort: this.options.reasoningEffort } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        sandboxPolicy: implement
          ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false },
      });
      task.turnId = turn?.turn?.id;
    } catch (error) {
      this.finish(task, 'failed', errorText(error));
      task.connection?.close();
    }
  }

  private notification(task: ManagedTask, message: WireMessage): void {
    if (terminal.has(task.snapshot.status)) return;
    const params = message.params ?? {};
    if (message.method === 'turn/started') task.turnId = (params.turn as any)?.id;
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item as Record<string, unknown> | undefined;
      if (item && typeof item.id === 'string') {
        task.items.set(item.id, clone(item));
        if (message.method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string' && !task.streamedItems.has(item.id)) this.append(task, item.text + '\n\n');
      }
    }
    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      task.streamedItems.add(String(params.itemId));
      this.append(task, params.delta);
    }
    if (message.method === 'serverRequest/resolved') {
      const approvalId = String(params.requestId);
      task.requestIds.delete(approvalId);
      task.snapshot.approvals = task.snapshot.approvals.filter(approval => approval.id !== approvalId);
      task.snapshot.status = task.snapshot.approvals.length ? 'needs-approval' : 'running';
    }
    if (message.method === 'error') { task.lastError = errorText((params.error as any)?.message ?? 'Codex 执行错误。');task.snapshot.error=task.lastError; }
    if (message.method === 'turn/completed') {
      const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
      if (turn?.status === 'completed') this.finish(task, 'completed');
      else if (turn?.status === 'interrupted') this.finish(task, 'cancelled');
      else this.finish(task, 'failed', turn?.error?.message ?? task.lastError ?? 'Codex 任务未成功完成。');
      task.connection?.close();
    }
    this.touch(task);
  }

  private serverRequest(task: ManagedTask, message: WireMessage): void {
    if (message.id === undefined || !task.connection) return;
    if (terminal.has(task.snapshot.status)) { task.connection.reject(message.id, 'Task is no longer active'); return; }
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      const id = String(message.id);
      const params = clone(message.params ?? {});
      // Approval messages may omit the proposed diff/command; retain its preceding item for review.
      const itemId = params.itemId;
      if (typeof itemId === 'string' && task.items.has(itemId)) params.item = clone(task.items.get(itemId));
      task.requestIds.set(id, message.id);
      task.snapshot.approvals.push({ id, method: message.method, params });
      task.snapshot.status = 'needs-approval';
      this.touch(task);
      return;
    }
    task.connection.reject(message.id, 'Research Canvas does not support this interactive request. Continue in Codex desktop for this workflow.');
    this.finish(task, 'failed', `Codex 请求了尚未支持的交互：${message.method}。请在 Codex 桌面聊天中继续。`);
    task.connection.close();
  }

  private async historyDirectory(): Promise<string> {
    const root = await realpath(this.workspaceRoot);
    const base = path.join(root, '.research-canvas');
    await mkdir(base, { recursive: true });
    const resolvedBase = await realpath(base);
    const baseRelative = path.relative(root, resolvedBase);
    if (baseRelative.startsWith('..' + path.sep) || baseRelative === '..' || path.isAbsolute(baseRelative)) throw new Error('任务保存目录超出工作区。');
    const directory = path.join(resolvedBase, 'tasks');
    await mkdir(directory, { recursive: true });
    const resolved = await realpath(directory);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('任务保存目录超出工作区。');
    return resolved;
  }
  private persist(snapshot: TaskSnapshot): void {
    if (this.options.persist === false) return;
    const saved = clone(snapshot);
    this.persistence = this.persistence.then(async () => {
      const directory = await this.historyDirectory();
      const destination = path.join(directory, saved.id + '.json');
      const temporary = destination + '.tmp';
      await writeFile(temporary, JSON.stringify(saved, null, 2), { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, destination);
    }).catch(() => { /* A history write must not turn successful inference into a failed task. */ });
  }
  private async loadHistory(): Promise<void> {
    if (this.options.persist === false) return;
    try {
      const directory = await this.historyDirectory();
      for (const name of (await readdir(directory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).slice(-100)) {
        const filePath = path.join(directory, name);
        const resolved = await realpath(filePath);
        if (path.dirname(resolved) !== directory) continue;
        if ((await stat(resolved)).size > 500_000) continue;
        const snapshot = JSON.parse(await readFile(resolved, 'utf8')) as TaskSnapshot;
        if (snapshot.id + '.json' !== name || !terminal.has(snapshot.status) || typeof snapshot.output !== 'string' || !['research', 'plan', 'implement'].includes(snapshot.kind) || typeof snapshot.createdAt !== 'string' || typeof snapshot.updatedAt !== 'string') continue;
        snapshot.output = redact(snapshot.output).slice(-outputLimit);
        snapshot.approvals = [];
        this.tasks.set(snapshot.id, { snapshot, requestIds: new Map(), items: new Map(), streamedItems: new Set() });
      }
    } catch { /* History is optional; new tasks still work when a malformed history file exists. */ }
  }
}
