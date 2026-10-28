// Local-first Personal Agent scaffold. No independent browser owner, daemon, model or permission grant.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TOOL_ROOT } from '../config.mjs';
import { createWork, transitionWork, workSummary } from './personal-agent-work.mjs';
import { buildSelfKnowledge, SELF_KNOWLEDGE_TOPICS } from './personal-agent-self-knowledge.mjs';
import { createContinuityPacket, createPortableSnapshot } from './personal-agent-continuity.mjs';
import { VersionedStore } from '../store/versioned.mjs';
import { createAgenticFileLibrary } from '../studio/agentic-files.mjs';
import { problem, storeProblem } from '../studio/http.mjs';
import {
  BOOTSTRAP_STAGES, MEMORY_TIERS, createPersonalAgentBootstrap,
  nextPersonalAgentBootstrapStage, updatePersonalAgentBootstrap, validatePersonalAgentBootstrap,
} from './personal-agent-bootstrap.mjs';

const KEY = 'primary';
const token = (s) => typeof s === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(s);
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 20);
const memoryBlank = () => Object.fromEntries(MEMORY_TIERS.map(tier => [tier, []]));
// Stable fingerprint of THIS local data directory. It distinguishes two local instances without exposing the
// path, and it is deliberately not a device, account or cross-device identity. Separators are normalised with
// path.sep (host data, never a platform branch) so the same root hashes the same on every host; letter case is
// left alone because folding it would collapse two genuinely distinct case-sensitive directories into one scope.
const dirScope = (root) => 'local-dir-sha256:' + sha(path.resolve(root).split(path.sep).join('/'));

