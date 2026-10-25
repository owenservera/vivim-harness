import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporalMillis, normalizeTemporalQuery, observationBoundary, selectTemporalModel,
  temporalPerspective, compareTemporalRevisions, TEMPORAL_CONTRACT } from '../../src/intel/temporal-truth.mjs';

const t = (n) => Date.parse('2026-10-22T10:' + String(n).padStart(2, '0') + ':00.000Z');
const model = (revision, savedAt, textWeight) => ({ revision, savedAt, models: { 'account:A': { weight: textWeight } } });
class Journal {
  constructor(states = [model(1, '2026-10-22T10:05:00.000Z', 0.1), model(2, '2026-10-22T10:20:00.000Z', 0.9)]) {
    this.states = new Map(states.map((s) => [s.revision, structuredClone(s)]));
    this.calls = [];
  }
  versions() { return [...this.states.keys()].sort((a,b)=>a-b); }
  at(revision) { this.calls.push(revision); if (!this.states.has(revision)) throw Error('Not found'); return structuredClone(this.states.get(revision)); }
}
const source = { session:'capture-1', seq:41, sid:'stream-2', t:t(2), coverage:'complete', gaps:0 };
const asKnown = (knowledgeAsOf) => ({ lens:'as-known', eventAsOf:t(3), knowledgeAsOf });
const retrospective = (modelRevision) => ({ lens:'retrospective', eventAsOf:t(3), modelRevision });

test('strict temporal parsing rejects ambiguous timezone, units, and invalid numeric times', () => {
  assert.equal(temporalMillis('2026-10-22T10:10:00+00:00'), t(10));
  assert.equal(temporalMillis(t(10)), t(10));
  for (const bad of ['2026-10-22T10:10:00', '2026-10-22', '10:10', '-1', -1, 5.5, NaN, Infinity, null])
    assert.throws(() => temporalMillis(bad), (e) => e.code === 'INVALID_TIME');
});

test('explicit lenses prevent accidental retrospective reinterpretation', () => {
  assert.throws(() => normalizeTemporalQuery({ eventAsOf:t(5) }), (e) => e.code === 'INVALID_LENS');
  assert.throws(() => normalizeTemporalQuery({ lens:'observed', eventAsOf:t(5), modelRevision:1 }), (e) => e.code === 'AMBIGUOUS_LENS');
  assert.throws(() => normalizeTemporalQuery({ lens:'as-known', eventAsOf:t(5) }), (e) => e.code === 'KNOWLEDGE_TIME_REQUIRED');
  assert.throws(() => normalizeTemporalQuery({ lens:'retrospective', eventAsOf:t(5) }), (e) => e.code === 'MODEL_REVISION_REQUIRED');
  assert.equal(normalizeTemporalQuery(retrospective(1)).modelRevision, 1);
});

test('observed-only returns source boundary and never reads learner journal', () => {
  const journal = new Journal();
  const result = temporalPerspective({ query:{ lens:'observed', eventAsOf:t(3) }, source, journal });
  assert.equal(result.schema, TEMPORAL_CONTRACT);
  assert.equal(result.evidence.state, 'observed');
  assert.equal(result.model.status, 'not-applicable');
  assert.equal(result.interpretation.status, 'unavailable');
  assert.deepEqual(journal.calls, []);
});

test('unseen/future evidence is never materialized or interpreted', () => {
  let interpreted = 0;
  const result = temporalPerspective({ query:retrospective(2), source:{...source,t:t(4)}, journal:new Journal(),
    interpret:() => {interpreted++;return 'wrong';} });
  assert.equal(result.evidence.state, 'not-yet-observed');
  assert.equal(result.interpretation.reason, 'NO_OBSERVED_EVIDENCE');
  assert.equal(interpreted, 0);
});

test('undated, invalid, or missing observation references cannot impersonate past facts', () => {
  assert.equal(observationBoundary({...source,t:null},t(3)).state,'unknown-time');
  assert.equal(observationBoundary({...source,t:'unparseable'},t(3)).state,'unknown-time');
  assert.equal(observationBoundary({...source,seq:-2},t(3)).state,'unavailable');
  assert.equal(observationBoundary(null,t(3)).state,'unavailable');
});

test('unknown capture coverage and gaps are explicitly partial, not clean', () => {
  for (const src of [{...source,gaps:1},{...source,truncated:true},
    {...source,preAttachUnknown:true},{...source,coverage:'unassessed'},
    {...source,gaps:NaN}]) assert.equal(observationBoundary(src,t(3)).state,'partial');
});

test('model at knowledge time chooses latest persisted revision not a later correction', () => {
  const journal = new Journal();
  const earlier = selectTemporalModel(journal,asKnown(t(10)));
  const later = selectTemporalModel(journal,asKnown(t(30)));
  assert.equal(earlier.status,'selected');assert.equal(earlier.revision,1);
  assert.equal(later.status,'selected');assert.equal(later.revision,2);
  assert.equal(selectTemporalModel(journal,asKnown(t(1))).reason,'NO_MODEL_KNOWN_AT_TIME');
});

