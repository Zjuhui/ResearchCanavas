import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { createExampleProject } from '../src/shared/model.js';
test('HTTP saves/reloads, rejects stale writes, invalid project and cross origin',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'research-canvas-http-'));
 const app=await createApp(root);
 try{
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));
  const port=(app.server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`;
  const initial=await (await fetch(base+'/api/project')).json() as any;
  const options={method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({project:{...initial.project,name:'HTTP 持久化'},expectedRevision:0})};
  assert.equal((await fetch(base+'/api/project',options)).status,200);
  assert.equal((await (await fetch(base+'/api/project')).json() as any).project.name,'HTTP 持久化');
  assert.equal((await fetch(base+'/api/project',options)).status,409);
  assert.equal((await fetch(base+'/api/project',{...options,headers:{...options.headers,origin:'http://untrusted.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/project',{...options,body:JSON.stringify({project:{schemaVersion:1},expectedRevision:1})})).status,400);
  assert.equal((await fetch(base+'/api/tasks/preview',{method:'POST',headers:options.headers,body:JSON.stringify({nodeId:'missing',kind:'research'})})).status,400);
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
});

test('task preview matches a saved revision and stale launches never start Codex', async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'research-canvas-preview-'));
 const app=await createApp(root);
 try{
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const project=await app.store.save(createExampleProject(),0);
  const payload={nodeId:project.nodes[0].id,kind:'research'};
  const post=(url:string,value:unknown)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  const preview=await (await post('/api/tasks/preview',payload)).json() as {prompt:string;revision:number};
  assert.equal(preview.revision,project.revision);
  assert.match(preview.prompt,new RegExp(project.nodes[0].name));
  assert.equal((await post('/api/tasks',payload)).status,409);
  await app.store.save({...project,name:'Changed after preview'},project.revision);
  assert.equal((await post('/api/tasks',{...payload,expectedRevision:preview.revision})).status,409);
  assert.deepEqual(app.tasks.list(),[]);
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
});
