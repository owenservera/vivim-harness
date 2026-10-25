import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { LearnerJournal, LearnerWriteConflict } from '../../src/intel/learner-journal.mjs';
const withDir = (fn) => { const dir = mkdtempSync(path.join(os.tmpdir(), 'l5-journal-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const state = (x) => ({ corrections:[{ id:'c1', role:'title', ctx:{ site:'a' }}], model:{ value:x } });

test('versioned commits reload, recover immutable historical snapshots, and report lineage', () => withDir((dir) => {
  const a = new LearnerJournal(dir);
  const first = a.commit(state(1), 0), second = a.commit(state(2), 1);
  assert.equal(first.revision, 1); assert.equal(second.revision, 2);
  assert.equal(second.parentRevision, 1);
  assert.deepEqual(a.versions(), [1,2]);
  assert.equal(new LearnerJournal(dir).read().model.value, 2);
  assert.equal(a.at(1).model.value, 1);
  assert.equal(a.at(2).model.value, 2);
}));

test('stale writers cannot silently overwrite an accepted correction', () => withDir((dir) => {
  const a = new LearnerJournal(dir), b = new LearnerJournal(dir);
  assert.equal(a.version(), 0); assert.equal(b.version(), 0);
  a.commit(state('accountA'), 0);
  assert.throws(() => b.commit(state('accountB'), 0), (e) => e instanceof LearnerWriteConflict && e.code === 'LEARNER_REVISION_CONFLICT');
  assert.equal(a.read().model.value, 'accountA');
  assert.deepEqual(a.versions(), [1]);
}));

test('independent processes racing from the same revision: one winner, no lost state', () => withDir((dir) => {
  const script = `import { LearnerJournal } from ${JSON.stringify(new URL('../../src/intel/learner-journal.mjs', import.meta.url).href)};const j=new LearnerJournal(process.argv[1]);try{j.commit({writer:process.argv[2]},0);process.stdout.write('ok')}catch(e){process.stdout.write(e.code??e.message);process.exit(2)}`;
  const one=spawnSync(process.execPath,['--input-type=module','-e',script,dir,'one'],{encoding:'utf8'});
  const two=spawnSync(process.execPath,['--input-type=module','-e',script,dir,'two'],{encoding:'utf8'});
  assert.equal(one.stdout,'ok');assert.equal(two.stdout,'LEARNER_REVISION_CONFLICT');
  assert.equal(new LearnerJournal(dir).read().writer,'one');
}));

test('live lock causes explicit retryable conflict; failed writer cannot replace state', () => withDir((dir) => {
  const journal = new LearnerJournal(dir);
  mkdirSync(path.join(dir,'.learner-write-lock'));
  assert.throws(() => journal.commit(state(1),0), e=>e.code==='LEARNER_LOCKED');
  assert.equal(journal.read(),null);
}));

test('detects mutation/corruption rather than silently loading contaminated state', () => withDir((dir) => {
  const journal=new LearnerJournal(dir);journal.commit(state(1),0);
  const file=path.join(dir,'learner.json');const raw=JSON.parse(readFileSync(file,'utf8'));raw.model.value=999;
  writeFileSync(file,JSON.stringify(raw));
  assert.throws(()=>journal.read(),/integrity mismatch/i);
}));

test('v1 format is migrated without destroying old correction history', () => withDir((dir) => {
  const old = {version:1,models:{},overrides:{},corrections:[{id:'c1',role:'title'}],calibrator:{bins:{}}};
  writeFileSync(path.join(dir,'learner.json'),JSON.stringify(old));
  const journal=new LearnerJournal(dir);assert.equal(journal.version(),0);
  journal.commit({...old,corrections:[...old.corrections,{id:'c2',role:'text'}]},0);
  assert.deepEqual(journal.versions(),[0,1]);assert.equal(journal.at(0).corrections.length,1);
  assert.equal(journal.read().corrections.length,2);
}));


test('two processes starting simultaneously cannot both commit the same revision', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'l5-journal-race-'));
  try {
    const { spawn } = await import('node:child_process');
    const moduleUrl = new URL('../../src/intel/learner-journal.mjs', import.meta.url).href;
    const script = `import { LearnerJournal } from ${JSON.stringify(moduleUrl)};const j=new LearnerJournal(process.argv[1]);try{j.commit({writer:process.argv[2]},0);process.stdout.write('ok')}catch(e){process.stdout.write(e.code??e.message);process.exit(2)}`;
    const child = (tag) => new Promise((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module','-e',script,dir,tag]);
      let output=''; p.stdout.on('data',d=>output+=d.toString());
      p.on('close',code=>resolve({code,output}));
    });
    const results=await Promise.all([child('A'),child('B')]);
    assert.equal(results.filter(r=>r.output==='ok').length,1);
    assert.equal(results.filter(r=>r.output==='LEARNER_LOCKED'||r.output==='LEARNER_REVISION_CONFLICT').length,1);
    assert.equal(new LearnerJournal(dir).versions().length,1);
    assert.ok(['A','B'].includes(new LearnerJournal(dir).read().writer));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
