import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {tmpdir} from 'node:os';
import { createExampleProject, attachFile } from '../src/shared/model.js';
import { ProjectStore } from '../server/store.js';
import { taskPrompt } from '../server/prompts.js';
import { TaskManager, type TaskSnapshot } from '../integrations/codex.js';

if(!process.argv.includes('--run'))throw new Error('使用 --run 显式发起三个真实模型任务；会在独立验收工作区生成代码。');
await mkdir('artifacts',{recursive:true});
const resumeIndex=process.argv.indexOf('--resume');
const resume=resumeIndex>=0?process.argv[resumeIndex+1]:undefined;
const sourceWorkspace=resume?path.resolve(resume):undefined;
let workspace=sourceWorkspace||await mkdtemp(path.join(tmpdir(),'codex-e2e-'));
if(resume&&((!workspace.startsWith(path.resolve('artifacts')+path.sep)&&!workspace.startsWith(path.resolve(tmpdir())+path.sep))||!path.basename(workspace).startsWith('codex-e2e-')))throw new Error('仅允许恢复 artifacts 或系统临时目录下的隔离验收工作区');
let store=new ProjectStore(workspace);
let project=resume?await store.read():createExampleProject();
if(resume&&process.argv.includes('--relocate')){
 workspace=await mkdtemp(path.join(tmpdir(),'codex-e2e-'));store=new ProjectStore(workspace);
 project=await store.save(project,0);await store.select('b');
}
if(!resume){
project.name='验收夹具：A/B/C 标量迭代（不是研究成果）';
project.description='真实 Codex 调研输出、方案输出、生成代码与独立测试的集成验收夹具；只验证产品连接流程，不构成新研究或算法有效性证据。';
project.nodes.find(n=>n.id==='b')!.description='用纯 JavaScript 实现标量二次目标 f(x)=x²/2 的固定步长迭代。外层 A 提供输入，B 更新参数，C 判断收敛与次数上限。此夹具选择固定步长，不需要新增算法决定。';
project=attachFile(project,'b1','src/optimizer.mjs');
project=await store.save(project,0);
await store.select('b');
}
const modelIndex=process.argv.indexOf('--model');
const model=modelIndex>=0?process.argv[modelIndex+1]:undefined;
const manager=new TaskManager(workspace,{reasoningEffort:'low',model});
const report:{workspace:string;tasks:TaskSnapshot[];checks?:unknown;error?:string;validationModel?:string}={workspace,tasks:[],validationModel:model||'用户当前配置模型'};
if(resume){
 const previous=await readFile('artifacts/codex-e2e-result.json','utf8').then(JSON.parse).catch(()=>null);
 if(previous?.workspace===sourceWorkspace&&Array.isArray(previous.tasks))report.tasks=previous.tasks;
}
async function run(kind:'research'|'plan'|'implement',instruction:string){
 const started=await manager.start({kind,prompt:taskPrompt(project,'b',kind,instruction),context:{projectId:project.id,nodeId:'b',nodeName:'B · 迭代优化',revision:project.revision}});
 console.log(`Started ${kind}: ${started.id}`);
 const until=Date.now()+180000;
 let lastStatus='';
 while(Date.now()<until){
  const task=manager.get(started.id)!;
  if(task.status!==lastStatus){console.log(`${kind}: ${task.status}`);lastStatus=task.status}
  if(['completed','failed','cancelled','needs-approval'].includes(task.status)){
   if(task.status==='needs-approval')await manager.cancel(task.id);
   report.tasks.push(manager.get(task.id)!);
   if(task.status!=='completed')throw new Error(`${kind} 未通过：${task.error||task.status}；审批请求不会由验收脚本自动批准。`);
   return task.output;
  }
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 await manager.cancel(started.id);report.tasks.push(manager.get(started.id)!);throw new Error(`${kind} 超过 180 秒已取消`);
}
try{
 if(!resume){
 const research=await run('research','这是产品连接验收。限 500 字，比较固定步长和自适应步长用于 f(x)=x²/2 的适用条件。可以使用现有调研工具；若没有实际查阅来源，明确标注“未查阅外部来源”，不编造论文。无需运行命令或读写文件。');
 project.research.push({id:'e2e-research',nodeId:'b',title:'真实模型输出：方法比较（未独立核验）',url:'',notes:research,status:'unverified'});
 project=await store.save(project,project.revision);
 await run('plan','限 500 字，提出两个可比较方案和边界情况。此时不要选择方案，不使用工具，不读写文件。');
 project.proposals.push({id:'e2e-proposal',nodeId:'b',title:'验收夹具预先指定：固定步长',description:'按显式验收约定实现：src/optimizer.mjs 导出 solve({initial,stepSize,tolerance,maxIterations})。initial 为有限数；0<stepSize<2；tolerance>0；maxIterations 为非负安全整数；非法参数抛错。每轮 x=(1-stepSize)*x，计数从0开始，先检查 |x|<=tolerance，再检查次数上限。返回 {value,iterations,converged}。初始即收敛返回0次；maxIterations=0时不更新。不得增加依赖。',selected:true});
 project=await store.save(project,project.revision);
 }
 await run('implement','这是隔离的真实生成验收夹具。已预先明确选定方案与全部边界规则。用内置工具实际创建 src/optimizer.mjs；只需写这一文件，不用执行测试或命令，不修改 .research-canvas。可先检查该路径是否存在。不能只在回复中给代码。');
 const source=await readFile(path.join(workspace,'src','optimizer.mjs'),'utf8');
 if(!source.includes('solve'))throw new Error('模型没有生成约定实现文件');
 const testSource=`import test from 'node:test';
import assert from 'node:assert/strict';
import {solve} from './src/optimizer.mjs';
const defaults={initial:8,stepSize:0.5,tolerance:1e-6,maxIterations:100};
test('converges with the expected iteration count',()=>{const r=solve(defaults);assert.equal(r.iterations,23);assert.equal(r.converged,true);assert.ok(Math.abs(r.value)<=1e-6)});
test('stops at iteration limit',()=>{const r=solve({...defaults,maxIterations:2});assert.equal(r.iterations,2);assert.equal(r.value,2);assert.equal(r.converged,false)});
test('initial convergence takes zero steps',()=>{const r=solve({...defaults,initial:0});assert.equal(r.iterations,0);assert.equal(r.converged,true)});
test('zero iteration limit preserves input',()=>{const r=solve({...defaults,maxIterations:0});assert.equal(r.value,8);assert.equal(r.iterations,0);assert.equal(r.converged,false)});
test('invalid numeric parameters are rejected',()=>{for(const patch of [{initial:NaN},{stepSize:0},{stepSize:2},{tolerance:0},{maxIterations:-1},{maxIterations:1.5}])assert.throws(()=>solve({...defaults,...patch}))});
`;
 await writeFile(path.join(workspace,'acceptance.test.mjs'),testSource);
 const result=await promisify(execFile)(process.execPath,['--test','acceptance.test.mjs'],{cwd:workspace,windowsHide:true,timeout:30000});
 report.checks={generatedFile:'src/optimizer.mjs',independentTests:result.stdout,passed:true};
 console.log(result.stdout);
}catch(error){report.error=(error as Error).message;console.error(report.error);process.exitCode=1}
finally{manager.close();await writeFile('artifacts/codex-e2e-result.json',JSON.stringify(report,null,2)+'\n');console.log('Evidence workspace:',workspace)}
