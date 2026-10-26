// World secret-exclusion measurement — closes the BACKLOG item at docs/track/queue.md:72-73
// ("scan an actual exported bundle for cookies/tokens/profile data").
//
// MEASUREMENT ONLY. This file adds no redaction, no DLP and no scrubbing, and patches no src:
// generalized automatic redaction of message text is an OWNER DECISION held at
// docs/track/queue.md:19. Every assertion below reports what the code at HEAD actually does.
//
// HONEST SCOPE (local HTTP, fixture-seeded, offline): a real `startStudio` instance on port 0 over a
// disposable mkdtemp data dir with a stubbed conversation runtime, hand-seeded saved sessions and
// synthetic sentinel values. No browser/Chrome/CDP, no provider network, no real credential, no
// private capture, no private data directory. This is NOT live proof and NOT a browser test.
//
// Real product path exercised: POST /api/v1/world/transfer/export (registerWorldTransferRoutes,
// src/studio/world-transfer.mjs:356-362) -> createWorldTransfer().exportSelection. The bundle is
// scanned as serialized JSON bytes (`JSON.stringify(bundle)`), i.e. exactly the bytes a user would
// download, not a fixture literal.
//
// OBSERVED PRESENCE MATRIX (artifact x mode) asserted by the first test, measured at HEAD:
//   artifact                        references  transcript  full-saved
//   sessionid cookie (message text)     no         YES        YES
//   Authorization: Bearer               no         YES        YES
//   provider-API-key string             no         YES        YES
//   email address                       no         YES        YES
//   display name                        no         YES        YES
//   url pasted in message text          no         YES        YES
//   secret in a key_backup block        no          no        YES   (block-TYPE pruning, not scanning)
//   raw capture Authorization          no          no         no    (raw log not in closure at all)
//   raw capture Set-Cookie             no          no         no    (idem)
//   raw capture response body (b64)    no          no         no    (idem)
//   browser-profile cookie file        no          no         no    (idem)
//   providerUrl query-string token     no          no         no    (sanitizer, src/studio/world-url.mjs:16)
//   providerUrl userinfo password      no          no         no    (idem)
//   providerUrl fragment               no          no         no    (idem)
//   providerUrl PATH segment           YES        YES        YES   (documented limit, world-url.mjs:8-10)
//
// The blunt finding: cookies, bearer tokens, provider keys and PII ride transcript and full-saved
// exports VERBATIM, including inside plain message text. The only projection-level hardening is
// providerUrl origin+pathname. Raw capture records and browser-profile data are absent because the
// export never reads them (they are outside the record closure), NOT because anything scrubbed them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

// ---------------- helpers (test-local only) ----------------

const runtimeStub = () => ({ isSessionActive: () => false, close: async () => {}, list: async () => [] });

async function start(paths) {
  return startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, conversationRuntime: runtimeStub() });
}

