// Pure candidate-versus-heldout independence gate. No browser or store access.
export function assertIndependentAdapterHoldout(candidate, heldoutSessionIds) {
  if(candidate?.schema!=='aion.adaptive-webapp-adapter/1'||!candidate.evidence||!Array.isArray(candidate.evidence.captureRefs))
    throw Object.assign(new Error('TRAINING_EVIDENCE_MISSING'),{code:'TRAINING_EVIDENCE_MISSING'});
  if(candidate.evidence.capturesTruncated===true)
    throw Object.assign(new Error('TRAINING_EVIDENCE_TRUNCATED'),{code:'TRAINING_EVIDENCE_TRUNCATED'});
  if(!Array.isArray(heldoutSessionIds)||heldoutSessionIds.length===0||heldoutSessionIds.some(x=>typeof x!=='string'||!x))
    throw Object.assign(new Error('HELDOUT_EVIDENCE_MISSING'),{code:'HELDOUT_EVIDENCE_MISSING'});
  const training=new Set(candidate.evidence.captureRefs);
  const overlap=[...new Set(heldoutSessionIds)].filter(x=>training.has(x));
  if(overlap.length)throw Object.assign(new Error('HELDOUT_OVERLAPS_TRAINING'),{code:'HELDOUT_OVERLAPS_TRAINING',overlapCount:overlap.length});
  return Object.freeze({independent:true,trainingCount:training.size,heldoutCount:new Set(heldoutSessionIds).size});
}