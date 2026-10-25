import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireDriveLease, inspectDriveLease, recoverDriveLease } from '../../src/capture/drive-lease.mjs';
import { driveSite } from '../../src/capture/actions.mjs';

function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-lease-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test('exclusive lease includes holder, releases idempotently, and other ports remain independent', (t) => {
  const root = temp(t), a = acquireDriveLease({ root, port: 19222, holder: { kind: 'conversation', id: 'a' } });
  assert.throws(() => acquireDriveLease({ root, port: 19222 }), (e) => e.status === 409 && e.holder.id === 'a');
  const b = acquireDriveLease({ root, port: 19223 }); b.release(); a.release(); a.release();
  acquireDriveLease({ root, port: 19222 }).release();
});
test('live or unprovable owner blocks acquire; changed ownership is never released by the old handle', (t) => {
  const root = temp(t), a = acquireDriveLease({ root, port: 19222 });
  const file = path.join(root, '19222', 'owner.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'not-ours', pid: process.pid })); // not a valid owner but a LIVE pid
  assert.equal(inspectDriveLease({ root, port: 19222 }).ownerFile, 'invalid');
  assert.throws(() => acquireDriveLease({ root, port: 19222, staleGraceMs: 0 }), (e) => e.code === 'DRIVE_LEASE_BUSY');
  assert.throws(() => a.release(), /ownership changed/);
  fs.writeFileSync(file, '{broken'); // unreadable inside the grace window: a half-written lease is not taken
  assert.equal(inspectDriveLease({ root, port: 19222 }).ownerFile, 'unparseable');
  assert.throws(() => acquireDriveLease({ root, port: 19222 }), (e) => e.code === 'DRIVE_LEASE_BUSY');
  assert.throws(() => a.release(), /unreadable/);
});
test('missing or corrupt owner.json is auto-reclaimed on acquire (no token handshake)', (t) => {
  for (const damage of ['{broken', '', null]) {
    const root = temp(t), port = 19222, a = acquireDriveLease({ root, port }), file = path.join(root, String(port), 'owner.json');
    if (damage === null) fs.unlinkSync(file); else fs.writeFileSync(file, damage);
    const info = inspectDriveLease({ root, port });
    assert.equal(info.ownerFile, damage === null ? 'missing' : 'unparseable'); assert.equal(info.reclaimable, true);
    const b = acquireDriveLease({ root, port, staleGraceMs: 0, holder: { kind: 'conversation', id: 'b' } });
    assert.equal(inspectDriveLease({ root, port }).holder.id, 'b');
    assert.throws(() => a.release(), (e) => e.code === 'LEASE_OWNER_CHANGED'); // the old handle cannot remove the new lease
    b.release(); assert.equal(inspectDriveLease({ root, port }).exists, false);
  }
});
test('dead pid owner is auto-reclaimed on acquire; live owner is not', async (t) => {
  const root = temp(t), port = 19222, moduleUrl = new URL('../../src/capture/drive-lease.mjs', import.meta.url).href;
  const live = acquireDriveLease({ root, port }); assert.equal(inspectDriveLease({ root, port }).reclaimable, false);
  assert.throws(() => acquireDriveLease({ root, port, staleGraceMs: 0 }), (e) => e.code === 'DRIVE_LEASE_BUSY'); live.release();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {acquireDriveLease} from ${JSON.stringify(moduleUrl)}; acquireDriveLease(${JSON.stringify({ root, port })});`], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('child failed'))); });
  const stale = inspectDriveLease({ root, port }); assert.equal(stale.ownerState, 'dead'); assert.equal(stale.reclaimable, true);
  acquireDriveLease({ root, port }).release(); // default grace: a parseable dead owner needs no waiting
});
test('concurrent reclaimers of an unreadable lease: exactly one wins', async (t) => {
  const root = temp(t), port = 19222, moduleUrl = new URL('../../src/capture/drive-lease.mjs', import.meta.url).href;
  const stale = path.join(root, String(port)); fs.mkdirSync(stale, { recursive: true }); // dir with no owner.json
  const past = new Date(Date.now() - 60_000); fs.utimesSync(stale, past, past); // older than the default grace
  const startAt = Date.now() + 1500;
  const code = `import {acquireDriveLease} from ${JSON.stringify(moduleUrl)};
    while (Date.now() < ${startAt}) {}
    try { const lease=acquireDriveLease(${JSON.stringify({ root, port })});
      console.log(JSON.stringify({owned:true})); process.stdin.once('data',()=>{lease.release();process.exit(0)});
    } catch(e) {console.log(JSON.stringify({owned:false,code:e.code}));}`;
  const children = [0, 1, 2, 3].map(() => spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) child.kill(); });
  const outputs = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let out = ''; child.on('error', reject); child.stdout.on('data', (s) => { out += s; if (out.includes('\n')) resolve(JSON.parse(out.trim())); });
    child.stderr.on('data', (s) => reject(new Error(String(s))));
  })));
  assert.equal(outputs.filter((o) => o.owned).length, 1);
  assert.ok(outputs.filter((o) => !o.owned).every((o) => o.code === 'DRIVE_LEASE_BUSY'));
  const winner = children[outputs.findIndex((o) => o.owned)];
  const exited = new Promise((resolve) => winner.once('exit', resolve)); winner.stdin.write('release\n'); await exited;
  assert.equal(inspectDriveLease({ root, port }).exists, false);
});test('two independent processes contend deterministically: exactly one owns until release', async (t) => {
  const root = temp(t), moduleUrl = new URL('../../src/capture/drive-lease.mjs', import.meta.url).href;
  const code = `import {acquireDriveLease} from ${JSON.stringify(moduleUrl)};
    try { const lease=acquireDriveLease(${JSON.stringify({ root, port: 19222 })});
      console.log(JSON.stringify({owned:true})); process.stdin.once('data',()=>{lease.release();process.exit(0)});
    } catch(e) {console.log(JSON.stringify({owned:false,code:e.code}));}`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) child.kill(); });
  const outputs = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let out = ''; child.on('error', reject); child.stdout.on('data', (s) => { out += s; if (out.includes('\n')) resolve(JSON.parse(out.trim())); });
    child.stderr.on('data', (s) => reject(new Error(String(s))));
  })));
  assert.equal(outputs.filter((o) => o.owned).length, 1);
  assert.equal(outputs.find((o) => !o.owned).code, 'DRIVE_LEASE_BUSY');
  const winner = children[outputs.findIndex((o) => o.owned)];
  const exited = new Promise((resolve) => winner.once('exit', resolve)); winner.stdin.write('release\n'); await exited;
  acquireDriveLease({ root, port: 19222 }).release();
});
test('lowest legacy driveSite entry respects conversation lease before any browser call', async (t) => {
  const root = temp(t), old = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  t.after(() => { if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old; });
  const lease = acquireDriveLease({ port: 19222, holder: { kind: 'conversation', id: 'chat' } });
  try { await assert.rejects(driveSite({ port: 19222 }), (e) => e.code === 'DRIVE_LEASE_BUSY' && e.holder.id === 'chat'); }
  finally { lease.release(); }
});

test('explicit lease inspection/recovery requires matching token and proven-dead owner', async (t) => {
  const root = temp(t), port = 19222;
  const live = acquireDriveLease({ root, port });
  const info = inspectDriveLease({ root, port }); assert.equal(info.ownerState, 'alive');
  assert.throws(() => recoverDriveLease({ root, port, token: info.token, pid: info.pid }), /NOT_PROVEN_DEAD/);
  assert.throws(() => recoverDriveLease({ root, port, token: 'wrong', pid: info.pid }), /OWNER_MISMATCH/);
  live.release(); assert.equal(inspectDriveLease({ root, port }).exists, false);
  const moduleUrl = new URL('../../src/capture/drive-lease.mjs', import.meta.url).href;
  const code = `import {acquireDriveLease} from ${JSON.stringify(moduleUrl)}; acquireDriveLease(${JSON.stringify({ root, port })});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (exit) => exit === 0 ? resolve() : reject(new Error('child failed'))); });
  const stale = inspectDriveLease({ root, port }); assert.equal(stale.ownerState, 'dead');
  assert.equal(recoverDriveLease({ root, port, token: stale.token, pid: stale.pid }).recovered, true);
  acquireDriveLease({ root, port }).release();
});

test('unknown or corrupt lease metadata cannot be recovered', (t) => {
  const root = temp(t), port = 19222, lease = acquireDriveLease({ root, port });
  fs.writeFileSync(path.join(root, String(port), 'owner.json'), '{broken');
  assert.equal(inspectDriveLease({ root, port }).ownerState, 'unknown');
  assert.throws(() => recoverDriveLease({ root, port, token: lease.token, pid: lease.pid }), /OWNER_MISMATCH/);
});
