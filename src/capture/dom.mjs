// L3 rendered-DOM observation + user-action timeline, via an isolated-world page agent.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { capturePrivacy } from './privacy.mjs';

const AGENT_SRC = readFileSync(new URL('./page-agent.js', import.meta.url), 'utf8').trim().replace(/;\s*$/, '');

export class DomObserver {
  constructor({ append, profile }) {
    this.append = append;
    this.profile = profile;
    this.privacy = capturePrivacy(profile);
    this.worldName = `aion_capture_${randomBytes(4).toString('hex')}`;
    this.binding = `__aionBind_${randomBytes(4).toString('hex')}`;
    this.contexts = new Map(); // frameId -> contextId (our isolated world)
    this.mainFrameId = null;
    this.stats = { batches: 0, mutations: 0, actions: 0, agentStarts: 0 };
  }

  _script() {
    const cfg = { flushMs: this.profile.dom?.flushMs, maxBlockTextBytes: this.profile.dom?.maxBlockTextBytes, ignoreTags: this.profile.dom?.ignoreTags };
    return `${AGENT_SRC}(${JSON.stringify(this.binding)}, ${JSON.stringify(cfg)})`;
  }

  async attach(session) {
    this.session = session;
    session.on('Runtime.executionContextCreated', ({ context }) => {
      if (context.name === this.worldName && context.auxData?.frameId) this.contexts.set(context.auxData.frameId, context.id);
    });
    session.on('Runtime.executionContextsCleared', () => this.contexts.clear());
    // A destroyed context must leave the map: a stale id evaluates into nothing and silently
    // yields undefined (measured on reload with Chrome 143), which reads as "no agent".
    session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
      for (const [frameId, ctxId] of this.contexts) if (ctxId === executionContextId) this.contexts.delete(frameId);
    });
    // Re-arm the agent after every main-frame navigation. The new-document script hook
    // (Page.addScriptToEvaluateOnNewDocument) did not re-run the agent in its named world on
    // reload (measured, Chrome 143), so an explicit restart after navigation is the reliable path.
    session.on('Page.frameNavigated', ({ frame }) => {
      if (!frame.parentId && frame.id && !frame.url?.startsWith('about:') && this.session) {
        this.rearmTimer ??= setTimeout(() => {
          this.rearmTimer = null;
          if (this.session && !this.session.detached && this.mainFrameId) {
            this.startInFrame(this.mainFrameId).catch(() => { /* page gone or not ready; _evalInMain retries */ });
          }
        }, 250);
      }
    });
    session.on('Runtime.bindingCalled', (p) => { if (p.name === this.binding) this._onMessage(p.payload); });
    await session.send('Runtime.enable');
    await session.send('Runtime.addBinding', { name: this.binding, executionContextName: this.worldName });
    await session.send('Page.enable'); // frameNavigated drives the post-navigation agent re-arm
    // Future documents: the agent starts in our isolated world on every navigation.
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: this._script(), worldName: this.worldName, runImmediately: false });
    const { frameTree } = await session.send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
    await this.startInFrame(this.mainFrameId);
  }

  async startInFrame(frameId) {
    const { executionContextId } = await this.session.send('Page.createIsolatedWorld', { frameId, worldName: this.worldName, grantUniveralAccess: false });
    this.contexts.set(frameId, executionContextId);
    const r = await this.session.send('Runtime.evaluate', { expression: this._script(), contextId: executionContextId, returnByValue: true });
    return r.result?.value;
  }

  _onMessage(payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    if (msg.type === 'dom.batch') {
      this.stats.batches++; this.stats.mutations += msg.items.length;
      for (const it of msg.items) if (it.text) { const s = this.privacy.text(it.text); it.text = s.text; if (s.redactions.length) it.redactions = s.redactions.length; }
      this.append({ k: 'dom.batch', url: this.privacy.url(msg.url), items: msg.items });
    } else if (msg.type === 'action') {
      this.stats.actions++;
      this.append({ k: 'action', kind: msg.kind, url: this.privacy.url(msg.url), target: msg.target, length: msg.length, top: msg.top, height: msg.height, open: msg.open, state: msg.state, shift: msg.shift });
    } else if (msg.type === 'agent.ready') {
      this.stats.agentStarts++;
      this.append({ k: 'lifecycle', event: 'dom_agent_ready', url: this.privacy.url(msg.url) });
    }
  }

  async _evalInMain(expression, returnByValue = true) {
    let ctx = this.contexts.get(this.mainFrameId);
    if (!ctx) { await this.startInFrame(this.mainFrameId); ctx = this.contexts.get(this.mainFrameId); }
    let r;
    try {
      r = await this.session.send('Runtime.evaluate', { expression, contextId: ctx, returnByValue, awaitPromise: true });
    } catch (e) {
      // The cached context can die under us (navigation). Recreate the world once and retry.
      if (this.contexts.get(this.mainFrameId) === ctx) this.contexts.delete(this.mainFrameId);
      await this.startInFrame(this.mainFrameId);
      ctx = this.contexts.get(this.mainFrameId);
      r = await this.session.send('Runtime.evaluate', { expression, contextId: ctx, returnByValue, awaitPromise: true });
    }
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result;
  }

  async inspect() {
    const r = (await this._evalInMain('globalThis.__aionCapture && globalThis.__aionCapture.inspect()')).value;
    if (r) r.a11y = await this.accessibility().catch((e) => ({ error: String(e.message ?? e) }));
    return r;
  }

  async turns() {
    const t = (await this._evalInMain('globalThis.__aionCapture && globalThis.__aionCapture.turns()')).value ?? [];
    for (const x of t) { const s = this.privacy.text(x.text ?? ''); x.text = s.text; if (s.redactions.length) x.redactions = s.redactions.length; scrubBlocks(x.blocks, this.privacy); }
    return t;
  }

  async blocksOf(nodeId) { const b = (await this._evalInMain(`globalThis.__aionCapture && globalThis.__aionCapture.blocks(${Number(nodeId)})`)).value ?? []; scrubBlocks(b, this.privacy); return b; }

  // Read-only summary of the browser's accessibility tree: semantics independent of markup.
  async accessibility() {
    const { nodes } = await this.session.send('Accessibility.getFullAXTree', { depth: 60 });
    const roles = {}; const landmarks = []; const live = [];
    for (const n of nodes) {
      if (n.ignored) continue;
      const role = n.role?.value; if (!role) continue;
      roles[role] = (roles[role] ?? 0) + 1;
      if (['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'form', 'region'].includes(role)) landmarks.push({ role, name: n.name?.value?.slice(0, 60) });
      const lv = n.properties?.find((p) => p.name === 'live'); if (lv && lv.value?.value !== 'off') live.push({ role, name: n.name?.value?.slice(0, 60), live: lv.value?.value });
    }
    return { nodes: nodes.length, roles, landmarks: landmarks.slice(0, 30), liveRegions: live.slice(0, 20) };
  }

  async snapshot() {
    const v = (await this._evalInMain('globalThis.__aionCapture && globalThis.__aionCapture.snapshot()')).value;
    if (v?.html) { const s = this.privacy.text(v.html); v.html = s.text; v.redactions = s.redactions.length; }
    return v;
  }

  // Visual highlight via the DevTools overlay (draws above the page; does not modify its DOM).
  async highlight(nodeId) {
    const r = await this._evalInMain(`globalThis.__aionCapture && globalThis.__aionCapture.node(${Number(nodeId)})`, false);
    if (!r.objectId) return false;
    try { await this.session.send('DOM.enable'); await this.session.send('Overlay.enable'); } catch { /* already */ }
    await this.session.send('Overlay.highlightNode', { objectId: r.objectId, highlightConfig: { showInfo: true, contentColor: { r: 64, g: 140, b: 255, a: 0.25 }, borderColor: { r: 64, g: 140, b: 255, a: 0.9 } } });
    await this.session.send('Runtime.releaseObject', { objectId: r.objectId }).catch(() => {});
    return true;
  }

  async clearHighlight() { try { await this.session.send('Overlay.hideHighlight'); } catch { /* ignore */ } }
}

function scrubBlocks(blocks, privacy) {
  for (const b of blocks ?? []) {
    if (typeof b.text === 'string') b.text = privacy.text(b.text).text;
    for (const i of b.inline ?? []) if (typeof i.text === 'string') i.text = privacy.text(i.text).text;
    if (b.rows) b.rows = b.rows.map((r) => r.map((c) => privacy.text(c).text));
    scrubBlocks(b.blocks, privacy);
    for (const it of b.items ?? []) scrubBlocks(it.blocks, privacy);
  }
}