const HTTP = (studio) => {
  const base = `http://127.0.0.1:${studio.port}/api/v1`;
  return async (method, url, body) => {
    const response = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
};

// Exact-byte scan over the serialized bundle (the bytes the user would receive).
const bytesOf = (bundle) => JSON.stringify(bundle);
const has = (bundle, needle) => bytesOf(bundle).includes(needle);
const hex = () => randomBytes(6).toString('hex');

// Unique synthetic sentinels. Every value is fake, is prefixed FAKE- and carries a random suffix so
// an exact-bytes scan can never hit noise; none of it is a real credential or personal record.
function sentinels() {
  const s = hex(), t = hex(), r = hex(), p = hex();
  return {
    cookie: `sessionid=FAKE-SESSION-COOKIE-${s}`,
    bearer: `Authorization: Bearer FAKE-TOKEN-${s}`,
    apikey: `sk-proj-FAKEAPIKEY${s}`,
    email: `fixture-${s}@example.invalid`,
    name: `Fixture Person ${s}`,
    pastedUrlToken: `FAKE-PASTED-URL-TOKEN-${s}`,
    opaqueOnly: `FAKE-OPAQUE-ONLY-${s}`,
    rawAuth: `Bearer FAKE-RAW-AUTH-${t}`,
    rawCookie: `sessionid=FAKE-RAW-COOKIE-${t}`,
    rawBody: `FAKE-RAW-BODY-${t}`,
    profileCookie: `FAKE-PROFILE-COOKIE-${p}`,
    urlTokenA: `FAKE-URL-TOKEN-A-${r}`,
    fragA: `FAKE-FRAGMENT-A-${r}`,
    urlTokenB: `FAKE-URL-TOKEN-B-${r}`,
    fragB: `FAKE-FRAGMENT-B-${r}`,
    userinfo: `FAKE-USERINFO-PASS-${r}`,
    pathSeg: `FAKE-PATH-SEGMENT-${r}`,
  };
}

function savedSession(paths, meta, turns) {
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete';
  session.meta.target = meta;
  session.kv.set('DOM_TURNS', turns);
  session.saveMeta();
  return session;
}

// Seed a disposable root with realistic sensitive artifacts in SAVED CONTENT, a raw capture log that
// would be read if raw were in the export closure, and a browser-profile cookie file.
function seed(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-secret-excl-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root);
  ensureDataDirs(paths);
  const secrets = sentinels();

  // Browser-profile artifact class (scope.exclusions 'browser-profiles'): a fake cookie store file.
  const profileDir = path.join(paths.chromeProfile, 'Default');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, 'Cookies'),
    `SQLite format 3\0host_key:example.test\nname:sessionid\nvalue:${secrets.profileCookie}\n`, 'utf8');

  // Session A: saved content carrying cookie / bearer / provider key / PII / a credential URL pasted
  // into message text. Its target URL carries a query-string credential and a fragment.
  const urlA = `https://example.test/path?access_token=${secrets.urlTokenA}#${secrets.fragA}`;
  const bodyText = `{"access_token":"${secrets.rawBody}"}`;
  const bodyB64 = Buffer.from(bodyText, 'utf8').toString('base64');
  const sessionA = savedSession(paths, { url: urlA, title: 'Fixture conversation A' }, [
    { id: 'sec-0', role: 'user', text: `debug dump from production:\nCookie: ${secrets.cookie}\n${secrets.bearer}\nprovider key ${secrets.apikey}\nowner ${secrets.name} <${secrets.email}>\npasted chat url https://example.test/x?access_token=${secrets.pastedUrlToken} (see it)`,
      blocks: [
        { type: 'text', text: `request headers:\nCookie: ${secrets.cookie}\n${secrets.bearer}\n${secrets.apikey}\n${secrets.email}` },
        { type: 'key_backup', opaque: { pem: `fixture opaque payload ${secrets.opaqueOnly}` } },
      ] },
    { id: 'sec-1', role: 'assistant', text: 'fixture answer about the topic', blocks: [] },
  ]);
  // Raw capture records (the L1 archive). These are the bytes a raw-including exporter would ship.
  sessionA.raw.append({ k: 'net.req', sid: 'p:1', url: `https://example.test/api?access_token=${secrets.urlTokenA}`,
    method: 'POST', headers: { authorization: secrets.rawAuth, cookie: secrets.rawCookie } });
  sessionA.raw.append({ k: 'net.res', sid: 'p:1', status: 200, headers: { 'set-cookie': secrets.rawCookie } });
  sessionA.raw.append({ k: 'net.body', sid: 'p:1', b64: bodyB64 });
  sessionA.raw.flush();

  // Session B: target URL carries userinfo and a secret-looking PATH segment (the documented limit).
  const urlB = `https://fixture-user:${secrets.userinfo}@example.test/p/${secrets.pathSeg}/chat?access_token=${secrets.urlTokenB}#${secrets.fragB}`;
  const sessionB = savedSession(paths, { url: urlB, title: 'Fixture conversation B' }, [
    { id: 'sec-2', role: 'user', text: 'second saved conversation', blocks: [{ type: 'text', text: 'visible line' }] },
    { id: 'sec-3', role: 'assistant', text: 'second answer', blocks: [] },
  ]);
  return { root, paths, secrets, sessionA, sessionB, bodyB64 };
}

// Build the standard world linkage through the HTTP contract, then export [project] in one mode.
async function exported(call, mode) {
  const list = (await call('GET', '/world/conversations')).data;
  const cidA = list.items.find((i) => i.title === 'Fixture conversation A').id;
  const cidB = list.items.find((i) => i.title === 'Fixture conversation B').id;
  const project = (await call('POST', '/world/projects', { title: 'Secret scan project', expectedVersion: null })).data;
  const object = (await call('POST', '/world/objects', { conversationId: cidA, expectedVersion: null })).data;
  const selection = (await call('POST', '/world/selections', {
    objectId: object.id, selectionType: 'part', messageIndex: 0, partPath: [0], expectedVersion: null,
  })).data;
  const note = (await call('POST', '/world/notes', { title: 'Scan note', body: 'user note', commentsOn: [selection.id], expectedVersion: null })).data;
  await call('PUT', `/world/projects/${project.id}`, {
    conversationIds: [cidA, cidB], noteIds: [note.id], memberIds: [object.id, selection.id], expectedVersion: project.version,
  });
  const response = await call('POST', '/world/transfer/export', { ids: [project.id], mode });
  assert.equal(response.status, 200, `export ${mode} failed: ${JSON.stringify(response.data)}`);
  return { bundle: response.data, cidA, cidB, pid: project.id };
}

