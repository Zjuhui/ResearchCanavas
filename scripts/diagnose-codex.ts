import { AppServerConnection, findCodexBinary } from '../integrations/codex.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Read supported runtime status without reading authentication files or starting a model turn.
const binary=await findCodexBinary();
const connection=new AppServerConnection(binary,process.cwd());
const report:Record<string,unknown>={checkedAt:new Date().toISOString()};
try{
 const init=await connection.initialize();
 report.initialize={userAgent:init?.userAgent};
 for(const [method,params] of [['account/read',{refreshToken:false}],['config/read',{includeLayers:false}],['model/list',{limit:50}]] as const){
  try{
   const result=await connection.request(method,params);
   if(method==='account/read') report.account={type:result?.account?.type,requiresOpenaiAuth:result?.requiresOpenaiAuth};
   if(method==='config/read') report.config={model:result?.config?.model,provider:result?.config?.model_provider,reasoningEffort:result?.config?.model_reasoning_effort,serviceTier:result?.config?.service_tier};
   if(method==='model/list') report.models=result?.data?.map((model:any)=>({id:model.id,model:model.model,isDefault:model.isDefault,hidden:model.hidden}));
  }catch(error){report[method]={error:(error as Error).message}}
 }
 await mkdir('artifacts',{recursive:true});
 await writeFile(path.resolve('artifacts','codex-diagnostics.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{connection.close()}
