// Heuristic prepublication check; not a proof that material is anonymous.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
// Exact bytes of the visually reviewed UI fixture screenshot; other binaries still fail.
const reviewedImages=new Map([['docs/assets/control-panel.png','2b26557086396299b3376ef100ab4592ad9f4bae0c5842b8fdb7a7377e976c4a']]);
const patterns=[
 ['personal Windows directory',/[A-Za-z]:[\\/]Users[\\/](?!Public(?:[\\/]|$)|<)[^\s<>"']+/i],
 ['Figma file link',/figma\.com\/(?:design|file)\/[A-Za-z0-9]{15,}/],
 ['GitHub credential',/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}/],
 ['API credential',/sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}/],
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['runtime UUID literal',/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i]
];
const root=path.resolve(process.argv[2]||'.');let checked=0,failures=0;
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){
 if(['.git','node_modules'].includes(entry.name))continue;
 const file=path.join(dir,entry.name);
 if(entry.isSymbolicLink())throw Error('Review symlink separately: '+path.relative(root,file));
 if(entry.isDirectory()){await walk(file);continue;}
 const bytes=await fs.readFile(file);const relative=path.relative(root,file).replaceAll('\\','/');
 if(reviewedImages.has(relative)){if(createHash('sha256').update(bytes).digest('hex')!==reviewedImages.get(relative))throw Error('Reviewed image changed: '+relative);checked++;continue;}
 const text=bytes.toString('utf8');
 if(bytes.includes(0)||!Buffer.from(text).equals(bytes))throw Error('Binary or invalid UTF-8 requires manual review: '+path.relative(root,file));
 checked++;
 for(const [label,re] of patterns){if(re.test(text)){console.error(path.relative(root,file)+': '+label);failures++;}}
 if(/(?:^|\/)(?:\.env(?:\..*)?|.*(?:backup|\.bak|\.log)|publish-progress\.json)$/i.test(path.relative(root,file).replaceAll('\\','/'))){console.error('Excluded file type: '+path.relative(root,file));failures++;}
}}
await walk(root);console.log(JSON.stringify({checked,findings:failures,scope:'working tree text and hash-pinned reviewed images; excludes .git and node_modules'}));process.exitCode=failures?1:0;
