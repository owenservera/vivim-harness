// AION Agent 14 / Z.ai Round 6 hardened drop-in for src/capture/harness-runs.mjs.
// Source baseline: Z.ai export patch 0013/18, 2026-10-24.
// IMPORTANT: This remains a state/identity layer only. All effects are performed by the
// injected EXISTING Studio conversation-tool executor. No additional actor or browser.
// A durable in-flight claim is written BEFORE calling the executor. After uncertain
// completion or a crash, this store FAILS CLOSED: reconcile with the owning journal;
// never retry an unverified effect, and never generate an alternate key to evade it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const HARNESS_RUN_SCHEMA = 'capture-studio.harness-run/1';
export const RUN_STATUSES = Object.freeze(['running', 'succeeded', 'failed', 'interrupted']);
export const STEP_STATUSES = Object.freeze(['in_flight', 'uncertain', 'succeeded', 'failed']);
const DEFAULT_LIMITS = Object.freeze({ maxRuns: 200, maxSteps: 1000, taskChars: 2000, summaryChars: 300, stepKeyChars: 200 });
const now = () => new Date().toISOString();
const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });
const clamp = (value, length) => String(value ?? '').slice(0, length);
const RUN_ID = /^[a-f\d-]{10,64}$/i;
const CONVERSATION_ID = /^[A-Za-z\d][A-Za-z\d_-]{0,127}$/;

// Strict, order-independent serialization of JSON arguments. Do not hash JS insertion order.
function canonicalJson(value) {
  const seen = new Set();
  function walk(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'object' || seen.has(v)) throw fail(400, 'INVALID_STEP_ARGUMENTS');
    seen.add(v);
    const out = Array.isArray(v) ? v.map(walk) : {};
    if (!Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw fail(400, 'INVALID_STEP_ARGUMENTS');
      for (const key of Object.keys(v).sort()) {
        if (key === '__proto__') throw fail(400, 'INVALID_STEP_ARGUMENTS');
        out[key] = walk(v[key]);
      }
    }
    seen.delete(v);
    return out;
  }
  return JSON.stringify(walk(value));
}
export const argsDigestOf = (args) => createHash('sha256').update(canonicalJson(args)).digest('hex');

// The summary is bounded and intentionally never stores reply/prompt bodies.
export function summarizeResult(result) {
  if (result === undefined) return null;
  if (result === null) return 'null';
  if (Array.isArray(result)) return { kind: 'array', length: result.length };
  if (typeof result === 'object') {
    const conversation = result.conversation ?? result.resource ?? null;
    const c = conversation && typeof conversation === 'object' ? conversation : result;
    return { kind: 'object',
      ...(typeof c.id === 'string' ? { id: clamp(c.id, 128) } : {}),
      ...(typeof c.state === 'string' ? { state: clamp(c.state, 80) } : {}),
      ...(c.revision !== undefined ? { revision: c.revision } : {}),
      ...(typeof c.verdict === 'string' ? { verdict: clamp(c.verdict, 80) } : {}),
      ...(c.reply && typeof c.reply === 'object' ? { replyState: c.reply.state ?? null, replyChars: c.reply.chars ?? null } : {}),
      replyTextPresent: Object.values(result).some((v) => v && typeof v === 'object' && typeof v.text === 'string' && v.text.length > 0),
    };
  }
  return { kind: typeof result };
}

const validRun = (r) => !!r && r.schema === HARNESS_RUN_SCHEMA && typeof r.id === 'string'
  && RUN_STATUSES.includes(r.status) && typeof r.task?.description === 'string'
  && Array.isArray(r.steps) && Number.isFinite(Date.parse(r.createdAt)) && Number.isFinite(Date.parse(r.updatedAt));
const validStep = (s) => !!s && typeof s.key === 'string' && !!s.key && typeof s.tool === 'string'
  && /^[a-f\d]{64}$/.test(s.argsDigest ?? '') && STEP_STATUSES.includes(s.status)
  && Number.isFinite(Date.parse(s.at));

