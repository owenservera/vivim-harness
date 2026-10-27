import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTranscript,renderSummary} from '../../scripts/transcript-intake.mjs';
test('sanitizes private data and triages binding error',()=>{
 const secret='PRIVATE_TOKEN_abcdefghijklmnopqrstuvwxyz';
 const r=analyzeTranscript('**Session ID:** session1\n## User\n'+secret+'\n## Assistant\n**Tool: shell**\nBINDING_CHANGED '+secret+'\n');
 assert.equal(r.session.session_id,'session1');assert.equal(r.stats.tool_calls,1);
 assert.equal(r.handoffs[0].code,'binding_changed');
 assert.ok(!(JSON.stringify(r)+renderSummary(r)).includes(secret));
});
test('intermediate error does not imply unresolved defect or resolution',()=>{
 const r=analyzeTranscript('## Assistant\nFAIL: old\nPASS: new\n');
 assert.equal(r.findings.confirmed_unresolved,0);assert.equal(r.findings.resolved,0);
});
test('deduplicates repeated incidents to single handoff',()=>{
 const r=analyzeTranscript('BINDING_CHANGED\nBINDING_CHANGED\n'.repeat(150));
 assert.equal(r.handoffs.filter(x=>x.code==='binding_changed').length,1);
});
