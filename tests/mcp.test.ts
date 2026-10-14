import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProjectStore } from '../server/store.js';
import { createExampleProject } from '../src/shared/model.js';

test(`real stdio MCP ${process.env.MCP_BUNDLE_TEST==='1'?'bundle':'source'} reads saved selection and shared module design`,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'research-canvas-mcp-'));
 const client=new Client({name:'research-canvas-integration-test',version:'0.1.0'});
 try{
  const store=new ProjectStore(root),project=createExampleProject();
  await store.save(project,0);
  await store.select(project.nodes[0].id);
  const args=process.env.MCP_BUNDLE_TEST==='1'?['plugins/research-canvas/server/mcp.mjs','--workspace',root]:['--import','tsx','integrations/mcp.ts','--workspace',root];
  await client.connect(new StdioClientTransport({command:process.execPath,args,cwd:process.cwd(),stderr:'pipe'}));
  const tools=await client.listTools();
  assert.deepEqual(tools.tools.map(t=>t.name).sort(),['get_module_context','get_selected_module','list_modules','open_canvas','use_workspace']);
  const result=await client.callTool({name:'get_selected_module',arguments:{}});
  assert.ok(!result.isError);
  assert.match(JSON.stringify(result.content),new RegExp(project.nodes[0].name));
  assert.match(JSON.stringify(result.content),/bind-a-input-check/);
  const bad=await client.callTool({name:'get_module_context',arguments:{nodeId:'nonexistent'}});
  assert.equal(bad.isError,true);
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
});

test('portable MCP starts without a workspace and switches only after explicit selection',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'research-canvas-setup-'));
 const client=new Client({name:'research-canvas-setup-test',version:'0.2.0'});
 try{
  const project=await new ProjectStore(root).save(createExampleProject(),0);
  const args=process.env.MCP_BUNDLE_TEST==='1'?['plugins/research-canvas/server/mcp.mjs']:['--import','tsx','integrations/mcp.ts'];
  await client.connect(new StdioClientTransport({command:process.execPath,args,cwd:process.cwd(),env:{...process.env,RESEARCH_CANVAS_WORKSPACE:''},stderr:'pipe'}));
  assert.equal((await client.callTool({name:'list_modules',arguments:{}})).isError,true);
  assert.equal((await client.callTool({name:'use_workspace',arguments:{workspacePath:'.'}})).isError,true);
  assert.ok(!(await client.callTool({name:'use_workspace',arguments:{workspacePath:root}})).isError);
  const listed=await client.callTool({name:'list_modules',arguments:{}});
  assert.match(JSON.stringify(listed.content),new RegExp(project.nodes[0].name));
  assert.equal((await client.callTool({name:'use_workspace',arguments:{workspacePath:path.join(root,'missing')}})).isError,true);
  assert.ok(!(await client.callTool({name:'list_modules',arguments:{}})).isError,'failed switch retains previous workspace');
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
});