test('explicit revision conflicts with knowledge horizon are rejected', () => {
  const query={...asKnown(t(10)),modelRevision:2};
  assert.equal(selectTemporalModel(new Journal(),query).reason,'MODEL_REVISION_TIME_CONFLICT');
});

test('untimed v1 history and nonmonotonic savedAt fail closed', () => {
  assert.equal(selectTemporalModel(new Journal([model(0,null,.1),model(1,'2026-10-22T10:05:00.000Z',.2)]),asKnown(t(30))).reason,'UNTIMED_MODEL_HISTORY');
  assert.equal(selectTemporalModel(new Journal([model(1,'2026-10-22T10:20:00.000Z',.1),model(2,'2026-10-22T10:05:00.000Z',.2)]),asKnown(t(30))).reason,'NONMONOTONIC_MODEL_CLOCK');
});

test('retrospective comparison recomputes from exact historical revision and never mutates journal', () => {
  const journal = new Journal();
  const readWeight = (snapshot) => snapshot.models['account:A'].weight;
  const old = temporalPerspective({query:retrospective(1),source,journal,interpret:readWeight});
  const updated = temporalPerspective({query:retrospective(2),source,journal,interpret:readWeight});
  assert.equal(old.interpretation.value,0.1);
  assert.equal(updated.interpretation.value,0.9);
  assert.equal(old.historicalBelief,'not-proven');
  assert.equal(updated.historicalBelief,'not-proven');
  const diff = compareTemporalRevisions({journal,before:1,after:2,interpret:readWeight});
  assert.equal(diff.before.prediction,0.1);assert.equal(diff.after.prediction,0.9);
  assert.match(diff.effect,/not-observed-historical-belief/);
  assert.equal(journal.at(1).models['account:A'].weight,0.1);
});

test('metadata-only archived derivation is not independently validated historical belief', () => {
  const derivation={modelRevision:1,derivedAt:t(7),recipeVersion:'v1',sourceDigest:'a'.repeat(64)};
  const result=temporalPerspective({query:asKnown(t(10)),source,journal:new Journal(),
    derivation,interpret: s => s.models['account:A'].weight });
  assert.equal(result.interpretation.status,'recomputed-with-pinned-model');
  assert.equal(result.historicalBelief,'derivation-metadata-present-not-independently-verified');
  const forged = temporalPerspective({query:asKnown(t(10)),source,journal:new Journal(),
    derivation:{...derivation,modelRevision:2},interpret:s=>s.models['account:A'].weight});
  assert.equal(forged.historicalBelief,'not-proven');
});

test('event time and knowledge time remain independently selectable', () => {
  const result=temporalPerspective({query:{...asKnown(t(30)),eventAsOf:t(3)},source,
    journal:new Journal(), interpret:(s)=>s.models['account:A'].weight});
  assert.equal(result.eventAsOf,t(3));
  assert.equal(result.knowledgeAsOf,t(30));
  assert.equal(result.model.revision,2);
  assert.equal(result.interpretation.value,.9);
  assert.equal(result.historicalBelief,'not-proven');
});

test('public response does not echo sensitive capture content or source credentials', () => {
  const sensitive={...source,body:'secret-value',cookie:'cookie-value',privatePrompt:'prompt-value',token:'token-value'};
  const result=temporalPerspective({query:{lens:'observed',eventAsOf:t(3)},source:sensitive});
  const json=JSON.stringify(result);
  for (const value of ['secret-value','cookie-value','prompt-value','token-value']) assert.equal(json.includes(value),false);
});

test('missing revisions and mismatched snapshot metadata refuse model claims', () => {
  assert.equal(selectTemporalModel(new Journal(),retrospective(8)).reason,'REVISION_NOT_FOUND');
  const journal=new Journal();journal.at=()=>model(500,'2026-10-22T10:05:00.000Z',.3);
  assert.equal(selectTemporalModel(journal,retrospective(1)).reason,'REVISION_METADATA_UNVERIFIED');
});

test('comparison needs existing revisions and interpreter; no silent fallback to current', () => {
  const journal = new Journal();
  assert.throws(()=>compareTemporalRevisions({journal,before:1,after:3,interpret:s=>s}),e=>e.code==='REVISION_NOT_FOUND');
  assert.throws(()=>compareTemporalRevisions({journal,before:1,after:2}),e=>e.code==='INTERPRETER_REQUIRED');
});

test('as-known cannot use evidence recorded after the knowledge horizon', () => {
  let runs = 0;
  const result = temporalPerspective({ query:{ lens:'as-known',eventAsOf:t(5),knowledgeAsOf:t(1) },
    source, journal:new Journal(), interpret:() => { runs++; return 0.9; } });
  assert.equal(result.interpretation.reason, 'EVIDENCE_NOT_YET_KNOWN');
  assert.equal(runs,0);
});