const MODES = ['references', 'transcript', 'full-saved'];

// ---------------- measurement 1: the presence matrix ----------------

test('MEASURED presence matrix over the serialized export: cookies, bearer tokens, provider keys and PII ride transcript and full-saved VERBATIM in message text; references carries none only because it contains no message content; a key_backup block is dropped in transcript by block TYPE, not by scanning; raw capture and browser-profile sentinels are absent because they are outside the record closure', async (t) => {
  const f = seed(t);
  const studio = await start(f.paths);
  try {
    const call = HTTP(studio);
    const observed = {};
    for (const mode of MODES) {
      const { bundle, cidA } = await exported(call, mode);
      assert.equal(bundle.scope.mode, mode);
      const conv = bundle.records.find((r) => r.kind === 'conversation' && r.id === cidA);
      if (mode === 'references') assert.equal('messages' in conv.data, false, 'references carries no messages key at all');
      if (mode === 'transcript') {
        assert.deepEqual(conv.data.messages[0].blocks.map((b) => b.type), ['text']);
        assert.equal(bundle.omitted.some((o) => o.reason === 'non-transcript-blocks-excluded'), true);
      }
      if (mode === 'full-saved') assert.equal(conv.data.messages[0].blocks.map((b) => b.type).join(','), 'text,key_backup');
      observed[mode] = {
        cookie: has(bundle, f.secrets.cookie),
        bearer: has(bundle, f.secrets.bearer),
        apikey: has(bundle, f.secrets.apikey),
        email: has(bundle, f.secrets.email),
        name: has(bundle, f.secrets.name),
        pastedUrlToken: has(bundle, f.secrets.pastedUrlToken),
        opaqueOnly: has(bundle, f.secrets.opaqueOnly),
        rawAuth: has(bundle, f.secrets.rawAuth),
        rawCookie: has(bundle, f.secrets.rawCookie),
        rawBody: has(bundle, f.secrets.rawBody),
        rawBodyB64: has(bundle, f.bodyB64),
        profileCookie: has(bundle, f.secrets.profileCookie),
      };
    }
    // The expected matrix is the MEASURED one; any drift fails loudly instead of silently passing.
    const matrix = { cookie: [false, true, true], bearer: [false, true, true], apikey: [false, true, true],
      email: [false, true, true], name: [false, true, true], pastedUrlToken: [false, true, true],
      opaqueOnly: [false, false, true],
      rawAuth: [false, false, false], rawCookie: [false, false, false], rawBody: [false, false, false],
      rawBodyB64: [false, false, false], profileCookie: [false, false, false] };
    for (const [artifact, expected] of Object.entries(matrix)) {
      assert.deepEqual(MODES.map((m) => observed[m][artifact]), expected,
        `${artifact} presence matrix changed: ${JSON.stringify(observed)}`);
    }
    t.diagnostic(`observed matrix ${JSON.stringify(observed)}`);

    // The bundle's own qualification still discloses that no redaction exists.
    const { bundle } = await exported(call, 'full-saved');
    assert.ok(bundle.coverage.qualification.includes('Selected content is not automatically redacted.'));
    assert.equal(bundle.coverage.complete, true);
  } finally { await studio.close(); }
});

// ---------------- measurement 2: providerUrl projection (origin+pathname only) ----------------

