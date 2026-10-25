// Curated prior corpus: common field conventions across web apps and APIs, with semantic roles.
// Transfer-learning seed for the role classifier. Format: [role, name, kind, format, avgLen, uniqueness, extra].
// Broad by design (CRMs, commerce, chat, devops, IoT, CMS, finance, workflow); not derived from
// evaluation fixtures, although held-out v1/v2 are marked "seen" and v3 measures independence.
export const ROLES = ['id', 'reference', 'timestamp', 'title', 'text', 'url', 'measure', 'category', 'flag', 'count', 'metadata'];

const P = [];
const add = (role, rows) => rows.forEach((r) => P.push([role, ...r]));

add('id', [
  ['id', 'string', 'uuid', 36, 1], ['uuid', 'string', 'uuid', 36, 1], ['_id', 'string', 'hex_id', 24, 1], ['key', 'string', null, 12, 1], ['slug', 'string', null, 20, 1],
  ['guid', 'string', 'uuid', 36, 1], ['id', 'integer', null, null, 1], ['pk', 'integer', null, null, 1], ['uid', 'string', 'hex_id', 16, 1], ['record_id', 'string', null, 14, 1],
  ['message_id', 'string', 'uuid', 36, 1], ['itemId', 'string', 'token_id', 20, 1], ['msg_id', 'string', 'token_id', 24, 1], ['node_id', 'string', 'token_id', 20, 1], ['sku', 'string', null, 10, 1],
  ['invoice_number', 'string', null, 10, 1], ['order_no', 'string', null, 10, 1], ['ticket_no', 'string', null, 8, 1], ['case_number', 'string', null, 9, 1], ['external_id', 'string', null, 14, 1],
  ['ticker', 'string', null, 4, 1], ['serial', 'string', null, 12, 1], ['device_id', 'string', null, 12, 1], ['account_number', 'string', null, 10, 1], ['handle', 'string', null, 12, 1],
  ['username', 'string', null, 10, 1], ['hostname', 'string', null, 16, 1], ['isbn', 'string', null, 13, 1], ['code', 'string', null, 6, 0.95], ['reference_number', 'string', null, 12, 1],
]);
add('reference', [
  ['conversation_id', 'string', 'uuid', 36, 0.1], ['parent_id', 'string', 'uuid', 36, 0.4], ['user_id', 'string', 'uuid', 36, 0.2], ['authorId', 'string', 'token_id', 20, 0.3], ['thread_id', 'string', 'uuid', 36, 0.1],
  ['project_id', 'integer', null, null, 0.1], ['ownerId', 'string', 'uuid', 36, 0.2], ['list_id', 'string', 'hex_id', 24, 0.1], ['channelId', 'string', 'token_id', 18, 0.1], ['order_id', 'integer', null, null, 0.3],
  ['customer', 'string', 'token_id', 18, 0.3], ['ref', 'string', null, 12, 0.3], ['account', 'string', null, 10, 0.3], ['team_id', 'integer', null, null, 0.1], ['product_id', 'string', null, 10, 0.3],
  ['in_reply_to', 'string', 'uuid', 36, 0.5], ['assignee_id', 'integer', null, null, 0.2], ['folder', 'string', 'hex_id', 24, 0.1], ['organization_id', 'string', 'uuid', 36, 0.05], ['source_id', 'string', null, 12, 0.3],
]);
add('timestamp', [
  ['created_at', 'string', 'iso_time', 20, 0.9], ['updatedAt', 'string', 'iso_time', 24, 0.9], ['timestamp', 'integer', 'epoch_ms', null, 0.95], ['create_time', 'number', 'epoch_s', null, 0.95], ['date', 'string', 'iso_time', 10, 0.6],
  ['published', 'string', 'iso_time', 20, 0.9], ['ts', 'integer', 'epoch_s', null, 0.9], ['time', 'string', 'iso_time', 19, 0.9], ['modified', 'string', 'iso_time', 20, 0.9], ['expires', 'string', 'iso_time', 20, 0.5],
  ['dueAt', 'string', 'iso_time', 20, 0.8], ['last_seen', 'integer', 'epoch_s', null, 0.9], ['started_at', 'string', 'iso_time', 20, 0.9], ['ended_at', 'string', 'iso_time', 20, 0.9], ['last_activity', 'string', 'iso_time', 20, 0.9],
  ['deadline', 'string', 'iso_time', 10, 0.7], ['at', 'integer', 'epoch_s', null, 0.95], ['sent', 'integer', 'epoch_ms', null, 0.95], ['occurred_at', 'string', 'iso_time', 24, 0.95], ['birthday', 'string', 'iso_time', 10, 0.9],
]);
add('title', [
  ['title', 'string', null, 40, 0.95], ['name', 'string', null, 18, 0.9], ['label', 'string', null, 16, 0.8], ['headline', 'string', null, 60, 0.98], ['subject', 'string', null, 45, 0.95],
  ['displayName', 'string', null, 16, 0.9], ['caption', 'string', null, 50, 0.9], ['heading', 'string', null, 30, 0.95], ['company', 'string', null, 18, 0.95], ['first_name', 'string', null, 7, 0.7],
  ['last_name', 'string', null, 8, 0.8], ['full_name', 'string', null, 16, 0.95], ['product_name', 'string', null, 24, 0.95], ['nickname', 'string', null, 10, 0.9], ['organization', 'string', null, 20, 0.9],
  ['email', 'string', 'email', 22, 1], ['city', 'string', null, 9, 0.5], ['address', 'string', null, 30, 0.95], ['phone', 'string', null, 12, 0.98], ['location', 'string', null, 14, 0.6],
]);
add('text', [
  ['text', 'string', null, 400, 1], ['content', 'string', 'markdown', 900, 1], ['body', 'string', null, 600, 1], ['message', 'string', null, 200, 0.98], ['description', 'string', null, 180, 0.95],
  ['summary', 'string', null, 160, 0.98], ['parts', 'string', null, 500, 1], ['completion', 'string', null, 700, 1], ['snippet', 'string', null, 140, 0.98], ['excerpt', 'string', null, 150, 0.98],
  ['comment', 'string', null, 120, 0.98], ['answer', 'string', 'markdown', 800, 1], ['notes', 'string', null, 150, 0.95], ['bio', 'string', null, 160, 0.98], ['reason', 'string', null, 70, 0.9],
  ['review', 'string', null, 300, 1], ['transcript', 'string', null, 2000, 1], ['details', 'string', null, 200, 0.95], ['prompt', 'string', null, 250, 1], ['code', 'string', 'multiline', 300, 0.95],
]);
add('url', [
  ['url', 'string', 'url', 50, 0.95], ['href', 'string', 'url', 40, 0.9], ['link', 'string', 'url', 45, 0.95], ['image', 'string', 'url', 60, 0.9], ['avatar_url', 'string', 'url', 60, 0.8],
  ['permalink', 'string', 'url', 55, 1], ['src', 'string', 'url', 50, 0.9], ['thumbnail', 'string', 'url', 60, 0.95], ['website', 'string', 'url', 30, 0.95], ['download_url', 'string', 'url', 70, 1],
]);
add('measure', [
  ['price', 'number', null, null, 0.8, { volatile: true }], ['value', 'number', null, null, 0.7, { volatile: true }], ['amount', 'number', null, null, 0.7], ['score', 'number', null, null, 0.6], ['cpu', 'integer', null, null, 0.5, { volatile: true }],
  ['temperature', 'number', null, null, 0.6, { volatile: true }], ['rate', 'number', null, null, 0.6], ['latency_ms', 'integer', null, null, 0.7, { volatile: true }], ['balance', 'number', null, null, 0.8], ['weight', 'number', null, null, 0.6],
  ['percent', 'number', null, null, 0.5], ['change', 'number', null, null, 0.7, { volatile: true }], ['revenue', 'number', null, null, 0.9], ['cost', 'number', null, null, 0.8], ['arr', 'integer', null, null, 0.95],
  ['mrr', 'integer', null, null, 0.9], ['humidity', 'number', null, null, 0.6, { volatile: true }], ['pressure', 'number', null, null, 0.6, { volatile: true }], ['duration_ms', 'integer', null, null, 0.8], ['total_amount', 'number', null, null, 0.9],
  ['voltage', 'number', null, null, 0.6, { volatile: true }], ['speed', 'number', null, null, 0.6, { volatile: true }], ['ratio', 'number', null, null, 0.7], ['budget', 'integer', null, null, 0.8], ['salary', 'integer', null, null, 0.8],
]);
add('category', [
  ['status', 'string', null, 8, 0.05, { enum: true }], ['role', 'string', null, 9, 0.02, { enum: true }], ['type', 'string', null, 8, 0.03, { enum: true }], ['kind', 'string', null, 7, 0.03, { enum: true }], ['state', 'string', null, 8, 0.05, { enum: true }],
  ['category', 'string', null, 10, 0.1, { enum: true }], ['priority', 'string', null, 6, 0.05, { enum: true }], ['stop_reason', 'string', null, 8, 0.05, { enum: true }], ['plan', 'string', null, 5, 0.05, { enum: true }], ['model', 'string', null, 12, 0.05, { enum: true }],
  ['language', 'string', null, 6, 0.1, { enum: true }], ['content_type', 'string', null, 6, 0.02, { enum: true }], ['industry', 'string', null, 8, 0.1, { enum: true }], ['country', 'string', null, 2, 0.1, { enum: true }], ['currency', 'string', null, 3, 0.02, { enum: true }],
  ['unit', 'string', null, 2, 0.02, { enum: true }], ['department', 'string', null, 9, 0.1, { enum: true }], ['tier', 'string', null, 6, 0.05, { enum: true }], ['channel', 'string', null, 7, 0.05, { enum: true }], ['severity', 'string', null, 6, 0.05, { enum: true }],
  ['assignee', 'string', null, 6, 0.2, { enum: true }], ['author', 'string', null, 8, 0.3, { enum: true }], ['platform', 'string', null, 7, 0.05, { enum: true }], ['region', 'string', null, 6, 0.1, { enum: true }], ['job_title', 'string', null, 10, 0.2, { enum: true }],
]);
add('flag', [['done', 'boolean'], ['is_active', 'boolean'], ['completed', 'boolean'], ['read', 'boolean'], ['enabled', 'boolean'], ['archived', 'boolean'], ['hidden', 'boolean'], ['pinned', 'boolean'], ['in_stock', 'boolean'], ['verified', 'boolean']]);
add('count', [
  ['count', 'integer', null, null, 0.4], ['total', 'integer', null, null, 0.4], ['page', 'integer', null, null, 0.3], ['views', 'integer', null, null, 0.7], ['likes', 'integer', null, null, 0.6],
  ['n', 'integer', null, null, 0.4], ['index', 'integer', null, null, 0.6], ['output_tokens', 'integer', null, null, 0.7], ['position', 'integer', null, null, 0.6], ['seq', 'integer', null, null, 0.95],
  ['size', 'integer', null, null, 0.7], ['length', 'integer', null, null, 0.7], ['quantity', 'integer', null, null, 0.3], ['qty', 'integer', null, null, 0.3], ['units', 'integer', null, null, 0.6],
  ['retries', 'integer', null, null, 0.2], ['attempts', 'integer', null, null, 0.2], ['level', 'integer', null, null, 0.2], ['rank', 'integer', null, null, 0.9], ['order', 'integer', null, null, 0.9],
]);
add('metadata', [
  ['version', 'string', null, 3, 0.05, { enum: true }], ['_type', 'string', null, 8, 0.02, { enum: true }], ['object', 'string', null, 10, 0.01, { enum: true }], ['__typename', 'string', null, 10, 0.02, { enum: true }], ['etag', 'string', 'hex_id', 32, 0.9],
  ['cursor', 'string', null, 24, 1], ['nonce', 'string', 'hex_id', 16, 1], ['trace_id', 'string', 'hex_id', 32, 1], ['o', 'string', null, 6, 0.05, { enum: true }], ['p', 'string', 'pointer', 20, 0.3],
  ['op', 'string', null, 6, 0.05, { enum: true }], ['path', 'string', 'pointer', 20, 0.3], ['request_id', 'string', 'hex_id', 32, 1], ['schema', 'string', null, 8, 0.02, { enum: true }], ['checksum', 'string', 'hex_id', 40, 1],
]);

