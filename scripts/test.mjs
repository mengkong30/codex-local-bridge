import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const state=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-public-tests-'));
const tests=['test-security.mjs','test-reliability.mjs','test-mcp.mjs','test-hub.mjs','test-operations.mjs','test-integration.mjs','test-discovery.mjs','test-review.mjs','test-review-mcp.mjs','test-settings.mjs','test-api-integration.mjs'];
try{
 for(const file of tests){
  console.log('\nRunning '+file);
  const code=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[path.join(root,file)],{cwd:root,env:{...process.env,BRIDGE_STATE_DIR:state},stdio:'inherit',windowsHide:true});
   child.on('error',reject);child.on('exit',resolve);
  });
  if(code!==0)throw Error(file+' failed with exit code '+code);
 }
 console.log('\nPASS all '+tests.length+' isolated test suites');
}finally{await fs.rm(state,{recursive:true,force:true});}
