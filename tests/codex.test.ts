import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppServerConnection, TaskManager, probeCodex, type TaskSnapshot } from '../integrations/codex';

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  sent: any[] = [];
  killed = false;
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line);
      this.sent.push(message);
      queueMicrotask(() => this.handle(message));
    }
    callback();
  } });
  handle = (message: any) => {
    if (message.method === 'initialize') this.emitMessage({ id: message.id, result: { userAgent: 'mock/1' } });
    if (message.method === 'command/exec') {
      const [, , ,filename,marker]=message.params.command;
      void writeFile(filename,marker,{flag:'wx'}).then(()=>this.emitMessage({id:message.id,result:{exitCode:0,stdout:'written',stderr:''}}),error=>this.emitMessage({id:message.id,error:{message:error.message}}));
    }
    if (message.method === 'thread/start') this.emitMessage({ id: message.id, result: { thread: { id: 'thread-test' } } });
    if (message.method === 'turn/start') {
      this.emitMessage({ id: message.id, result: { turn: { id: 'turn-test', status: 'inProgress' } } });
      this.emitMessage({ method: 'turn/started', params: { turn: { id: 'turn-test' } } });
    }
    if (message.method === 'turn/interrupt') this.emitMessage({ id: message.id, result: {} });
  };
  emitMessage(message: any) { this.stdout.write(JSON.stringify(message) + '\n'); }
  kill() { this.killed = true; this.emit('exit', 0, null); return true; }
}
const fakeSpawn = (process: FakeProcess) => (() => process) as unknown as typeof spawn;
async function waitFor(manager: TaskManager, id: string, status: TaskSnapshot['status']) {
  for (let n = 0; n < 100; n++) {
    const task = manager.get(id)!;
    if (task.status === status) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Expected ${status}; got ${JSON.stringify(manager.get(id))}`);
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'research-canvas-codex-'));
  const process = new FakeProcess();
  const manager = new TaskManager(directory, { binary: 'codex-mock', spawnProcess: fakeSpawn(process), persist: false, requestTimeoutMs: 100 });
  return { directory, process, manager, async cleanup() { manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('stdio initializes before requests and parses a fragmented response', async () => {
  const process = new FakeProcess();
  process.handle = message => {
    if (message.method === 'initialize') {
      process.stdout.write('{"id":' + message.id + ',"res');
      process.stdout.write('ult":{"userAgent":"mock"}}\n');
    }
  };
  const connection = new AppServerConnection('mock', os.tmpdir(), { spawnProcess: fakeSpawn(process) });
  try {
    assert.deepEqual(await connection.initialize(), { userAgent: 'mock' });
    assert.deepEqual(process.sent.map(message => message.method), ['initialize', 'initialized']);
  } finally { connection.close(); }
});

test('research task remains read-only and streamed final output is not duplicated', async () => {
  const f = await fixture();
  try {
    const task = await f.manager.start({ prompt: 'Discuss convergence.', kind: 'research' });
    await waitFor(f.manager, task.id, 'running');
    await new Promise(resolve => setTimeout(resolve, 10));
    const thread = f.process.sent.find(message => message.method === 'thread/start');
    const turn = f.process.sent.find(message => message.method === 'turn/start');
    assert.equal(thread.params.sandbox, 'read-only');
    assert.equal(thread.params.approvalPolicy, 'on-request');
    assert.equal(thread.params.approvalsReviewer, 'user');
    assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    f.process.emitMessage({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Result' } });
    f.process.emitMessage({ method: 'error', params: { error: { message: 'Temporary retry' }, willRetry: true } });
    assert.equal(f.manager.get(task.id)?.error, 'Temporary retry');
    f.process.emitMessage({ method: 'item/completed', params: { item: { id: 'a', type: 'agentMessage', text: 'Result' } } });
    f.process.emitMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    assert.equal((await waitFor(f.manager, task.id, 'completed')).output, 'Result');
    assert.equal(f.manager.get(task.id)?.error, undefined);
    assert.equal(f.process.killed, true);
  } finally { await f.cleanup(); }
});

test('implementation approval waits for explicit decision and includes the proposed diff', async () => {
  const f = await fixture();
  try {
    const task = await f.manager.start({ prompt: 'Implement module.', kind: 'implement' });
    await waitFor(f.manager, task.id, 'running');
    f.process.emitMessage({ method: 'item/started', params: { item: { id: 'patch', type: 'fileChange', changes: [{ path: 'src/module.ts', diff: '+export const ok = true;' }] } } });
    f.process.emitMessage({ id: 900, method: 'item/fileChange/requestApproval', params: { itemId: 'patch', reason: 'Create module' } });
    const waiting = await waitFor(f.manager, task.id, 'needs-approval');
    assert.deepEqual((waiting.approvals[0].params.item as any).changes[0].path, 'src/module.ts');
    assert.equal(f.process.sent.some(message => message.id === 900), false);
    const approved = f.manager.approve(task.id, '900', 'accept');
    assert.equal(approved.status, 'running');
    assert.deepEqual(f.process.sent.find(message => message.id === 900), { id: 900, result: { decision: 'accept' } });
    const turn = f.process.sent.find(message => message.method === 'turn/start');
    assert.equal(turn.params.sandboxPolicy.type, 'workspaceWrite');
    assert.equal(turn.params.sandboxPolicy.networkAccess, false);
    assert.equal(turn.params.sandboxPolicy.excludeTmpdirEnvVar, true);
    assert.throws(() => f.manager.approve(task.id, '900', 'accept'), /失效/);
  } finally { await f.cleanup(); }
});

test('read-only tasks cannot accept escalations and unknown input requests fail closed', async () => {
  const f = await fixture();
  try {
    const task = await f.manager.start({ prompt: 'Choose a proposal.', kind: 'plan' });
    await waitFor(f.manager, task.id, 'running');
    f.process.emitMessage({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'write-file' } });
    await waitFor(f.manager, task.id, 'needs-approval');
    assert.throws(() => f.manager.approve(task.id, 'approval', 'accept'), /只读/);
    f.manager.approve(task.id, 'approval', 'decline');
    f.process.emitMessage({ id: 'input', method: 'item/tool/requestUserInput', params: { questions: [] } });
    assert.match((await waitFor(f.manager, task.id, 'failed')).error!, /尚未支持/);
    assert.equal(f.process.sent.find(message => message.id === 'input').error.code, -32601);
  } finally { await f.cleanup(); }
});

test('cancelling interrupts the known turn and late notifications cannot restore its state', async () => {
  const f = await fixture();
  try {
    const task = await f.manager.start({ prompt: 'Wait.', kind: 'implement' });
    await waitFor(f.manager, task.id, 'running');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await f.manager.cancel(task.id)).status, 'cancelled');
    assert.equal(f.process.sent.find(message => message.method === 'turn/interrupt').params.turnId, 'turn-test');
    f.process.emitMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    assert.equal(f.manager.get(task.id)!.status, 'cancelled');
  } finally { await f.cleanup(); }
});

test('RPC failures become failed tasks and version detection never starts inference', async () => {
  const f = await fixture();
  f.process.handle = message => f.process.emitMessage({ id: message.id, error: { code: -1, message: 'mock initialization failed' } });
  try {
    const task = await f.manager.start({ prompt: 'Should fail.', kind: 'implement' });
    assert.match((await waitFor(f.manager, task.id, 'failed')).error!, /mock initialization failed/);
    assert.equal(f.process.sent.some(message => message.method === 'turn/start'), false);
  } finally { await f.cleanup(); }
});

test('failed sandbox write probe stops before a model thread or turn is started',async()=>{
 const f=await fixture();
 const handle=f.process.handle;
 f.process.handle=message=>message.method==='command/exec'?f.process.emitMessage({id:message.id,result:{exitCode:1,stdout:'',stderr:'mock filesystem is not writable'}}):handle(message);
 try{
  const task=await f.manager.start({prompt:'Implement.',kind:'implement'});
  const failed=await waitFor(f.manager,task.id,'failed');
  assert.match(failed.error!,/工作区沙箱写入检查失败/);
  assert.equal(f.process.sent.some(message=>['thread/start','turn/start'].includes(message.method)),false);
  const probe=f.process.sent.find(message=>message.method==='command/exec');
  assert.equal(probe.params.sandboxPolicy.type,'workspaceWrite');
  assert.deepEqual(probe.params.sandboxPolicy.writableRoots,[f.directory]);
 }finally{await f.cleanup()}
});

test('completed task history survives a new manager', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'research-canvas-history-'));
  const process = new FakeProcess();
  const manager = new TaskManager(directory, { binary: 'mock', spawnProcess: fakeSpawn(process) });
  try {
    const context = { nodeId: 'module-a', nodeName: 'Module A', projectId: 'project-test', revision: 7 };
    const task = await manager.start({ prompt: 'Summarize.', kind: 'plan', context });
    await waitFor(manager, task.id, 'running');
    process.emitMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    await waitFor(manager, task.id, 'completed');
    for (let n = 0; n < 100; n++) {
      if ((await readdir(path.join(directory, '.research-canvas', 'tasks'))).some(name => name.endsWith('.json'))) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const reloaded = new TaskManager(directory);
    await reloaded.initialize();
    assert.equal(reloaded.get(task.id)?.status, 'completed');
    assert.deepEqual(reloaded.get(task.id)?.context, context);
    reloaded.close();
  } finally { manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real local App Server initialize handshake only (opt in; no model turn)', { skip: process.env.CODEX_HANDSHAKE_TEST !== '1' }, async () => {
  const result = await probeCodex();
  assert.equal(result.available, true, result.error);
  assert.match(result.version!, /codex/i);
});
