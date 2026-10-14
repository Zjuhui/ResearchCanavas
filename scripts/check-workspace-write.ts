import {readFile,mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AppServerConnection,findCodexBinary,verifyWorkspaceWrite} from '../integrations/codex.js';
const index=process.argv.indexOf('--workspace');
const workspace=index>=0?await realpath(process.argv[index+1]):await mkdtemp(path.join(tmpdir(),'research-canvas-write-check-'));
const connection=new AppServerConnection(await findCodexBinary(),workspace);
try{
 await connection.initialize();
 await verifyWorkspaceWrite(connection,workspace);
 console.log(JSON.stringify({workspace,workspaceWrite:'passed',modelTurnsStarted:0}));
}catch(error){console.error((error as Error).message);process.exitCode=1;
}finally{connection.close()}
