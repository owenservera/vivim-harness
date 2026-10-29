// Personal App Builder v0: deterministic, inert blueprint DSL.
// A model may eventually PROPOSE changes through the existing Harness, but its output
// must pass this same validator. Nothing in a blueprint is executable code.
export const PERSONAL_APP_SCHEMA = 'vivim.personal-app/1';
export const PERSONAL_APP_KINDS = Object.freeze(['notes', 'tasks', 'dashboard', 'blank']);
export const PERSONAL_APP_BASE_SCREENS = Object.freeze(['home', 'agent', 'builder']);
export const MAX_PERSONAL_APP_SCREENS = 12;
// Templates are trusted data, not executable UI. Reuse the same renderer/validator kinds.
export const PERSONAL_APP_TEMPLATES = Object.freeze([
  { id: 'reading-list', title: 'My Reading List', intent: 'Keep books and articles to read, with notes and a done list.', screens: [{ kind: 'tasks', label: 'To Read' }, { kind: 'notes', label: 'Reading Notes' }] },
  { id: 'household-tasks', title: 'Household Tasks', intent: 'Keep track of household chores and useful household notes.', screens: [{ kind: 'tasks', label: 'Chores' }, { kind: 'notes', label: 'Household Notes' }] },
  { id: 'notes', title: 'My Notes', intent: 'Write and keep personal notes on my PC.', screens: [{ kind: 'notes', label: 'Notes' }] },
  { id: 'study-planner', title: 'Study Planner', intent: 'Plan study tasks and keep study notes.', screens: [{ kind: 'tasks', label: 'Study Plan' }, { kind: 'notes', label: 'Study Notes' }, { kind: 'dashboard', label: 'Progress' }] },
  { id: 'habit-tracker', title: 'Habit Tracker', intent: 'Track habits with a checklist and keep reflection notes.', screens: [{ kind: 'tasks', label: 'Habits' }, { kind: 'notes', label: 'Reflections' }] },
  { id: 'blank', title: 'My App', intent: 'Start a personal app and choose my own screens.', screens: [{ kind: 'blank', label: 'My Canvas' }] },
].map(template => Object.freeze({ ...template, screens: Object.freeze(template.screens.map(screen => Object.freeze(screen))) })));
const invalid = (message, code = 'PERSONAL_APP_INVALID', status = 400) =>
  Object.assign(new Error(message), { code, status });
const clean = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw invalid(label + ' must contain 1..' + max + ' printable characters');
  }
  return value.trim();
};
const slug = value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
const idPattern = /^app-[a-f0-9]{32}$/;
export const isPersonalAppId = id => typeof id === 'string' && idPattern.test(id);

export function createPersonalAppBlueprint({ id, title, intent, now }) {
  if (!isPersonalAppId(id)) throw invalid('Invalid local app id');
  const name = clean(title, 'title', 80), request = clean(intent, 'intent', 2000);
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw invalid('Invalid time');
  return {
    schema: PERSONAL_APP_SCHEMA, id, title: name, intent: request, createdAt: now, updatedAt: now,
    source: 'explicit-user-request', platform: 'mobile-first-pwa-scaffold',
    authority: 'local-user-owned-blueprint', providerExecution: 'not-attempted',
    remoteBinding: 'not-configured', deployStatus: 'not-built',
    screens: [
      { key: 'home', label: 'Home', kind: 'home', origin: 'base-scaffold' },
      { key: 'agent', label: 'My Agent', kind: 'agent', origin: 'base-scaffold' },
      { key: 'builder', label: 'Build', kind: 'builder', origin: 'base-scaffold' },
    ],
    buildHistory: [{ type: 'created', at: now, basis: 'user-authored-intent; no-model-call' }],
  };
}

export function assertPersonalAppBlueprint(app) {
  if (!app || typeof app !== 'object' || Array.isArray(app) || app.schema !== PERSONAL_APP_SCHEMA ||
      !isPersonalAppId(app.id) || typeof app.title !== 'string' || app.title.length > 80 ||
      typeof app.intent !== 'string' || app.intent.length > 2000 ||
      app.source !== 'explicit-user-request' ||
      !Array.isArray(app.screens) || app.screens.length < 3 || app.screens.length > MAX_PERSONAL_APP_SCREENS) {
    throw invalid('Invalid or unsupported app blueprint', 'PERSONAL_APP_CORRUPT', 500);
  }
  const seen = new Set();
  for (const screen of app.screens) {
    if (!screen || typeof screen.key !== 'string' || !/^[a-z][a-z0-9-]{0,48}$/.test(screen.key) ||
        typeof screen.label !== 'string' || !screen.label.trim() || screen.label.length > 64 ||
        typeof screen.kind !== 'string' ||
        !['home', 'agent', 'builder', ...PERSONAL_APP_KINDS].includes(screen.kind) ||
        seen.has(screen.key)) throw invalid('Invalid or repeated screen', 'PERSONAL_APP_CORRUPT', 500);
    seen.add(screen.key);
  }
  if (PERSONAL_APP_BASE_SCREENS.some(key => !seen.has(key))) {
    throw invalid('Required app navigation is missing', 'PERSONAL_APP_CORRUPT', 500);
  }
  return app;
}

