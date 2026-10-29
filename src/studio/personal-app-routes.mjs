// Local product factory API over the existing Studio server, not another service.
// These endpoints are intentionally absent from model-tool discovery.
import { createPersonalAppService } from './personal-app-service.mjs';
import { createPersonalAppContentService } from './personal-app-content.mjs';
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
  const content = createPersonalAppContentService({ paths, apps });
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
  // User-operated local notes/tasks, separate from the AI-readable blueprint.
  // Not published as model tools. GET never creates or changes content.
  add('GET', '/personal-apps/{id}/content', 'Read locally saved notes and tasks for one personal app',
    ({ p }) => content.get(p.id), { pathParameters: { id: { type: 'string', pattern: idPattern } } });
  add('POST', '/personal-apps/{id}/content/items', 'Create a user-authored note or task with idempotent local CAS',
    ({ p, body }) => content.createItem({ id: p.id, ...strict(body, ['expectedVersion', 'idempotencyKey', 'kind', 'title', 'body']) }),
    { body: { type: 'object', properties: {
      expectedVersion: { type: 'integer', minimum: 0 },
      idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
      kind: { type: 'string', enum: ['note', 'task'] },
      title: { type: 'string', minLength: 1, maxLength: 160 },
      body: { type: 'string', maxLength: 4000 },
    }, required: ['expectedVersion', 'idempotencyKey', 'kind', 'title'], additionalProperties: false },
    pathParameters: { id: { type: 'string', pattern: idPattern } } });
  add('POST', '/personal-apps/{id}/content/items/{itemId}/completion',
    'Change a local task completion flag with strict content revision matching',
    ({ p, body }) => content.setTaskComplete({
      id: p.id, itemId: p.itemId, ...strict(body, ['expectedVersion', 'completed']),
    }), { body: { type: 'object', properties: {
      expectedVersion: { type: 'integer', minimum: 1 },
      completed: { type: 'boolean' },
    }, required: ['expectedVersion', 'completed'], additionalProperties: false },
    pathParameters: {
      id: { type: 'string', pattern: idPattern },
      itemId: { type: 'string', pattern: '^item-[a-f0-9]{32}
  add('POST', '/personal-apps/{id}/preview-change', 'Validate and preview an untrusted declarative app proposal',
    ({ p, body }) => apps.previewChange({ id: p.id, ...strict(body, ['proposal']) }),
    { body: { type: 'object', properties: {
      proposal: { type: ['string', 'object'], description: 'Strict JSON screen-change proposal' },
    }, required: ['proposal'], additionalProperties: false } });
  add('POST', '/personal-apps/{id}/apply-change', 'Apply an explicit user-approved declarative change with CAS',
    ({ p, body }) => apps.applyChange({ id: p.id, ...strict(body, ['expectedVersion', 'proposal', 'approval']) }),
    { body: { type: 'object', properties: {
      expectedVersion: { type: 'integer', minimum: 1 },
      proposal: { type: ['string', 'object'] },
      approval: { type: 'string', enum: ['user-confirmed'] },
    }, required: ['expectedVersion', 'proposal', 'approval'], additionalProperties: false } });
  add('POST', '/personal-apps/{id}/screens', 'Add one validated user-directed mobile screen; no provider or code execution',
    ({ p, body }) => apps.addScreen({ id: p.id, ...strict(body, ['expectedVersion', 'kind', 'label']) }),
    { body: { type: 'object', properties: {
      expectedVersion: { type: 'integer', minimum: 1 },
      kind: { type: 'string', enum: ['notes', 'tasks', 'dashboard', 'blank'] },
      label: { type: 'string', minLength: 1, maxLength: 64 },
    }, required: ['expectedVersion', 'kind', 'label'], additionalProperties: false },
    pathParameters: { id: { type: 'string', pattern: idPattern } } });
}
 },
    } });
  // This is a nonexecuting compiler boundary, not a model API and not a browser effect.
  add('POST', '/personal-apps/{id}/preview-change', 'Validate and preview an untrusted declarative app proposal',
    ({ p, body }) => apps.previewChange({ id: p.id, ...strict(body, ['proposal']) }),
    { body: { type: 'object', properties: {
      proposal: { type: ['string', 'object'], description: 'Strict JSON screen-change proposal' },
    }, required: ['proposal'], additionalProperties: false } });
  add('POST', '/personal-apps/{id}/apply-change', 'Apply an explicit user-approved declarative change with CAS',
    ({ p, body }) => apps.applyChange({ id: p.id, ...strict(body, ['expectedVersion', 'proposal', 'approval']) }),
    { body: { type: 'object', properties: {
      expectedVersion: { type: 'integer', minimum: 1 },
      proposal: { type: ['string', 'object'] },
      approval: { type: 'string', enum: ['user-confirmed'] },
    }, required: ['expectedVersion', 'proposal', 'approval'], additionalProperties: false } });
  add('POST', '/personal-apps/{id}/screens', 'Add one validated user-directed mobile screen; no provider or code execution',
    ({ p, body }) => apps.addScreen({ id: p.id, ...strict(body, ['expectedVersion', 'kind', 'label']) }),
    { body: { type: 'object', properties: {
      expectedVersion: { type: 'integer', minimum: 1 },
      kind: { type: 'string', enum: ['notes', 'tasks', 'dashboard', 'blank'] },
      label: { type: 'string', minLength: 1, maxLength: 64 },
    }, required: ['expectedVersion', 'kind', 'label'], additionalProperties: false },
    pathParameters: { id: { type: 'string', pattern: idPattern } } });
}
