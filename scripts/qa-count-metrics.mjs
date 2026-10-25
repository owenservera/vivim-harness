#!/usr/bin/env node
// Capture Studio per-layer file and physical LOC inventory. Run from any directory.
// No dependencies, no network, no output writes unless caller redirects JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const product=path.resolve(here,'..');
const labels=['L1','L2','L3','L4','L5','L6','L7','Foundation','Tests','Evaluation','Config','Docs'];
const totals=Object.fromEntries(labels.map(k=>[k,{files:0,physicalLOC:0,nonemptyLOC:0,paths:[]}]));
function group(p){
 const [ext]=[path.extname(p).toLowerCase()];
 if(p.startsWith('test/'))return 'Tests';
 if(p.startsWith('eval/'))return 'Evaluation';
 if(ext==='.md')return 'Docs';
 if(ext==='.json')return 'Config';
 if(p.startsWith('src/capture/')||p.startsWith('src/cdp/'))return 'L1';
 if(p.startsWith('src/store/'))return 'L2';
 if(p.startsWith('src/studio/ui/'))return 'L7';
 if(p.startsWith('src/replay/')||p==='src/intel/history.mjs')return 'L6';
 if(['src/intel/identity.mjs','src/intel/graph.mjs','src/intel/continuity.mjs','src/intel/correlate.mjs'].includes(p))return 'L4';
 if(['src/intel/learn.mjs','src/intel/priors.mjs'].includes(p))return 'L5';
 if(p.startsWith('src/decode/')||p.startsWith('src/shapes/')||p.startsWith('src/intel/'))return 'L3';
 return 'Foundation';
}
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='.git'||e.name==='node_modules')continue;const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile()){
const rel=path.relative(product,f).split(path.sep).join('/');
if(!/\.(?:mjs|js|html|json|md)$/.test(rel))continue;
const txt=fs.readFileSync(f,'utf8');
const lines=txt.length?txt.split(/\r?\n/):[];
if(txt.endsWith('\n'))lines.pop();
const cat=group(rel); const t=totals[cat];t.files++;t.physicalLOC+=lines.length;t.nonemptyLOC+=lines.filter(s=>s.trim().length).length;t.paths.push(rel);
}}}
if(!fs.existsSync(product)){console.error('Capture Studio checkout not found: '+product);process.exit(2)}
walk(product);
const sum=keys=>keys.reduce((a,k)=>({files:a.files+totals[k].files,physicalLOC:a.physicalLOC+totals[k].physicalLOC,nonemptyLOC:a.nonemptyLOC+totals[k].nonemptyLOC}),{files:0,physicalLOC:0,nonemptyLOC:0});
const shaArg=process.argv.find(x=>x.startsWith('--ref-label='))?.slice('--ref-label='.length)??'unverified-checkout';
console.log(JSON.stringify({schema:'aion.capture-studio.metrics.v1',refLabel:shaArg,scope:'product subtree',method:'physical lines inclusive of blanks/comments; one primary category per file',rows:totals,sourceAndTests:sum(labels.slice(0,10)),allTrackedText:sum(labels)},null,2));
