// Same-owner Studio v1 routes for the local Personal Agent. No new server or effect owner.
import { createPersonalAgentService } from '../agents/personal-agent-service.mjs';
import { problem } from './http.mjs';

const versionSchema = { type: ['integer', 'null'], description: 'CAS version: null only for first initialization' };
const stringSchema = { type: 'string' };
export function registerPersonalAgentRoutes({ add, paths, getTools } = {}) {
  if (typeof add !== 'function') throw new TypeError('Studio add() required');
  const agent = createPersonalAgentService({ paths, getTools });
  const ensureBody = (body, allowed) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(k => !allowed.includes(k))) {
      throw problem(400, 'Unexpected Personal Agent request fields', 'PERSONAL_AGENT_INVALID');
    }
    return body;
  };
  add('GET', '/personal-agent/status', 'Read local Personal Agent bootstrap progress without initialization',
    () => agent.status(), { tool: 'personal_agent_status',
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } });
  add('GET', '/personal-agent/self-knowledge', 'Grounded self-knowledge: local claim, basis, freshness and qualification',
    ({ q }) => agent.selfKnowledge(q?.topic ?? 'all'),
    { tool: 'personal_agent_self_knowledge', query: { topic: { type: 'string',
      enum: ['all', 'identity', 'bootstrap', 'memory', 'work', 'world', 'capabilities', 'privacy'] } },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } });
  add('GET', '/personal-agent/sitrep', 'Read private local Agent continuity and pending Work; not an agent tool',
    () => agent.continuity());
  add('GET', '/personal-agent/export', 'Explicit JSON export; sensitive contents included only by opt-in',
    ({ q }) => {
      const flag = (value, name) => {
        if (value === undefined || value === 'false') return false;
        if (value === 'true') return true;
        throw problem(400, `${name} must be true or false`, 'PERSONAL_AGENT_INVALID');
      };
      return agent.exportSnapshot({
        includeMemory: flag(q?.includeMemory, 'includeMemory'),
        includeWorkDetails: flag(q?.includeWorkDetails, 'includeWorkDetails'),
      });
    }, { query: { includeMemory: { type: 'boolean', default: false }, includeWorkDetails: { type: 'boolean', default: false } } });
  add('GET', '/personal-agent/work', 'Read private local Personal Agent Work records (not in tool manifest)',
    () => agent.workList());
  add('POST', '/personal-agent/work', 'Create user-directed local Work; no provider dispatch',
    ({ body }) => agent.createWorkItem(ensureBody(body, ['expectedVersion', 'title', 'objective', 'idempotencyKey'])),
    { body: { type: 'object', properties: {
      expectedVersion: { type: 'integer', minimum: 1 }, title: { type: 'string', maxLength: 160 },
      objective: { type: 'string', maxLength: 4000 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
    }, required: ['expectedVersion', 'title', 'objective', 'idempotencyKey'], additionalProperties: false } });
  add('POST', '/personal-agent/work/{id}/transition', 'Explicit local Work status update; completion references are user-attested',
    ({ p, body }) => agent.transitionWorkItem({ ...ensureBody(body, ['expectedVersion', 'to', 'note', 'evidence']), id: p.id }),
    { body: { type: 'object', properties: {
      expectedVersion: { type: 'integer', minimum: 1 },
      to: { type: 'string', enum: ['queued', 'active', 'blocked', 'completed', 'cancelled'] },
      note: { type: 'string', maxLength: 2000 },
      evidence: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 256 } },
    }, required: ['expectedVersion', 'to'], additionalProperties: false } });
  add('GET', '/personal-agent/capabilities', 'Inspect bounded skill sources and registered Studio tools (no runtime proof)',
    () => agent.capabilities(), { tool: 'personal_agent_capabilities',
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } });
  add('POST', '/personal-agent/initialize', 'Initialize one local Personal Agent identity with CAS',
    ({ body }) => agent.initialize(ensureBody(body, ['expectedVersion'])),
    { body: { type: 'object', properties: { expectedVersion: { type: 'null' } }, required: ['expectedVersion'], additionalProperties: false } });
  add('POST', '/personal-agent/bootstrap', 'Run remaining local evidence-backed bootstrap stages; no external effects',
    ({ body }) => agent.bootstrap(ensureBody(body, ['expectedVersion'])),
    { body: { type: 'object', properties: { expectedVersion: versionSchema }, required: ['expectedVersion'], additionalProperties: false } });
  add('GET', '/personal-agent/memory/{tier}', 'Read one local Personal Agent memory tier; private values not exposed as a tool',
    ({ p }) => agent.memories(p.tier));
  add('PUT', '/personal-agent/memory/{tier}/{key}', 'Save explicit user-authored Personal Agent memory with CAS',
    ({ p, body }) => agent.remember({ ...ensureBody(body, ['text', 'expectedVersion']), tier: p.tier, key: p.key }),
    { body: { type: 'object', properties: { text: stringSchema, expectedVersion: { type: 'integer', minimum: 1 } }, required: ['text', 'expectedVersion'], additionalProperties: false } });
  add('POST', '/personal-agent/memory/{tier}/{key}/remove', 'Remove explicit local memory with CAS (version history preserved)',
    ({ p, body }) => agent.forget({ ...ensureBody(body, ['expectedVersion']), tier: p.tier, key: p.key }),
    { body: { type: 'object', properties: { expectedVersion: { type: 'integer', minimum: 1 } },
      required: ['expectedVersion'], additionalProperties: false } });
}