export function addPersonalAppScreen(app, { kind, label, now }) {
  assertPersonalAppBlueprint(app);
  if (!PERSONAL_APP_KINDS.includes(kind)) throw invalid('Unsupported starter screen kind');
  const title = clean(label, 'screen label', 64);
  const key = 'custom-' + slug(title);
  if (key === 'custom-' || key.length > 49) throw invalid('Screen label needs a readable identifier');
  if (app.screens.some(screen => screen.key === key)) {
    throw invalid('Screen already exists', 'PERSONAL_APP_SCREEN_EXISTS', 409);
  }
  if (app.screens.length >= MAX_PERSONAL_APP_SCREENS) {
    throw invalid('App has reached the starter screen limit', 'PERSONAL_APP_LIMIT', 409);
  }
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw invalid('Invalid time');
  return {
    ...app, updatedAt: now,
    screens: [...app.screens, { key, label: title, kind, origin: 'explicit-user-customization' }],
    buildHistory: [...(app.buildHistory ?? []), { type: 'screen-added', key, at: now,
      basis: 'user-directed-local-schema-change; no-provider-execution' }],
  };
}

// Portable data-only mobile layout contract. A renderer must use textContent and
// a fixed component registry; never execute UI instructions or arbitrary code from AI.
export function personalAppScaffold(app) {
  assertPersonalAppBlueprint(app);
  return {
    schema: 'vivim.personal-mobile-scaffold/1', appId: app.id,
    name: app.title, screens: app.screens.map(({ key, label, kind }) => ({ key, label, kind })),
    defaultScreen: 'home',
    theme: { base: 'system', accent: 'user-configurable' },
    connection: { mode: 'owner-pc-required', paired: false, transport: 'not-selected' },
    data: { authority: 'user-pc', offlineCache: 'not-implemented', sync: 'not-implemented' },
    intelligence: { engine: 'vivim-harness', aiAccountExecution: 'not-connected', dispatch: 'disabled' },
    editableBy: 'local-user-intent', runnableCode: false, packaging: 'not-implemented',
    scope: 'JSON blueprint and renderer contract; not an APK or installed PWA',
  };
}


export const PERSONAL_APP_CHANGE_SCHEMA = 'vivim.personal-app-change/1';
// The Harness may eventually supply this from a real observed provider reply.
// This compiler never trusts a JSON field claiming that a provider ran or a user approved.
export function parsePersonalAppChange(value) {
  let raw = value;
  if (typeof value === 'string') {
    if (value.length > 12000) throw invalid('Proposed change exceeds input limit');
    try { raw = JSON.parse(value); } catch { throw invalid('Proposed change must be valid JSON'); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !['schema', 'appId', 'baseVersion', 'operations'].includes(key)) ||
      raw.schema !== PERSONAL_APP_CHANGE_SCHEMA || !isPersonalAppId(raw.appId) ||
      !Number.isSafeInteger(raw.baseVersion) || raw.baseVersion < 1 ||
      !Array.isArray(raw.operations) || !raw.operations.length || raw.operations.length > 4) {
    throw invalid('Unsupported personal app change proposal');
  }
  const operations = raw.operations.map(op => {
    if (!op || typeof op !== 'object' || Array.isArray(op) ||
        Object.keys(op).some(key => !['type', 'kind', 'label'].includes(key)) ||
        op.type !== 'add-screen' || !PERSONAL_APP_KINDS.includes(op.kind)) {
      throw invalid('Proposals may only add supported data-only screens');
    }
    return { type: 'add-screen', kind: op.kind, label: clean(op.label, 'screen label', 64) };
  });
  return { schema: PERSONAL_APP_CHANGE_SCHEMA, appId: raw.appId,
    baseVersion: raw.baseVersion, operations };
}

export function previewPersonalAppChange(app, proposal, { now } = {}) {
  assertPersonalAppBlueprint(app);
  const change = parsePersonalAppChange(proposal);
  if (change.appId !== app.id || change.baseVersion !== app.version) {
    throw invalid('Change targets another app or an outdated version', 'PERSONAL_APP_VERSION_CONFLICT', 409);
  }
  let next = app;
  const diff = [];
  for (const op of change.operations) {
    next = addPersonalAppScreen(next, { kind: op.kind, label: op.label, now });
    diff.push({ type: 'add-screen', key: next.screens.at(-1).key,
      label: op.label, kind: op.kind });
  }
  return {
    schema: 'vivim.personal-app-preview/1', appId: app.id,
    baseVersion: app.version, change, diff, scaffold: personalAppScaffold(next),
    canApply: true, effects: 'none', externalProvenance: 'not-verified',
    approvalRequired: true,
    qualification: 'Validated data-only proposal. No provider response was authenticated, no code ran, and nothing was deployed.',
  };
}
