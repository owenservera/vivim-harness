#!/usr/bin/env node
// Read-only OpenCode markdown transcript intake. No raw transcript excerpts emitted.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const patterns=[
 ['binding_changed',/\bBINDING_CHANGED\b/i,'BROWSER','Provider binding changed'],
 ['test_failure',/(?:^|\s)(?:not ok \d+|FAIL(?:ED)?\s*[:—-]|tests? failed\s*[:=]\s*[1-9])/i,'TEST','Test failure marker'],
 ['port_busy',/\b(EADDRINUSE|address already in use)\b/i,'ENVIRONMENT','Port in use'],
 ['auth_required',/\b(401 Authentication required|AUTH_REQUIRED)\b/i,'TOOLING','Authentication required'],
 ['tool_error',/\b(ENOENT|ECONNREFUSED|ETIMEDOUT|MODULE_NOT_FOUND)\b/i,'TOOLING','Tool error'],
 ['blocked',/\b(BLOCKED|NOT RUN)\b/i,'BLOCKER','Blocked marker']
];
export function analyzeTranscript(input){
 if(typeof input!=='string')throw new TypeError('text required');
 const lines=input.replace(/\r\n?/g,'\n').split('\n'),tools={},events=[],ports=new Set(),heads=new Set(),seen=new Set();
 let tool=null,calls=0,fence=false,users=0,assistants=0;
 for(let i=0;i<lines.length;i++){
  const s=lines[i];if(/^## User\s*$/.test(s))users++;if(/^## Assistant\s*$/.test(s))assistants++;
  if(/^\x60\x60\x60/.test(s.trim()))fence=!fence;
  const t=s.match(/^\*\*Tool:\s*([\w -]{1,60})\*\*$/);
  if(t){tool=t[1].trim().toLowerCase().replace(/[^a-z0-9_-]/g,'');calls++;tools[tool]=(tools[tool]??0)+1;}
  if(!fence&&/^[a-f\d]{40}\s*$/i.test(s))heads.add(s.trim().toLowerCase());
  if(!fence&&/\b(port|listening|localhost|cdp)\b/i.test(s)){
   for(const m of s.matchAll(/(?:\b(?:port|studio-port|cdp-port)\s*[=: ]\s*|127\.0\.0\.1:|localhost:)(\d{2,5})/gi)){
    const p=Number(m[1]);if(p>=1&&p<=65535)ports.add(p);
   }
  }
  for(const [code,re,category,title] of patterns){
   if(!re.test(s))continue;const key=code+':'+Math.floor(i/100);
   if(seen.has(key)||events.length>=250)continue;seen.add(key);
   events.push({code,category,title,line:i+1,evidence:'TRANSCRIPT_MARKER',status:'OBSERVED_NOT_ROOT_CAUSE',tool});
  }
 }
 const field=k=>(input.match(new RegExp('^\\*\\*'+k+':\\*\\*\\s*(.+)$','mi'))?.[1]??'').slice(0,80).replace(/[^a-zA-Z0-9 .,:+_\/-]/g,'')||null;
 const failureCodes=new Set(['binding_changed','test_failure','port_busy','auth_required','tool_error']);
 const failures=events.filter(e=>failureCodes.has(e.code)),priority={binding_changed:0,test_failure:1,port_busy:2,auth_required:3,tool_error:4};
 const unique=[...new Map([...failures].reverse().map(e=>[e.code,e])).values()];
 const handoffs=unique.sort((a,b)=>priority[a.code]-priority[b.code]).slice(0,3).map(e=>({
  code:e.code,location:'transcript:'+e.line,confidence:'unverified',
  action:e.code==='binding_changed'?'Read-only compare expected vs actual origin, target, path and thread. Do not send or retry.':e.code==='test_failure'?'Confirm executed command, failed assertion, tested commit and later reruns.':'Recheck final runtime state and reproduce non-destructively.'
 }));
 return {schema:'vivim.transcript-intake.v1',input_sha256:createHash('sha256').update(input).digest('hex'),
  session:{session_id:field('Session ID'),created:field('Created'),updated:field('Updated')},
  stats:{lines:lines.length,tool_calls:calls,user_sections:users,assistant_sections:assistants},
  tools:Object.fromEntries(Object.entries(tools).sort(([a],[b])=>a.localeCompare(b))),
  context:{git_heads_observed:[...heads].slice(0,12),ports_observed:[...ports].sort((a,b)=>a-b).slice(0,30)},
  events,findings:{observed_failure_markers:failures.length,confirmed_unresolved:0,resolved:0,resolution_status:'UNKNOWN: markers cannot establish final outcome'},
  handoffs,safety:{raw_content_included:false,no_live_activity:true,status:'metadata-only; review before sharing'}};
}
export function renderSummary(r){
 return '# Transcript intake — '+(r.session.session_id??'unknown')+'\n\nInput SHA-256: '+r.input_sha256+'\n\n'+
 'Lines: '+r.stats.lines+' · Tool calls: '+r.stats.tool_calls+' · Failure markers: '+r.findings.observed_failure_markers+
 '\n\n**Outcome:** '+r.findings.resolution_status+'\n\n## Handoffs\n'+
 (r.handoffs.map(h=>'- **'+h.code+'** ('+h.location+'): '+h.action).join('\n')||'- No failure markers')+'\n';
}
async function main(){
 const a=process.argv.slice(2),p=a[0];
 if(!p||a.includes('--help')){console.log('Usage: node scripts/transcript-intake.mjs <session.md> [--json out.json] [--md out.md]');process.exitCode=p?0:2;return;}
 const j=a.indexOf('--json'),m=a.indexOf('--md');if((j>=0&&!a[j+1])||(m>=0&&!a[m+1]))throw Error('missing output filename');
 const r=analyzeTranscript(await readFile(resolve(p),'utf8'));
 if(j>=0)await writeFile(resolve(a[j+1]),JSON.stringify(r,null,2)+'\n',{flag:'wx',mode:0o600});
 if(m>=0)await writeFile(resolve(a[m+1]),renderSummary(r),{flag:'wx',mode:0o600});
 if(j<0&&m<0)console.log(renderSummary(r));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error('intake failed: '+(e.code??e.name));process.exitCode=1;});