// Additional cross-domain conventions; still soft priors, never hardcoded site semantics.
add('reference', [
  ['tenant_id', 'string', 'uuid', 36, 0.05], ['workspaceId', 'string', 'token_id', 20, 0.1],
  ['reply_to_id', 'string', 'uuid', 36, 0.4], ['belongs_to', 'string', 'token_id', 18, 0.3],
  ['repository_id', 'integer', null, null, 0.1], ['asset_id', 'string', 'uuid', 36, 0.3],
]);
add('timestamp', [
  ['observed_at', 'string', 'iso_time', 24, 0.9], ['deletedAt', 'string', 'iso_time', 24, 0.7],
  ['received_at', 'integer', 'epoch_ms', null, 0.95], ['scheduled_for', 'string', 'iso_time', 24, 0.8],
]);
add('metadata', [
  ['revision', 'integer', null, null, 0.6], ['correlation_id', 'string', 'uuid', 36, 1],
  ['span_id', 'string', 'hex_id', 16, 1], ['next_cursor', 'string', 'token_id', 32, 1],
  ['operation', 'string', null, 10, 0.05, { enum: true }], ['schema_version', 'integer', null, null, 0.01],
]);
add('count', [
  ['total_count', 'integer', null, null, 0.3], ['remaining', 'integer', null, null, 0.4],
  ['offset', 'integer', null, null, 0.7], ['page_size', 'integer', null, null, 0.1],
]);
add('measure', [
  ['confidence', 'number', null, null, 0.8], ['probability', 'number', null, null, 0.8],
  ['progress', 'number', null, null, 0.7, { volatile: true }], ['distance', 'number', null, null, 0.9],
]);

export const PRIOR_FIELDS = P.map(([, ...rest]) => rest);
export const PRIOR_ROLES = P.map(([role]) => role);
