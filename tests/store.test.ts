import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore, ConflictError, workspacePath } from '../server/store.js';
import { createProject } from '../src/shared/model.js';
import { createExampleProject, removeNode } from '../src/shared/model.js';

test('atomic save survives reload and concurrent stale save is rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'research-canvas-store-'));
  try {
    const store = new ProjectStore(root), project = createProject('保存测试');
    const saved = await store.save(project, 0);
    assert.equal(saved.revision, 1);
    assert.equal((await new ProjectStore(root).read()).name, '保存测试');
    const results = await Promise.allSettled([store.save({...saved,name:'新版本'},1),store.save({...saved,name:'过期版本'},1)]);
    assert.equal(results[0].status,'fulfilled');
    assert.equal(results[1].status,'rejected');
    if(results[1].status==='rejected') assert.ok(results[1].reason instanceof ConflictError);
    assert.equal(JSON.parse(await readFile(path.join(root,'.research-canvas/project.backup.json'),'utf8')).revision,1);
    await writeFile(store.filename,'{broken');
    await assert.rejects(()=>store.read(),/无法读取/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('file resolution rejects traversal and links outside workspace',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'research-canvas-path-'));
 try{
  await mkdir(path.join(root,'workspace'));
  await writeFile(path.join(root,'workspace','real.ts'),'export {}');
  assert.equal(await workspacePath(path.join(root,'workspace'),'real.ts'),path.join(root,'workspace','real.ts'));
  await assert.rejects(()=>workspacePath(path.join(root,'workspace'),'../outside.ts'));
  await mkdir(path.join(root,'outside'));
  await writeFile(path.join(root,'outside','secret.ts'),'private');
  await symlink(path.join(root,'outside'),path.join(root,'workspace','linked'),'junction');
  await assert.rejects(()=>workspacePath(path.join(root,'workspace'),'linked/secret.ts'),/工作区外部/);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('project storage rejects a metadata directory linked outside workspace',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'research-canvas-metadata-'));
 try{
  await mkdir(path.join(root,'workspace'));await mkdir(path.join(root,'outside'));
  await symlink(path.join(root,'outside'),path.join(root,'workspace','.research-canvas'),'junction');
  const store=new ProjectStore(path.join(root,'workspace'));
  await assert.rejects(()=>store.save(createProject('越界测试'),0),/工作区外部/);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('independent writers serialize and deleted selection becomes empty',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'research-canvas-writers-'));
 try{
  const first=new ProjectStore(root),second=new ProjectStore(root),project=await first.save(createExampleProject(),0);
  await first.select('a');
  const result=await Promise.allSettled([first.save({...project,name:'窗口一'},1),second.save({...project,name:'窗口二'},1)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(result.filter(r=>r.status==='rejected').length,1);
  const latest=await first.read();await first.save(removeNode(latest,'a'),latest.revision);
  assert.equal(await second.selection(),null);
 }finally{await rm(root,{recursive:true,force:true})}
});
