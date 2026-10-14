import { mkdir, readFile, rename, writeFile, realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { createProject, validateProject, normalizeFilePath } from '../src/shared/model.js';
import type { Project } from '../src/shared/types.js';

export class ConflictError extends Error {}
export class ProjectStore {
  readonly directory: string;
  readonly filename: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly workspaceRoot: string) {
    this.directory = path.join(workspaceRoot, '.research-canvas');
    this.filename = path.join(this.directory, 'project.json');
  }
  private async checkDirectory(create = false): Promise<void> {
    if (create) await mkdir(this.directory, { recursive: true });
    const root = await realpath(this.workspaceRoot), actual = await realpath(this.directory);
    if (!isWithin(root, actual)) throw new Error('项目保存目录指向工作区外部');
  }
  async read(): Promise<Project> {
    try {
      await this.checkDirectory();
      if (!isWithin(await realpath(this.workspaceRoot), await realpath(this.filename))) throw new Error('项目文件指向工作区外部');
      return validateProject(JSON.parse(await readFile(this.filename, 'utf8')));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createProject(path.basename(this.workspaceRoot));
      throw new Error(`项目文件无法读取，请保留原文件并检查内容：${(error as Error).message}`);
    }
  }
  async save(value: unknown, expectedRevision: number): Promise<Project> {
    const work = this.queue.then(async () => {
      const project = validateProject(value);
      await this.checkDirectory(true);
      let compromised: Error | undefined;
      // checkDirectory already validates the real path. Avoid a second JS realpath walk
      // through home-directory ancestors that restricted Windows sandboxes may deny.
      const release = await lockfile.lock(this.directory, {realpath:false,lockfilePath:path.join(this.directory,'project.lock'),retries:{retries:30,minTimeout:30,maxTimeout:150},stale:10000,update:2000,onCompromised:error=>{compromised=error}});
      try {
      const previous = await this.read();
      if (previous.revision !== expectedRevision) throw new ConflictError('项目已由其他窗口更新。请导出当前修改，再重新加载项目。');
      const next = { ...project, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
      await this.checkDirectory(true);
      try {
        const backupTemp = path.join(this.directory, `backup.${randomUUID()}.tmp`);
        await writeFile(backupTemp, await readFile(this.filename), { mode: 0o600 });
        await rename(backupTemp, path.join(this.directory, 'project.backup.json'));
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const temp = path.join(this.directory, `project.${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      if(compromised)throw new Error('保存锁已失效，请重试保存');
      await rename(temp, this.filename);
      return next;
      } finally { await release(); }
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async selection(): Promise<string | null> {
    try { await this.checkDirectory();const filename=path.join(this.directory,'selection.json');if(!isWithin(await realpath(this.workspaceRoot),await realpath(filename)))throw new Error('所选模块文件超出工作区');const value = JSON.parse(await readFile(filename, 'utf8')); return typeof value.nodeId === 'string' && (await this.read()).nodes.some(n=>n.id===value.nodeId) ? value.nodeId : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async select(nodeId: string | null): Promise<void> {
    const project = await this.read();
    if (nodeId !== null && !project.nodes.some(n => n.id === nodeId)) throw new Error('请先保存节点，再将它分享给 Codex。');
    await this.checkDirectory(true);
    const filename = path.join(this.directory, 'selection.json');
    const temp = filename + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify({ nodeId, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(temp, filename);
  }
}

export async function workspacePath(root: string, relative: string, mustExist = true): Promise<string> {
  const normalized = normalizeFilePath(relative);
  const rootReal = await realpath(root);
  const candidate = path.resolve(rootReal, ...normalized.split('/'));
  if (!isWithin(rootReal, candidate)) throw new Error('路径超出工作区');
  if (mustExist) {
    const actual = await realpath(candidate);
    if (!isWithin(rootReal, actual)) throw new Error('文件链接指向工作区外部');
    if (!(await stat(actual)).isFile()) throw new Error('请选择代码文件');
    return actual;
  }
  return candidate;
}
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export async function workspaceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const excluded = new Set(['node_modules', '.git', '.research-canvas', 'dist', '.venv', '__pycache__', '.codex', '.env']);
  async function visit(directory: string, prefix = '', depth = 0): Promise<void> {
    if (depth > 10 || files.length >= 2000) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name.startsWith('.env') || entry.isSymbolicLink()) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/', depth + 1);
      else if (entry.isFile()) files.push(relative);
      if (files.length >= 2000) break;
    }
  }
  await visit(root);
  return files.sort();
}
