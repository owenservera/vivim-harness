// Generic observation bridge for Capture Studio's accepted DOM/a11y/shape/route events.
// It only derives *candidates*, never verified semantics or browser authority.
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const safe=s=>typeof s==='string'&&s.length>0&&s.length<=180&&!/[\x00-\x1f\x7f]/.test(s);
const allowed=['data-testid','data-message-author-role','data-actor','data-role'];
const nodeAttrs=x=>Object.fromEntries(allowed.filter(k=>safe(x?.[k])).map(k=>[k,x[k]]));
function signal(node,source,carrier){
 const attrs=nodeAttrs(node.attributes);
 // Read the observer's declared role-attribute contract; never copy its text or handle.
 if(/^data-[a-zA-Z0-9-]{1,94}$/.test(node.roleAttribute??'') && ['user','assistant'].includes(node.role))
   attrs[node.roleAttribute]=node.role;
 const kind=attrs['data-message-author-role']??attrs['data-actor']??attrs['data-role'];
 const feature=(kind??node.role)==='assistant'?'assistant-turn':(kind??node.role)==='user'?'user-turn':
   node.a11yRole==='textbox'?'composer':null;
 if(!feature || !Object.keys(attrs).length)return null;
 const bind=node.identity;
 const identityVerified=plain(bind)&&bind.verified===true&&bind.evidenceRef===source.evidenceRef&&safe(bind.ref)
   && ((feature==='assistant-turn'&&bind.role==='assistant')||(feature==='user-turn'&&bind.role==='user'));
 return {feature,attributes:attrs,outcome:node.outcome==='absent'?'absent':node.outcome==='present'?'present':'unknown',
   identityRole:feature==='assistant-turn'?'assistant':feature==='user-turn'?'user':null,
   identityVerdict:identityVerified?'verified':'inferred',identityRef:identityVerified?bind.ref:null,
   evidenceRef:source.evidenceRef,carrier,roleAttribute:node.roleAttribute??null,roleMatch:node.roleMatch??null};
}
export function captureToAdapterEvents(captures){
 if(!Array.isArray(captures)||captures.length>2000)throw new Error('INVALID_CAPTURE_BATCH');
 return captures.map(c=>{
  if(!plain(c)||!plain(c.scope)||!plain(c.source))throw new Error('INVALID_CAPTURE_ENVELOPE');
  const obs=[];
  for(const [field,carrier] of [['dom','dom'],['a11y','a11y']]){
   // Source carrier is independently established by Core; do not relabel DOM as a11y.
   if(c.source.carrier!==carrier)continue;
   const nodes=c[field]??[];
   if(!Array.isArray(nodes)||nodes.length>1000)throw new Error('OBSERVATION_BUDGET');
   for(const n of nodes){const o=signal(n,c.source,carrier);if(o)obs.push(o);}
  }
  // Decode/schema induction may identify typed component paths, NOT message roles.
  for(const x of c.intelligence?.streamComponents??[]){
   if(!['network','correlated'].includes(c.source.carrier))continue;
   if(x?.evidenceRef!==c.source.evidenceRef||x?.sourceKind!=='CORE_DECODED' ||
     !safe(x.path)||x.outcome!=='present')continue;
   obs.push({feature:'stream-component',streamPath:x.path,outcome:'present',evidenceRef:c.source.evidenceRef});
  }
  for(const x of c.intelligence?.routes??[]){
   if(x?.evidenceRef!==c.source.evidenceRef||x?.verifiedNativeRef!==true||!safe(x.routePattern))continue;
   obs.push({feature:'thread-route',routePattern:x.routePattern,outcome:x.outcome==='present'?'present':'unknown',
      identityVerdict:'verified',identityRef:x.bindingRef??null,evidenceRef:c.source.evidenceRef});
  }
  return {scope:c.scope,source:c.source,observations:obs};
 });
}
