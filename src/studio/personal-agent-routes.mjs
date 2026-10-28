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