export function createPersonalAgentService({ paths, skillsRoot = TOOL_ROOT, getTools = () => [], clock = () => new Date().toISOString() } = {}) {
  if (!paths?.root || !path.isAbsolute(paths.root)) throw new TypeError('Absolute paths.root required');
  const store = new VersionedStore(path.join(paths.root, 'personal-agent'), { kind: 'personal agent' });
  const library = createAgenticFileLibrary({ roots: [{ path: skillsRoot, id: 'vivim-harness', untrusted: true }] });
  const scopeFingerprint = dirScope(paths.root);
  const read = () => {
    let exists;
    try { exists = store.has(KEY); } catch (e) { throw storeProblem(e); }
    if (!exists) return null;
    let state;
    try { state = store.load(KEY); } catch (e) { throw storeProblem(e); }
    try { validatePersonalAgentBootstrap(state); }
    catch { throw problem(500, 'Stored Personal Agent state failed schema validation', 'PERSONAL_AGENT_STATE_CORRUPT'); }
    return state;
  };
  const bad = (message, code = 'PERSONAL_AGENT_INVALID') => problem(400, message, code);
  const versioned = (state, expectedVersion, note) => {
    try { return store.compareAndSave(KEY, state, { expectedVersion, changeNote: note }); }
    catch (e) { throw storeProblem(e); }
  };
  function status() {
    const state = read();
    if (!state) return { initialized: false, schemaVersion: 1, agentId: KEY, scope: 'local-data-directory',
      scopeFingerprint, nextStage: BOOTSTRAP_STAGES[0], stages: null };
    return { initialized: true, schemaVersion: state.schemaVersion, agentId: state.agentId,
      scope: 'local-data-directory', scopeFingerprint,
      identityAssurance: 'local-instance-only; no remote account claim',
      version: state.version, createdAt: state.createdAt, updatedAt: state.updatedAt,
      stages: state.stages, nextStage: nextPersonalAgentBootstrapStage(state),
      observations: state.observations ?? {}, memoryCounts: Object.fromEntries(MEMORY_TIERS.map(tier => [tier, (state.memory?.[tier] ?? []).length])),
      work: workSummary(state),
      source: 'versioned-local-state; source and execution receipts are distinct' };
  }
  function initialize({ expectedVersion } = {}) {
    if (expectedVersion !== null) throw bad('Initialize requires expectedVersion:null', 'PERSONAL_AGENT_EXPECTED_VERSION');
    const state = createPersonalAgentBootstrap({ agentId: KEY, ownerId: 'local-instance', now: clock() });
    state.identity = { role: 'personal-agent', scope: 'local-single-user', principal: 'local-instance',
      assurance: 'data-directory-scope-only', providerAccountId: null };
    state.memory = memoryBlank();
    state.work = [];
    state.observations = {};
    versioned(state, null, 'Initialize local Personal Agent state');
    // Same projection as status(): one stable shape for every lifecycle response.
    return status();
  }
  function capabilities() {
    const scan = library.list();
    const tools = getTools();
    if (!Array.isArray(tools)) throw new TypeError('getTools must return an array');
    return {
      skills: {
        items: scan.items.filter(item => item.kind === 'skill').map(item => ({
          id: item.id, path: item.path, title: item.title, sha256: item.sha256,
          trust: 'untrusted-until-confirmed', availability: 'source-discovered-not-installed',
        })),
        coverage: scan.coverage,
        precedence: scan.precedence,
      },
      tools: tools.map(t => ({ name: t.name, http: t.http ? { method: t.http.method, path: t.http.path } : null,
        readOnly: t.annotations?.readOnlyHint === true,
        availability: 'registered; runtime operation not tested' })),
      limitations: 'Inventory and route registration do not prove authorization, installation or successful live execution.',
    };
  }
  function worldInventory() {
    const dir = path.join(paths.root, 'world');
    if (!existsSync(dir)) return { state: 'not-initialized', projects: 0, notes: 0, evidence: ['local:world/uninitialized'] };
    const world = new VersionedStore(dir, { kind: 'world item' });
    const names = world.names();
    return {
      state: 'enumerated', projects: names.filter(name => name.startsWith('p-')).length,
      notes: names.filter(name => name.startsWith('n-')).length,
      evidence: [`local:world/index-${sha(names.join('|'))}`],
    };
  }
  function selfKnowledge(topic = 'all') {
    if (topic !== 'all' && !SELF_KNOWLEDGE_TOPICS.includes(topic)) throw bad('Unknown self-knowledge topic', 'PERSONAL_AGENT_TOPIC_INVALID');
    const agent = status();
    let skills = null;
    if (topic === 'capabilities' || topic === 'all') {
      const view = capabilities();
      skills = { skillsDiscovered: view.skills.items.length,
        toolsRegistered: view.tools.length,
        sourceCoverageComplete: view.skills.coverage.complete,
        readOnlyToolsRegistered: view.tools.filter(t => t.readOnly).length,
        evidence: [`local:agentic-files/index-${sha(view.skills.items.map(item => item.id).join('|'))}`],
      };
    }
    return buildSelfKnowledge({
      topic, agent,
      world: topic === 'world' || topic === 'all' ? worldInventory() : { state: 'not-inspected' },
      skills, at: clock(),
    });
  }
  function evidenceFor(stage, state) {
    if (stage === BOOTSTRAP_STAGES[0]) return {
      refs: ['local:agent-identity/primary'], observation: {
        kind: 'local-instance', assurance: 'data-directory-scope-only',
        repository: 'vivim-harness', providerAccount: 'unverified',
      },
    };
    if (stage === BOOTSTRAP_STAGES[1]) {
      const dir = path.join(paths.root, 'world');
      if (!existsSync(dir)) return {
        refs: ['local:world/uninitialized'], observation: { source: 'world-store', state: 'not-yet-initialized', projects: 0, notes: 0 },
      };
      const world = new VersionedStore(dir, { kind: 'world item' });
      const names = world.names();
      const counts = { projects: names.filter(x => x.startsWith('p-')).length, notes: names.filter(x => x.startsWith('n-')).length };
      return { refs: [`local:world/inventory-${sha(JSON.stringify(counts))}`],
        observation: { source: 'world-store', state: 'enumerated', ...counts,
          claim: 'index counts only; no extracted facts or remote account coverage claimed' } };
    }
    if (stage === BOOTSTRAP_STAGES[2]) {
      const memory = state.memory ?? memoryBlank();
      for (const tier of MEMORY_TIERS) if (!Array.isArray(memory[tier])) throw bad('Malformed memory tier', 'PERSONAL_AGENT_MEMORY_CORRUPT');
      return { refs: ['local:agent-memory/three-tiers-v1'], observation: {
        tiers: [...MEMORY_TIERS], contentState: 'initialized-only; no personal facts inferred',
      }, memory };
    }
    if (stage === BOOTSTRAP_STAGES[3]) {
      const discovered = capabilities();
      if (!discovered.skills.coverage.complete || !discovered.skills.coverage.roots?.length || discovered.skills.coverage.roots.some(root => root.status !== 'scanned')) return { blocked: 'Skill inventory root unavailable or incomplete; review coverage', observation: {
        matched: discovered.skills.items.length, coverage: discovered.skills.coverage,
      } };
      return { refs: [`local:agentic-files/inventory-${sha(JSON.stringify(discovered.skills.items.map(x => x.id)))}`],
        observation: {
          skillsDiscovered: discovered.skills.items.length,
          registeredTools: discovered.tools.length, coverageComplete: true,
          claim: 'source discovered and routes registered only; no live execution',
        } };
    }
    throw bad('Unknown stage');
  }
  // One explicit, synchronous local bootstrap. Every stage is committed independently for crash recovery.
  // No browser/CDP effects, external requests, auto-sends or network identity inference.
  // expectedVersion:null means "start or resume from whatever exists"; an integer must match CURRENT.
  function bootstrap({ expectedVersion } = {}) {
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw bad('expectedVersion must be null or positive integer', 'PERSONAL_AGENT_EXPECTED_VERSION');
    }
    let state = read();
    if (!state) {
      if (expectedVersion !== null) throw problem(409, 'Personal Agent not initialized', 'PERSONAL_AGENT_NOT_INITIALIZED');
      initialize({ expectedVersion: null });
      state = read();
    } else if (expectedVersion !== null && expectedVersion !== state.version) {
      throw problem(409, 'Personal Agent version changed; refresh status', 'PERSONAL_AGENT_VERSION_CONFLICT');
    }
    for (const stage of BOOTSTRAP_STAGES) {
      if (state.stages[stage].status === 'completed') continue;
      let report;
      try { report = evidenceFor(stage, state); }
      catch (e) {
        if (e?.code?.startsWith('STORE_') || e?.code?.startsWith('CAS_')) throw storeProblem(e);
        report = { blocked: `Discovery failed: ${e?.code ?? 'UNKNOWN'}`, observation: { failureCode: e?.code ?? 'UNKNOWN' } };
      }
      // Repeated blocked probes with identical evidence do not consume VersionedStore revisions.
      if (report.blocked && state.stages[stage].status === 'blocked'
        && state.stages[stage].blocker === report.blocked
        && JSON.stringify(state.observations?.[stage]) === JSON.stringify(report.observation)) break;
      const now = clock();
      const next = updatePersonalAgentBootstrap(state, { stage, status: report.blocked ? 'blocked' : 'completed',
        evidence: report.refs ?? [], blocker: report.blocked ?? null, now });
      next.observations = { ...(state.observations ?? {}), [stage]: report.observation };
      if (report.memory) next.memory = report.memory;
      state = versioned(next, state.version, `Bootstrap stage: ${stage}`);
      if (report.blocked) break;
    }
    return status();
  }
  const corrupt = () => problem(500, 'Stored Personal Agent memory tier is not an array', 'PERSONAL_AGENT_STATE_CORRUPT');
  const tierOf = (memory, tier) => {
    const entries = memory?.[tier] ?? [];
    if (!Array.isArray(entries)) throw corrupt();
    return entries;
  };
  function memories(tier) {
    if (!MEMORY_TIERS.includes(tier)) throw bad('Unknown memory tier');
    const state = read();
    if (!state) throw problem(404, 'Initialize Personal Agent first', 'PERSONAL_AGENT_NOT_INITIALIZED');
    return { tier, version: state.version, updatedAt: state.updatedAt, entries: structuredClone(tierOf(state.memory, tier)),
      disclosure: 'User-authored local data; not injected into provider requests automatically' };
  }
  function remember({ tier, key, text, expectedVersion } = {}) {
    if (!MEMORY_TIERS.includes(tier)) throw bad('Unknown memory tier');
    if (!token(key)) throw bad('Memory key must be a short token');
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw bad('Memory text must be 1..8000 characters');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw bad('expectedVersion required');
    const state = read();
    if (!state) throw problem(404, 'Initialize Personal Agent first', 'PERSONAL_AGENT_NOT_INITIALIZED');
    if (state.version !== expectedVersion) throw problem(409, 'Memory version changed; refresh first', 'PERSONAL_AGENT_VERSION_CONFLICT');
    const memory = structuredClone(state.memory ?? memoryBlank());
    const entries = tierOf(memory, tier);
    if (entries.length >= 500 && !entries.some(x => x.key === key)) throw problem(409, 'Memory tier is full', 'PERSONAL_AGENT_MEMORY_LIMIT');
    const stamp = clock();
    const record = { key, text: text.trim(), source: 'user-authored', updatedAt: stamp };
    const i = entries.findIndex(x => x.key === key);
    if (i >= 0) entries[i] = record; else entries.push(record);
    memory[tier] = entries;
    versioned({ ...state, memory, updatedAt: stamp }, state.version, `User memory update: ${tier}`);
    return status(); // never echo private memory text
  }
  // Explicit removal is an append-only versioned change, not a destructive rewrite of prior history.
  function forget({ tier, key, expectedVersion } = {}) {
    if (!MEMORY_TIERS.includes(tier)) throw bad('Unknown memory tier');
    if (!token(key)) throw bad('Invalid memory key');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw bad('expectedVersion required');
    const state = read();
    if (!state) throw problem(404, 'Initialize Personal Agent first', 'PERSONAL_AGENT_NOT_INITIALIZED');
    if (state.version !== expectedVersion) throw problem(409, 'Memory version changed; refresh first', 'PERSONAL_AGENT_VERSION_CONFLICT');
    const memory = structuredClone(state.memory ?? memoryBlank());
    const old = tierOf(memory, tier);
    if (!old.some(entry => entry.key === key)) throw problem(404, 'Memory entry not found', 'PERSONAL_AGENT_MEMORY_NOT_FOUND');
    memory[tier] = old.filter(entry => entry.key !== key);
    versioned({ ...state, memory, updatedAt: clock() }, state.version, `User memory removal: ${tier}`);
    return status();
  }
  function continuity() {
    const state = read();
    if (!state) throw problem(404, 'Initialize Personal Agent first', 'PERSONAL_AGENT_NOT_INITIALIZED');
    return createContinuityPacket(state, { now: clock(), scopeFingerprint });
  }
  function exportSnapshot({ includeMemory = false, includeWorkDetails = false } = {}) {
    const state = read();
    if (!state) throw problem(404, 'Initialize Personal Agent first', 'PERSONAL_AGENT_NOT_INITIALIZED');
    return createPortableSnapshot(state, { includeMemory, includeWorkDetails, now: clock(), scopeFingerprint });
  }
  // User-owned, durable Work is deliberately not an executor. These methods never send to a provider.
  function workList() {
    const state = read();
    if (!state) throw problem(404, 'Initialize Personal Agent first', 'PERSONAL_AGENT_NOT_INITIALIZED');
    return { version: state.version, items: structuredClone(state.work ?? []),
      execution: 'not-dispatched', disclosure: 'Private local Work; no provider action' };
  }
  function requireWorkVersion(expectedVersion) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw bad('expectedVersion required', 'PERSONAL_AGENT_EXPECTED_VERSION');
    const state = read();
    if (!state) throw problem(404, 'Initialize Personal Agent first', 'PERSONAL_AGENT_NOT_INITIALIZED');
    if (state.version !== expectedVersion) throw problem(409, 'Work version changed; refresh first', 'PERSONAL_AGENT_VERSION_CONFLICT');
    return state;
  }
  function createWorkItem({ expectedVersion, title, objective, idempotencyKey } = {}) {
    // A response lost after commit may be retried with its original stale version.
    // Return the existing same-key/same-payload item, never create a duplicate.
    const state = read();
    if (!state) throw problem(404, 'Initialize Personal Agent first', 'PERSONAL_AGENT_NOT_INITIALIZED');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw bad('expectedVersion required', 'PERSONAL_AGENT_EXPECTED_VERSION');
    const result = createWork(state, { title, objective, idempotencyKey, now: clock() });
    if (state.version !== expectedVersion && result.changed) throw problem(409, 'Work version changed; refresh first', 'PERSONAL_AGENT_VERSION_CONFLICT');
    if (result.changed) versioned(result.state, state.version, 'User-created Work item');
    return { ...status(), item: result.item, replayed: !result.changed };
  }
  function transitionWorkItem({ expectedVersion, id, to, note, evidence } = {}) {
    const state = requireWorkVersion(expectedVersion);
    const result = transitionWork(state, { id, to, note, evidence, now: clock() });
    versioned(result.state, state.version, `User Work transition: ${to}`);
    return { ...status(), item: result.item };
  }
  return { status, initialize, bootstrap, capabilities, selfKnowledge, continuity, exportSnapshot, memories, remember, forget, workList, createWorkItem, transitionWorkItem };
}
