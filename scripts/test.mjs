import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const files=(await readdir('tests')).filter(name=>name.endsWith('.test.ts')).map(name=>'tests/'+name);
const child=spawn(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit',shell:false});
child.on('exit',code=>{process.exitCode=code??1});
child.on('error',error=>{console.error(error.message);process.exitCode=1});
