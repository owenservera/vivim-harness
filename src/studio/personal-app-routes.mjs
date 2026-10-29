// Local product factory API over the existing Studio server, not another service.
// These endpoints are intentionally absent from model-tool discovery.
import { createPersonalAppService } from './personal-app-service.mjs';
import { problem } from './http.mjs';

const idPattern = '^app-[a-f0-9]{32}$';
const strict = (body, allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key))) {
    throw problem(400, 'Unexpected personal app request fields', 'PERSONAL_APP_INVALID');
  }
  return body;
};
export function registerPersonalAppRoutes({ add, paths } = {}) {
  if (typeof add !== 'function') throw new TypeError('Studio add() required');
  const apps = createPersonalAppService({ paths });
  add('GET', '/personal-apps', 'List local user-owned personal mobile app blueprints',
    () => apps.list());
  add('POST', '/personal-apps', 'Create a minimal local app blueprint from explicit intent; no provider execution',
    ({ body }) => apps.create(strict(body, ['title', 'intent', 'idempotencyKey'])),
    { body: { type: 'object', properties: {
      title: { type: 'string', minLength: 1, maxLength: 80 },
      intent: { type: 'string', minLength: 1, maxLength: 2000 },
      idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
    }, required: ['title', 'intent', 'idempotencyKey'], additionalProperties: false } });
  add('GET', '/personal-apps/{id}', 'Read one locally-owned app blueprint',
    ({ p }) => apps.get(p.id), { pathParameters: { id: { type: 'string', pattern: idPattern } } });
  add('GET', '/personal-apps/{id}/scaffold', 'Read a data-only mobile screen manifest; not installed code',
    ({ p }) => apps.scaffold(p.id), { pathParameters: { id: { type: 'string', pattern: idPattern } } });
  add('POST', '/personal-apps/{id}/screens', 'Add one validated user-directed mobile screen; no provider or code execution',
    ({ p, body }) => apps.addScreen({ id: p.id, ...strict(body, ['expectedVersion', 'kind', 'label']) }),
    { body: { type: 'object', properties: {
      expectedVersion: { type: 'integer', minimum: 1 },
      kind: { type: 'string', enum: ['notes', 'tasks', 'dashboard', 'blank'] },
      label: { type: 'string', minLength: 1, maxLength: 64 },
    }, required: ['expectedVersion', 'kind', 'label'], additionalProperties: false },
    pathParameters: { id: { type: 'string', pattern: idPattern } } });
}
