import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectStore, ConflictError, workspaceFiles, workspacePath } from './store.js';
import { taskPrompt } from './prompts.js';
import { moduleContext } from '../src/shared/model.js';
import type { TaskKind } from '../src/shared/types.js';
import { TaskManager, probeCodex } from '../integrations/codex.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = process.env.RESEARCH_CANVAS_WEB_ROOT || path.join(appRoot, path.basename(fileURLToPath(import.meta.url)) === 'canvas.mjs' ? 'web' : 'dist');
const mime: Record<string, string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const json = (res:ServerResponse, status:number, data:unknown) => {res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须使用 application/json');
  let size=0; const chunks:Buffer[]=[];
  for await (const chunk of req) {const b=Buffer.from(chunk);size+=b.length;if(size>2_000_000)throw new Error('项目数据超过 2 MB 限制');chunks.push(b);}
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('请求内容必须是对象');
  return value;
}
async function vscodeBinary(): Promise<string | undefined> {
  const candidates=[process.env.VSCODE_BINARY,
    process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe'),
    process.env.ProgramFiles&&path.join(process.env.ProgramFiles,'Microsoft VS Code','Code.exe'),
    ...((process.env.PATH||'').split(path.delimiter).map(p=>path.join(p,process.platform==='win32'?'Code.exe':'code')))];
  for(const candidate of candidates){if(!candidate)continue;try{await access(candidate);return candidate}catch{}}
  return undefined;
}
export async function createApp(workspaceRoot: string, dev=false) {
  const root=await realpath(workspaceRoot),store=new ProjectStore(root),tasks=new TaskManager(root);
  await tasks.initialize();
  const vite=dev?await (await import('vite')).createServer({root:appRoot,server:{middlewareMode:true},appType:'spa'}):null;
  let health:Promise<unknown>|null=null;
  const server=createServer(async(req,res)=>{
    try{
      const host=req.headers.host||'';
      if(!/^127\.0\.0\.1:\d+$/.test(host)&&!/^localhost:\d+$/.test(host)){json(res,403,{error:'只允许本机访问'});return}
      const url=new URL(req.url||'/',`http://${host}`);
      if(url.pathname.startsWith('/api/')){
        const origin=req.headers.origin;
        if(origin&&origin!==`http://${host}`){json(res,403,{error:'拒绝跨来源访问'});return}
        if(req.method==='GET'&&url.pathname==='/api/project'){json(res,200,{project:await store.read(),workspaceRoot:root});return}
        if(req.method==='PUT'&&url.pathname==='/api/project'){const b=await body(req);if(!Number.isSafeInteger(b.expectedRevision)||Number(b.expectedRevision)<0)throw new Error('缺少有效版本号');json(res,200,{project:await store.save(b.project,Number(b.expectedRevision))});return}
        if(req.method==='GET'&&url.pathname==='/api/health'){health??=Promise.all([probeCodex(),vscodeBinary()]).then(([codex,code])=>({version:'0.2.0',codex,vscodeAvailable:!!code}));json(res,200,await health);return}
        if(req.method==='GET'&&url.pathname==='/api/workspace-files'){json(res,200,{files:await workspaceFiles(root)});return}
        if(req.method==='POST'&&url.pathname==='/api/selection'){const b=await body(req);if(b.nodeId!==null&&typeof b.nodeId!=='string')throw new Error('无效节点');await store.select(b.nodeId as string|null);json(res,200,{ok:true});return}
        if(req.method==='GET'&&url.pathname==='/api/selection'){json(res,200,{nodeId:await store.selection()});return}
        if(req.method==='GET'&&url.pathname.startsWith('/api/module/')){const project=await store.read();json(res,200,{context:moduleContext(project,decodeURIComponent(url.pathname.slice('/api/module/'.length)))});return}
        if(req.method==='POST'&&url.pathname==='/api/open-file'){
          const b=await body(req),project=await store.read(),file=project.files.find(f=>f.id===b.fileId);
          if(!file)throw new Error('文件映射不存在，请先保存项目');
          const filename=await workspacePath(root,file.path),binary=await vscodeBinary();
          if(!binary)throw new Error('未找到 VS Code。请设置 VSCODE_BINARY 为可执行文件路径。');
          const child=spawn(binary,['--reuse-window','--goto',filename],{stdio:'ignore',windowsHide:true,shell:false});
          await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref();
          json(res,200,{ok:true});return;
        }
        if(req.method==='POST'&&(url.pathname==='/api/tasks/preview'||url.pathname==='/api/tasks')){
          const b=await body(req);
          if(typeof b.nodeId!=='string'||!['research','plan','implement'].includes(String(b.kind)))throw new Error('请指定模块和任务类型');
          if(b.instruction!==undefined&&(typeof b.instruction!=='string'||b.instruction.length>10000))throw new Error('任务说明无效或过长');
          const project=await store.read(),kind=b.kind as TaskKind;
          if(url.pathname==='/api/tasks'&&b.expectedRevision!==project.revision)throw new ConflictError('设计版本已改变或尚未预览，请重新预览任务上下文后再发起。');
          if(!project.nodes.some(n=>n.id===b.nodeId))throw new Error('请先保存模块再发起任务');
          if(kind==='implement'&&!project.proposals.some(p=>p.nodeId===b.nodeId&&p.selected))throw new Error('请先为该模块保存并选定实现方案');
          const prompt=taskPrompt(project,b.nodeId,kind,b.instruction as string|undefined);
          if(url.pathname.endsWith('/preview'))json(res,200,{prompt,revision:project.revision});
          else json(res,202,{task:await tasks.start({prompt,kind,context:{nodeId:b.nodeId,nodeName:project.nodes.find(n=>n.id===b.nodeId)!.name,projectId:project.id,revision:project.revision}})});
          return;
        }
        if(req.method==='GET'&&url.pathname==='/api/tasks'){json(res,200,{tasks:tasks.list()});return}
        const match=/^\/api\/tasks\/([^/]+)(?:\/(cancel|approve))?$/.exec(url.pathname);
        if(match){const id=decodeURIComponent(match[1]);if(!tasks.get(id)){json(res,404,{error:'任务不存在'});return}
          if(req.method==='GET'&&!match[2]){json(res,200,{task:tasks.get(id)});return}
          if(req.method==='POST'){const b=await body(req);if(match[2]==='cancel'){json(res,200,{task:await tasks.cancel(id)});return}
            if(match[2]==='approve'){if(typeof b.approvalId!=='string'||!['accept','decline'].includes(String(b.decision)))throw new Error('审批参数无效');json(res,200,{task:tasks.approve(id,b.approvalId,b.decision as 'accept'|'decline')});return}}
        }
        json(res,404,{error:'接口不存在'});return;
      }
      if(vite){vite.middlewares(req,res);return}
      const requested=decodeURIComponent(url.pathname);
      const candidate=path.resolve(webRoot,'.'+requested);
      const dist=path.resolve(webRoot);
      if(candidate!==dist&&!candidate.startsWith(dist+path.sep)){json(res,403,{error:'路径无效'});return}
      let filename=candidate;
      try{if(!(await stat(filename)).isFile())filename=path.join(dist,'index.html')}catch{filename=path.join(dist,'index.html')}
      const data=await readFile(filename);
      res.writeHead(200,{'content-type':mime[path.extname(filename)]||'application/octet-stream','x-content-type-options':'nosniff'});res.end(data);
    }catch(error){json(res,error instanceof ConflictError?409:400,{error:(error as Error).message})}
  });
  async function close(){tasks.close();await vite?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  return {server,store,tasks,close};
}
async function main(){
 const args=process.argv.slice(2),workspaceIndex=args.indexOf('--workspace'),portIndex=args.indexOf('--port');
 const root=workspaceIndex>=0?args[workspaceIndex+1]:process.env.RESEARCH_CANVAS_WORKSPACE||process.cwd();
 const port=Number(portIndex>=0?args[portIndex+1]:process.env.PORT||3177);
 if(!root||!Number.isInteger(port)||port<1||port>65535)throw new Error('工作区或端口参数无效');
 const app=await createApp(root,args.includes('--dev'));
 app.server.on('error',error=>{console.error(error.message);process.exitCode=1});
 app.server.listen(port,'127.0.0.1',()=>console.log(`Research Canvas: http://127.0.0.1:${port}\n工作区: ${path.resolve(root)}`));
 for(const event of ['SIGINT','SIGTERM'] as const)process.once(event,()=>{void app.close().then(()=>process.exit())});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1});
