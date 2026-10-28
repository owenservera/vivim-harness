// Self-knowledge projections: bounded, source-qualified claims, no generative guesswork.
export const SELF_KNOWLEDGE_TOPICS = Object.freeze(['identity', 'bootstrap', 'memory', 'work', 'world', 'capabilities', 'privacy']);
const fault = () => Object.assign(new Error('Unknown Personal Agent self-knowledge topic'), { status: 400, code: 'PERSONAL_AGENT_TOPIC_INVALID' });

function claim(topic, value, { basis, evidence, at, authority = 'local-instance-state', qualification, nextAction = null, sourceUpdatedAt = at }) {
  return {
    topic, value, basis, evidence,
    observedAt: at, sourceUpdatedAt, freshness: 'snapshot-at-request-time',
    authority, qualification, nextAction,
    trust: 'bounded-local-observation; not provider confirmation',
  };
}

/** Inputs are already projected safe fields; no private memory text or Work titles are accepted. */
export function buildSelfKnowledge({ topic = 'all', agent, world, skills, at }) {
  if (topic !== 'all' && !SELF_KNOWLEDGE_TOPICS.includes(topic)) throw fault();
  if (!agent || !world || typeof at !== 'string') throw new TypeError('Grounded local inputs required');
  const topics = topic === 'all' ? SELF_KNOWLEDGE_TOPICS : [topic];
  const answers = {};
  for (const name of topics) {
    if (name === 'identity') answers[name] = claim(name, {
      role: 'personal-agent', id: agent.agentId, initialized: agent.initialized,
      scope: 'local-data-directory', scopeFingerprint: agent.scopeFingerprint ?? null,
      principalAssurance: 'local-data-directory-only', providerAccountVerified: false,
    }, { at, basis: 'local-versioned-personal-agent-state', evidence: agent.initialized ? [`local:personal-agent/primary/v${agent.version}`] : [],
      sourceUpdatedAt: agent.updatedAt ?? null,
      qualification: 'Local agent ID is not a verified human or remote-provider account identity, and the scope fingerprint identifies this data directory only, not a device or cross-device principal.' });
    if (name === 'bootstrap') answers[name] = claim(name, {
      nextStage: agent.nextStage, stages: agent.stages
        ? Object.fromEntries(Object.entries(agent.stages).map(([key, value]) => [key, value.status]))
        : null,
    }, { at, basis: 'bootstrap-stage-state-and-receipts',
      evidence: agent.initialized ? [`local:personal-agent/primary/v${agent.version}`] : [],
      sourceUpdatedAt: agent.updatedAt ?? null,
      qualification: 'Stages describe local bootstrap observations; they do not establish model access, remote login, or live execution.',
      nextAction: agent.nextStage ? 'Review or resume local bootstrap' : null });
    if (name === 'memory') answers[name] = claim(name, { initialized: agent.initialized, tiers: agent.memoryCounts ?? null },
      { at, basis: 'local-memory-entry-counts-only',
        evidence: agent.initialized ? [`local:personal-agent/primary/v${agent.version}`] : [],
        sourceUpdatedAt: agent.updatedAt ?? null,
        qualification: 'Memory content is private, not included in this self-knowledge projection.' });
    // An uninitialized agent has no Work index; reporting a grounded-looking zero would invent local reality.
    if (name === 'work') answers[name] = claim(name, agent.work
      ? { initialized: true, ...agent.work }
      : { initialized: false, total: null, byStatus: null },
    { at, basis: 'user-directed-local-work-index',
      evidence: agent.initialized ? [`local:personal-agent/primary/v${agent.version}`] : [],
      sourceUpdatedAt: agent.updatedAt ?? null,
      qualification: 'Queued or completed Work records are user-directed; they do not independently prove tool/provider execution.' });
    if (name === 'world') answers[name] = claim(name, world,
      { at, basis: 'existing-local-world-versioned-store-index', evidence: world.evidence ?? [],
        qualification: 'Counts only; not whole-provider archive or remote account coverage.' });
    if (name === 'capabilities') answers[name] = claim(name, skills ?? { available: false, reason: 'not-inspected' },
      { at, basis: 'inert-agentic-file-inventory-and-Studio-tool-registration', evidence: skills?.evidence ?? [],
        qualification: 'Skill source presence and tool registration do not prove installation, permissions, or real execution.' });
    if (name === 'privacy') answers[name] = claim(name, {
      storage: 'configured-local-data-directory',
      providerSendsDuringBootstrap: false,
      memoryVersionHistory: 'retained; removal from CURRENT is not secure erasure',
      networkRequests: 'not-performed-by-self-knowledge',
    }, { at, basis: 'personal-agent-source-contract',
      evidence: ['source:src/agents/personal-agent-service.mjs'],
      qualification: 'Local-first is not encryption certification, guaranteed offline operation or secure-erasure proof.' });
  }
  return { schema: 'vivim.personal-agent.self-knowledge/1', topic, answers,
    disclosure: 'All assertions are qualified source-grounded local projections, never model-generated permissions.' };
}