export function createHarnessRunStore({ dir, io = fs, toolExecutor, limits = {}, retryableTools = [] } = {}) {
  if (!dir) throw fail(500, 'RUN_DIR_REQUIRED');
  if (typeof toolExecutor !== 'function') throw fail(500, 'TOOL_EXECUTOR_REQUIRED');
  const L = { ...DEFAULT_LIMITS, ...limits };
  const safeRetry = new Set(retryableTools); // Explicit, verified READ-ONLY tools only.
  io.mkdirSync(dir, { recursive: true });
  const file = (id) => path.join(dir, `${id}.run.json`);
  const lockFile = (id) => `${file(id)}.lock`;
  const ids = () => io.readdirSync(dir).filter((n) => n.endsWith('.run.json')).map((n) => n.slice(0, -'.run.json'.length));
  const readRun = (id) => {
    if (!RUN_ID.test(id ?? '')) throw fail(400, 'INVALID_RUN_ID');
    let raw;
    try { raw = io.readFileSync(file(id), 'utf8'); }
    catch (e) { throw fail(e.code === 'ENOENT' ? 404 : 409, e.code === 'ENOENT' ? 'RUN_NOT_FOUND' : 'CORRUPT_OR_UNREADABLE_RUN'); }
    let run;
    try { run = JSON.parse(raw); } catch { throw fail(409, 'CORRUPT_OR_UNREADABLE_RUN'); }
    if (!validRun(run) || !run.steps.every(validStep)) throw fail(409, 'CORRUPT_OR_UNREADABLE_RUN');
    return run;
  };
  function persist(run) {
    run.updatedAt = now();
    const tmp = `${file(run.id)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
      fd = io.openSync(tmp, 'wx', 0o600);
      io.writeSync(fd, `${JSON.stringify(run, null, 2)}\n`);
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
      io.renameSync(tmp, file(run.id));
      return run;
    } catch (e) {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      try { io.unlinkSync(tmp); } catch {}
      throw fail(409, 'RUN_PERSIST_FAILED');
    }
  }
  // Small exclusive lock over synchronous state transitions, not a browser/executor lease.
  // Crash may leave .lock; NEVER delete or steal one automatically: an owner must first
  // verify its process is dead and reconcile its run's in_flight/uncertain steps.
  function mutate(id, operation) {
    if (!RUN_ID.test(id ?? '')) throw fail(400, 'INVALID_RUN_ID');
    let fd;
    try { fd = io.openSync(lockFile(id), 'wx', 0o600); }
    catch (e) { throw fail(409, e.code === 'EEXIST' ? 'RUN_BUSY' : 'RUN_LOCK_FAILED'); }
    try {
      io.writeSync(fd, `${JSON.stringify({ pid: process.pid, at: now() })}\n`);
      io.fsyncSync(fd);
      return operation(readRun(id));
    } finally {
      try { io.closeSync(fd); } catch {}
      try { io.unlinkSync(lockFile(id)); } catch {}
    }
  }
  const summary = (run) => ({ id: run.id, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
    taskDescription: run.task.description, conversationId: run.conversationId, steps: run.steps.length,
    lastStep: run.steps.at(-1) ? { key: run.steps.at(-1).key, tool: run.steps.at(-1).tool, status: run.steps.at(-1).status, at: run.steps.at(-1).at } : null });
  const sameIntent = (s, tool, argsDigest) => s.tool === tool && s.argsDigest === argsDigest;

  return {
    create({ task, conversationId = null } = {}) {
      const description = typeof task === 'string' ? task : task?.description;
      if (typeof description !== 'string' || !description.trim() || description.length > L.taskChars) throw fail(400, 'INVALID_TASK');
      if (conversationId !== null && (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId))) throw fail(400, 'INVALID_CONVERSATION_ID');
      if (ids().length >= L.maxRuns) throw fail(409, 'RUN_STORE_FULL');
      const run = { schema: HARNESS_RUN_SCHEMA, id: randomUUID(), createdAt: now(), updatedAt: now(),
        status: 'running', task: { description }, conversationId, steps: [], context: {} };
      return persist(run);
    },
    get: readRun,
    list: () => ids().map((id) => { try { return summary(readRun(id)); }
      catch { return { id, status: 'corrupt', createdAt: null, updatedAt: null, taskDescription: null, conversationId: null, steps: 0, lastStep: null }; } })
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))),
    async step(id, { key, tool, args = {} } = {}) {
      if (typeof key !== 'string' || !key.trim() || key.length > L.stepKeyChars) throw fail(400, 'INVALID_STEP_KEY');
      if (typeof tool !== 'string' || !tool) throw fail(400, 'INVALID_TOOL');
      const argsDigest = argsDigestOf(args);
      const claimed = mutate(id, (run) => {
        if (run.status !== 'running') throw fail(409, 'RUN_FINISHED');
        const matches = run.steps.filter((s) => s.key === key);
        if (matches.some((s) => !sameIntent(s, tool, argsDigest))) throw fail(409, 'IDEMPOTENCY_CONFLICT');
        const latest = matches.at(-1);
        if (latest?.status === 'succeeded') return { replayed: true, run, step: latest };
        if (latest && ['in_flight', 'uncertain'].includes(latest.status))
          throw Object.assign(fail(409, 'STEP_UNCERTAIN'), { step: latest });
        if (latest?.status === 'failed' && !safeRetry.has(tool))
          throw Object.assign(fail(409, 'STEP_RECONCILIATION_REQUIRED'), { step: latest });
        if (run.steps.length >= L.maxSteps) throw fail(409, 'RUN_STEP_LIMIT');
        const step = { key, tool, argsDigest, status: 'in_flight', at: now(), summary: null,
          attempt: (latest?.attempt ?? matches.length) + 1 };
        run.steps.push(step);
        persist(run); // MUST succeed before invoking the existing effect owner.
        return { replayed: false, run, step };
      });
      if (claimed.replayed) return { ...claimed, run: structuredClone(claimed.run),
        step: structuredClone(claimed.step), result: undefined,
        note: 'recorded success returned; original effect not repeated' };
      let result;
      try {
        result = await toolExecutor({ tool, args, run: structuredClone(claimed.run) });
      } catch (e) {
        // A thrown error is NOT evidence that an effect did not occur. Only an explicit
        // not_dispatched receipt from the existing effect owner can mark a safe failure.
        const notDispatched = e?.effectState === 'not_dispatched';
        const step = mutate(id, (run) => {
          const current = run.steps.find((s) => s.key === key && s.at === claimed.step.at && s.status === 'in_flight');
          if (!current) throw fail(409, 'STEP_RECONCILIATION_REQUIRED');
          current.status = notDispatched ? 'failed' : 'uncertain';
          current.endedAt = now();
          // Do not store uncontrolled error messages or private response bodies.
          current.summary = { errorCode: /^[A-Z][A-Z0-9_]{0,80}$/.test(e?.code ?? '') ? e.code : 'EXECUTOR_ERROR',
            effectState: notDispatched ? 'not_dispatched' : 'unknown' };
          persist(run);
          return structuredClone(current);
        });
        throw Object.assign(fail(e?.status ?? 409, e?.code ?? (notDispatched ? 'STEP_FAILED' : 'STEP_UNCERTAIN')),
          { step, cause: e });
      }
      // Fresh re-read under lock preserves notes/context written while executor was awaited.
      return mutate(id, (run) => {
        const current = run.steps.find((s) => s.key === key && s.at === claimed.step.at && s.status === 'in_flight');
        if (!current) throw fail(409, 'STEP_RECONCILIATION_REQUIRED');
        current.status = 'succeeded';
        current.endedAt = now();
        current.summary = summarizeResult(result);
        persist(run);
        return { run: structuredClone(run), step: structuredClone(current), replayed: false, result };
      });
    },
    finish(id, { status } = {}) {
      if (!RUN_STATUSES.includes(status) || status === 'running') throw fail(400, 'INVALID_RUN_STATUS');
      return mutate(id, (run) => {
        if (run.status !== 'running') throw fail(409, 'RUN_FINISHED');
        if (run.steps.some((s) => s.status === 'in_flight' || s.status === 'uncertain'))
          throw fail(409, 'RUN_HAS_UNRESOLVED_EFFECT');
        run.status = status;
        return persist(run);
      });
    },
    // Operator/local integrator must verify the previous process has exited before clearing
    // a crash-left lock. Clearing the LOCK does not clear/retry any reserved effect.
    recoverAbandonedLock(id, { expectedPid } = {}) {
      if (!RUN_ID.test(id ?? '')) throw fail(400, 'INVALID_RUN_ID');
      const location = lockFile(id);
      let raw, owner;
      try { raw = io.readFileSync(location, 'utf8'); owner = JSON.parse(raw); }
      catch { throw fail(409, 'LOCK_UNREADABLE_OR_MISSING'); }
      if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 || owner?.pid !== expectedPid)
        throw fail(409, 'LOCK_OWNER_MISMATCH');
      try { process.kill(owner.pid, 0); }
      catch (e) {
        if (e?.code !== 'ESRCH') throw fail(409, 'LOCK_OWNER_UNVERIFIED');
        if (io.readFileSync(location, 'utf8') !== raw) throw fail(409, 'LOCK_CHANGED');
        io.unlinkSync(location);
        return { released: true, run: readRun(id) }; // in_flight remains blocked.
      }
      throw fail(409, 'LOCK_OWNER_STILL_ALIVE');
    },
    note(id, { context } = {}) {
      if (context === null || typeof context !== 'object' || Array.isArray(context)) throw fail(400, 'INVALID_CONTEXT');
      const encoded = JSON.stringify(context);
      if (encoded === undefined) throw fail(400, 'INVALID_CONTEXT');
      if (encoded.length > 16000) throw fail(400, 'CONTEXT_TOO_LARGE');
      return mutate(id, (run) => {
        if (run.status !== 'running') throw fail(409, 'RUN_FINISHED');
        run.context = { ...run.context, ...context };
        return persist(run);
      });
    },
  };
}