test('providerUrl is projected as http/https origin+pathname in ALL THREE modes: the query-string credential, the userinfo password and the fragment never reach the bundle, while the pathname (including a secret-looking path segment) is kept; the sanitizer covers source.providerUrl only, NOT a credential URL pasted into message text', async (t) => {
  const f = seed(t);
  const studio = await start(f.paths);
  try {
    const call = HTTP(studio);
    for (const mode of MODES) {
      const { bundle, cidA, cidB } = await exported(call, mode);
      const convA = bundle.records.find((r) => r.kind === 'conversation' && r.id === cidA);
      const convB = bundle.records.find((r) => r.kind === 'conversation' && r.id === cidB);
      // Enforcing code: src/studio/world-url.mjs:16 `return url.origin + url.pathname;` — userinfo,
      // query string and fragment are dropped there. Applied at export by the choke point at
      // src/studio/world-transfer.mjs:184-186 and at the source read (src/studio/world-service.mjs:48).
      assert.equal(convA.data.source.providerUrl, 'https://example.test/path', `${mode}: query/fragment stripped`);
      assert.equal(convB.data.source.providerUrl, `https://example.test/p/${f.secrets.pathSeg}/chat`, `${mode}: origin+pathname`);
      assert.equal(has(bundle, f.secrets.urlTokenA), false, `${mode}: query credential in providerUrl projected away`);
      assert.equal(has(bundle, f.secrets.urlTokenB), false, `${mode}: second query credential projected away`);
      assert.equal(has(bundle, f.secrets.userinfo), false, `${mode}: userinfo projected away`);
      assert.equal(has(bundle, f.secrets.fragA), false, `${mode}: fragment projected away`);
      assert.equal(has(bundle, f.secrets.fragB), false, `${mode}: second fragment projected away`);
      // Documented limit: the path is preserved, so a secret that is a path segment stays.
      assert.equal(has(bundle, f.secrets.pathSeg), true, `${mode}: pathname kept (world-url.mjs:8-10 known limit)`);
      assert.equal(convA.data.identity.origin.value, 'https://example.test', `${mode}: identity origin only`);
      // Scope boundary of the sanitizer: a URL the USER pasted into message text is not projected.
      assert.equal(has(bundle, f.secrets.pastedUrlToken), mode !== 'references', `${mode}: message text is not URL-sanitized`);
    }
    // Read-time only: stored session.json bytes were never rewritten.
    const storedA = readFileSync(path.join(f.paths.sessions, f.sessionA.id, 'session.json'), 'utf8');
    assert.ok(storedA.includes(f.secrets.urlTokenA), 'stored saved URL keeps its query string (read-time projection, no rewrite)');
    const storedB = readFileSync(path.join(f.paths.sessions, f.sessionB.id, 'session.json'), 'utf8');
    assert.ok(storedB.includes(f.secrets.userinfo), 'stored saved URL keeps its userinfo (read-time projection, no rewrite)');
  } finally { await studio.close(); }
});

// ---------------- measurement 3: raw capture / browser profile are not in the closure ----------------

test('raw capture records and browser-profile bytes are NOT in the export closure at all — the sentinels are proven present on disk in the disposable session raw log and chrome-profile, and absent from every mode; this is omission, not the capture-side credential policy at src/capture/network.mjs:58-69 and not any export scrubbing', async (t) => {
  const f = seed(t);
  // Evidence the raw archive really holds the sensitive bytes (a naive exporter would ship them).
  const rawDir = path.join(f.paths.sessions, f.sessionA.id, 'raw');
  const rawBytes = readFileSync(path.join(rawDir, '000001.jsonl'), 'utf8');
  assert.ok(rawBytes.includes(f.secrets.rawAuth), 'raw log really stores the Authorization header value');
  assert.ok(rawBytes.includes(f.secrets.rawCookie), 'raw log really stores the Set-Cookie value');
  assert.ok(rawBytes.includes(f.bodyB64), 'raw log really stores the response body chunk (base64)');
  assert.ok(Buffer.from(f.bodyB64, 'base64').toString('utf8').includes(f.secrets.rawBody), 'decoded raw body carries the token');
  assert.ok(readFileSync(path.join(f.paths.chromeProfile, 'Default', 'Cookies'), 'utf8').includes(f.secrets.profileCookie),
    'browser-profile cookie file really holds the sentinel');

  const studio = await start(f.paths);
  try {
    const call = HTTP(studio);
    for (const mode of MODES) {
      const { bundle } = await exported(call, mode);
      // Named exclusions are declared, and the network-credential policy is capture-side only: no
      // browser/CDP runs in this test, so network.mjs:58-69 was never exercised. The export path
      // (world-transfer.mjs exportSelection) reads world records only — never session raw/ or a
      // profile store — so these bytes cannot be scrubbed by it: they are never selected.
      assert.deepEqual(bundle.scope.exclusions,
        ['raw-capture-files', 'browser-profiles', 'credentials-stores', 'provider-network', 'unrelated-world-records', 'external-asset-bytes']);
      assert.equal(has(bundle, f.secrets.rawAuth), false, `${mode}: raw Authorization header not in closure`);
      assert.equal(has(bundle, f.secrets.rawCookie), false, `${mode}: raw Set-Cookie not in closure`);
      assert.equal(has(bundle, f.secrets.rawBody), false, `${mode}: raw body plaintext not in closure`);
      assert.equal(has(bundle, f.bodyB64), false, `${mode}: raw body base64 not in closure`);
      assert.equal(has(bundle, f.secrets.profileCookie), false, `${mode}: browser-profile cookie not in closure`);
      // Negative control: the scan is not a no-op — saved message content IS found in two modes.
      assert.equal(has(bundle, f.secrets.cookie), mode !== 'references', `${mode}: scan control`);
    }
  } finally { await studio.close(); }
});
