#!/usr/bin/env node
// Self-contained architecture ownership and footprint inventory.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slash = p => p.split(path.sep).join('/');
const ignored = new Set(['.git','node_modules','.cache','coverage','sessions','captures','data','chrome-profile']);
async function walk(rel='') {
  const dir=path.join(root,rel);
  const files=[];
  for (const d of await readdir(dir,{withFileTypes:true})) {
    if (d.isSymbolicLink() || (d.isDirectory() && ignored.has(d.name))) continue;
    const next=slash(path.join(rel,d.name));
    if (d.isDirectory()) files.push(...await walk(next));
    else if (d.isFile()) {
      const info=await stat(path.join(root,next));
      files.push({path:next,bytes:info.size});
    }
  }
  return files;
}
const manifest=JSON.parse(await readFile(path.join(root,'architecture','components.json'),'utf8'));
const files=await walk();
const code=files.filter(f=>f.path.startsWith('src/'));
const isOwned=(file,component)=>component.codePaths.some(p=>file.path.startsWith(p));
const summary=manifest.components.map(c=>{
  const owned=files.filter(f=>isOwned(f,c));
  return {id:c.id,name:c.name,files:owned.length,bytes:owned.reduce((n,f)=>n+f.bytes,0),
    codePaths:c.codePaths,maturity:c.maturity};
});
const uncovered=code.filter(f=>!manifest.components.some(c=>isOwned(f,c))).map(f=>f.path);
const missing=manifest.components.flatMap(c=>c.codePaths.filter(p=>!files.some(f=>f.path.startsWith(p))).map(p=>c.id+': '+p));
const result={schemaVersion:1,source:manifest.source,totalFiles:files.length,studioSourceFiles:code.length,
  unitTestFiles:files.filter(f=>f.path.startsWith('test/')).length,
  components:summary,uncoveredSourceFiles:uncovered,missingComponentPaths:missing};
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(result,null,2)+'\n');
else {
  for(const c of summary) process.stdout.write(c.id.padEnd(20)+' '+String(c.files).padStart(4)+' files '+String(c.bytes).padStart(9)+' bytes\n');
  process.stdout.write('Uncovered source files: '+uncovered.length+'; missing ownership paths: '+missing.length+'\n');
}
if (process.argv.includes('--check') && (uncovered.length || missing.length)) process.exitCode=1;
