// Durable, local-only Work model. Never dispatches a tool or claims a live provider PASS.
import { createHash } from 'node:crypto';

export const WORK_STATES = Object.freeze(['queued', 'active', 'blocked', 'completed', 'cancelled']);
const WORK_TRANSITIONS = Object.freeze({
  queued: ['active', 'blocked', 'cancelled'],
  active: ['blocked', 'completed', 'cancelled'],
  blocked: ['active', 'cancelled'],
  completed: [],
  cancelled: [],
});
export const MAX_WORK_ITEMS = 200;
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const workId = key => 'work-' + createHash('sha256').update(key).digest('hex').slice(0, 32);
const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw err('PERSONAL_AGENT_WORK_INVALID', `${name} must be 1..${max} characters`);
  return value.trim();
};
const existing = state => {
  const work = state.work ?? [];
  if (!Array.isArray(work) || work.length > MAX_WORK_ITEMS) throw err('PERSONAL_AGENT_WORK_CORRUPT', 'Stored Work index is invalid', 500);
  return work;
};

export function workSummary(state) {
  const work = existing(state);
  return {
    total: work.length,
    byStatus: Object.fromEntries(WORK_STATES.map(status => [status, work.filter(item => item.status === status).length])),
    authority: 'local-user-directed-work; not provider execution',
  };
}

export function createWork(state, { title, objective, idempotencyKey, now }) {
  const name = text(title, 'title', 160), goal = text(objective, 'objective', 4000);
  if (typeof idempotencyKey !== 'string' || !keyPattern.test(idempotencyKey)) throw err('PERSONAL_AGENT_WORK_INVALID', 'idempotencyKey must be 8..128 safe characters');
  const id = workId(idempotencyKey);
  const work = existing(state);
  const previous = work.find(x => x.id === id);
  if (previous) {
    if (previous.title !== name || previous.objective !== goal) throw err('PERSONAL_AGENT_WORK_IDEMPOTENCY_CONFLICT', 'Same key has different Work inputs', 409);
    return { state, item: previous, changed: false };
  }
  if (work.length >= MAX_WORK_ITEMS) throw err('PERSONAL_AGENT_WORK_LIMIT', 'Work index reached capacity', 409);
  const item = {
    id, title: name, objective: goal, status: 'queued', nextAction: null,
    createdAt: now, updatedAt: now, source: 'user-authored',
    evidence: [], events: [{ type: 'created', at: now, basis: 'explicit-user-request' }],
  };
  return { state: { ...state, updatedAt: now, work: [...work, item] }, item, changed: true };
}

// The user's next step is a LOCAL planning field, not permission to execute it.
// CAS is owned by PersonalAgentService, so this pure reducer only validates the state.
export function setWorkNextAction(state, { id, nextAction, now }) {
  if (typeof id !== 'string' || !/^work-[a-f0-9]{32}$/.test(id)) {
    throw err('PERSONAL_AGENT_WORK_INVALID', 'Invalid Work ID');
  }
  const work = existing(state);
  const old = work.find(item => item.id === id);
  if (!old) throw err('PERSONAL_AGENT_WORK_NOT_FOUND', 'Work item not found', 404);
  if (old.status === 'completed' || old.status === 'cancelled') {
    throw err('PERSONAL_AGENT_WORK_TRANSITION', 'Closed Work cannot be edited', 409);
  }
  if (nextAction !== null && (typeof nextAction !== 'string' || nextAction.trim().length === 0 ||
      nextAction.trim().length > 1000)) {
    throw err('PERSONAL_AGENT_WORK_INVALID', 'nextAction must be null or 1..1000 characters');
  }
  const action = nextAction === null ? null : nextAction.trim();
  if (old.status === 'blocked' && action === null) {
    throw err('PERSONAL_AGENT_WORK_INVALID', 'Blocked Work needs a next action or reason');
  }
  if ((old.nextAction ?? null) === action) return { state, item: old, changed: false };
  if (!Array.isArray(old.events) || old.events.length >= 100) {
    throw err('PERSONAL_AGENT_WORK_LIMIT', 'Work event history reached capacity', 409);
  }
  const event = { type: 'next-action', at: now, nextAction: action, basis: 'user-authored-local-plan' };
  const item = { ...old, nextAction: action, updatedAt: now, events: [...old.events, event] };
  return { state: { ...state, updatedAt: now, work: work.map(row => row.id === id ? item : row) },
    item, changed: true };
}

export function transitionWork(state, { id, to, note, evidence = [], idempotencyKey, now }) {
  if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) throw err('PERSONAL_AGENT_WORK_INVALID', 'Note must be at most 2000 characters');
  if (!Array.isArray(evidence) || evidence.length > 20 || evidence.some(ref => typeof ref !== 'string' || !/^[-a-zA-Z0-9_./:#?=]{4,256}$/.test(ref))) {
    throw err('PERSONAL_AGENT_WORK_INVALID', 'Evidence must contain at most 20 bounded reference tokens');
  }
  if (typeof id !== 'string' || !/^work-[a-f0-9]{32}$/.test(id)) throw err('PERSONAL_AGENT_WORK_INVALID', 'Invalid Work ID');
  if (!WORK_STATES.includes(to)) throw err('PERSONAL_AGENT_WORK_INVALID', 'Invalid Work status');
  const work = existing(state);
  const old = work.find(item => item.id === id);
  if (!old) throw err('PERSONAL_AGENT_WORK_NOT_FOUND', 'Work item not found', 404);
  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== 'string' || !keyPattern.test(idempotencyKey)) throw err('PERSONAL_AGENT_WORK_INVALID', 'Invalid update key');
    const previous = old.events.find(event => event.idempotencyKey === idempotencyKey);
    if (previous) {
      if (previous.to !== to || previous.note !== (note?.trim() || null) ||
          JSON.stringify(previous.evidence.map(item => item.ref)) !== JSON.stringify(evidence)) {
        throw err('PERSONAL_AGENT_WORK_IDEMPOTENCY_CONFLICT', 'This update key was already used for different changes', 409);
      }
      return { state, item: old, changed: false };
    }
  }
  if (!WORK_TRANSITIONS[old.status]?.includes(to)) throw err('PERSONAL_AGENT_WORK_TRANSITION', 'Work transition not permitted', 409);
  if (to === 'completed' && evidence.length === 0) throw err('PERSONAL_AGENT_WORK_EVIDENCE_REQUIRED', 'Completion requires explicit evidence references');
  if (to === 'blocked' && (typeof note !== 'string' || !note.trim())) throw err('PERSONAL_AGENT_WORK_INVALID', 'Blocked Work requires a reason');
  const event = {
    type: 'transition', from: old.status, to, at: now,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    note: note?.trim() || null,
    evidence: evidence.map(ref => ({ ref, basis: 'user-attested; unverified-for-live-execution' })),
  };
  const item = { ...old, status: to, updatedAt: now,
    // Waiting is a status, not a replacement for the user's saved plan. Keep the
    // reason in history; only use it as the next step when no plan exists yet.
    // Reasons allow 2000 characters, but the editable next-action field allows 1000.
    nextAction: to === 'blocked' ? (old.nextAction ?? event.note.slice(0, 1000))
      : to === 'active' ? (old.nextAction ?? null) : null,
    evidence: [...old.evidence, ...event.evidence], events: [...old.events, event] };
  if (item.events.length > 100) throw err('PERSONAL_AGENT_WORK_LIMIT', 'Work event history reached capacity', 409);
  return { state: { ...state, updatedAt: now, work: work.map(row => row.id === id ? item : row) }, item, changed: true };
}
