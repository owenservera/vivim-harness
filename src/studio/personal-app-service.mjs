// One local owner for user-authored personal app blueprints and declarative mobile screens.
// No AI/provider dispatch, code execution, file generation, sync or installer.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { VersionedStore } from '../store/versioned.mjs';
import { problem, storeProblem } from './http.mjs';
import { createPersonalAppBlueprint, addPersonalAppScreen, personalAppScaffold,
  assertPersonalAppBlueprint, isPersonalAppId, previewPersonalAppChange, PERSONAL_APP_TEMPLATES } from './personal-app-blueprint.mjs';

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const MAX_APPS = 20;
const fail = (status, message, code = 'PERSONAL_APP_INVALID') => problem(status, message, code);
export function createPersonalAppService({ paths, clock = () => new Date().toISOString() } = {}) {
  if (!paths?.root || !path.isAbsolute(paths.root)) throw new TypeError('Absolute paths.root is required');
  const store = new VersionedStore(path.join(paths.root, 'personal-apps'), { kind: 'personal app' });
  const readProblem = error => {
    if (['PERSONAL_APP_CORRUPT', 'STORE_CURRENT_CORRUPT', 'STORE_RECORD_CORRUPT',
      'STORE_NO_SUCH_VERSION', 'STORE_NO_SUCH_ITEM'].includes(error?.code)) {
      return fail(500, 'Your saved app could not be opened. Nothing was replaced. Keep the saved files on your PC and ask for help restoring them.', 'PERSONAL_APP_CORRUPT');
    }
    return storeProblem(error);
  };
  const exists = id => {
    try {
      if (store.has(id)) return true;
      if (store.versions(id).length) throw fail(500, 'Saved app pointer is missing', 'PERSONAL_APP_CORRUPT');
      return false;
    } catch (error) { throw readProblem(error); }
  };
  const load = id => {
    if (!isPersonalAppId(id)) throw fail(400, 'Invalid personal app ID');
    if (!exists(id)) throw fail(404, 'This app is not saved on this PC. Open your app library and choose another app.', 'PERSONAL_APP_NOT_FOUND');
    try {
      const app = store.load(id);
      assertPersonalAppBlueprint(app);
      return app;
    } catch (error) { throw readProblem(error); }
  };
  const commit = (id, value, expectedVersion, note) => {
    try { return store.compareAndSave(id, value, { expectedVersion, changeNote: note }); }
    catch (error) { throw storeProblem(error); }
  };
  function list() {
    const apps = store.names().map(id => {
      const app = load(id);
      return { id: app.id, title: app.title, version: app.version,
        updatedAt: app.updatedAt, screenCount: app.screens.length,
        deployStatus: app.deployStatus, providerExecution: app.providerExecution };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { schema: 'vivim.personal-app-index/1', total: apps.length, items: apps,
      source: 'user-owned-versioned-local-blueprints', providerExecution: 'not-attempted' };
  }
  function create({ title, intent, idempotencyKey } = {}, template = null) {
    if (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey)) {
      throw fail(400, 'A stable 8..128 character idempotency key is required');
    }
    const id = 'app-' + createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
    // Validate the request BEFORE consulting an existing id: replay is allowed only for the same inputs.
    let blueprint = createPersonalAppBlueprint({ id, title, intent, now: clock() });
    if (template) {
      blueprint.template = template.id;
      for (const screen of template.screens) blueprint = addPersonalAppScreen(blueprint, { ...screen, now: clock() });
    }
    if (exists(id)) {
      const previous = load(id);
      if (previous.title !== blueprint.title || previous.intent !== blueprint.intent || previous.template !== blueprint.template) {
        throw fail(409, 'This creation key was used for another request', 'PERSONAL_APP_IDEMPOTENCY_CONFLICT');
      }
      return { app: previous, replayed: true };
    }
    if (store.names().length >= MAX_APPS) {
      throw fail(409, 'Personal app index is full', 'PERSONAL_APP_LIMIT');
    }
    // Concurrent same-key creates are fenced by the store CAS; replay requires a read-only retry.
    const saved = commit(id, blueprint, null, 'Created user-owned personal mobile app blueprint');
    return { app: saved, replayed: false };
  }
  function fromTemplate({ template, title, idempotencyKey } = {}) {
    const chosen = PERSONAL_APP_TEMPLATES.find(item => item.id === template);
    if (!chosen) throw fail(400, 'Choose one of the available app templates');
    return create({ title: title ?? chosen.title, intent: chosen.intent, idempotencyKey }, chosen);
  }
  function addScreen({ id, expectedVersion, kind, label } = {}) {
    const before = load(id);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion !== before.version) {
      throw fail(409, 'App revision changed; refresh before editing', 'PERSONAL_APP_VERSION_CONFLICT');
    }
    const next = addPersonalAppScreen(before, { kind, label, now: clock() });
    const saved = commit(id, next, expectedVersion, 'Added user-directed declarative mobile screen');
    return { app: saved, changed: true };
  }
  function previewChange({ id, proposal } = {}) {
    const app = load(id);
    return previewPersonalAppChange(app, proposal, { now: clock() });
  }
  function applyChange({ id, expectedVersion, proposal, approval } = {}) {
    if (approval !== 'user-confirmed') {
      throw fail(403, 'Explicit local user approval is required', 'PERSONAL_APP_APPROVAL_REQUIRED');
    }
    const before = load(id);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== before.version) {
      throw fail(409, 'App revision changed; refresh before applying', 'PERSONAL_APP_VERSION_CONFLICT');
    }
    const preview = previewPersonalAppChange(before, proposal, { now: clock() });
    let next = before;
    for (const op of preview.change.operations) {
      next = addPersonalAppScreen(next, { kind: op.kind, label: op.label, now: clock() });
    }
    const saved = commit(id, next, expectedVersion, 'Explicitly approved bounded data-only app proposal');
    return { app: saved, applied: preview.diff, externalProvenance: 'not-verified',
      providerExecution: 'not-attempted', deployed: false };
  }
  return {
    list, create, fromTemplate, templates: () => ({ items: PERSONAL_APP_TEMPLATES }), get: load, addScreen, previewChange, applyChange,
    scaffold: id => { const app = load(id); return { version: app.version, scaffold: personalAppScaffold(app) }; },
  };
}
