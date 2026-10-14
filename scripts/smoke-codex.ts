import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TaskManager } from '../integrations/codex.js';
if(!process.argv.includes('--run'))throw new Error('这是显式的真实 Codex 模型连接检查。使用 --run 发起一次只读测试。');
const root=path.resolve('artifacts','codex-smoke-workspace');await mkdir(root,{recursive:true});
const manager=new TaskManager(root,{reasoningEffort:'low'});
try{
 const task=await manager.start({kind:'plan',prompt:'这是 Research Canvas 连接验收测试。请不要使用任何工具，也不要读取或修改文件。请只回复以下文本：RESEARCH_CANVAS_CONNECTION_OK'});
 console.log('Started read-only integration smoke task:',task.id);
 const until=Date.now()+120000;
 while(Date.now()<until){
  const snapshot=manager.get(task.id)!;
  if(['completed','failed','cancelled','needs-approval'].includes(snapshot.status)){
   await writeFile(path.resolve('artifacts','codex-smoke-result.json'),JSON.stringify(snapshot,null,2));
   console.log(JSON.stringify({status:snapshot.status,output:snapshot.output,error:snapshot.error}));
   if(snapshot.status!=='completed'||!snapshot.output.includes('RESEARCH_CANVAS_CONNECTION_OK'))process.exitCode=1;
   break;
  }
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 if(!['completed','failed','cancelled'].includes(manager.get(task.id)!.status)){
  await manager.cancel(task.id);
  await writeFile(path.resolve('artifacts','codex-smoke-result.json'),JSON.stringify(manager.get(task.id),null,2));
  console.error('真实任务检查未在 120 秒内完成');process.exitCode=1;
 }
}finally{manager.close()}
