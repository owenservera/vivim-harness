// Personal Agent bootstrap state contracts. Pure and dependency-free by design.
// This module does not operate a browser, invoke providers, or create background work.
export const BOOTSTRAP_STAGES = Object.freeze([
  "identity-and-sitrep",
  "shared-intelligence",
  "personal-memory",
  "skills-and-capabilities",
]);
export const MEMORY_TIERS = Object.freeze(["CANON", "Immediate", "Curated"]);
const STATES = new Set(["pending", "completed", "blocked"]);
const STAGE_SET = new Set(BOOTSTRAP_STAGES);

export function createPersonalAgentBootstrap({ agentId, ownerId, now = new Date().toISOString() }) {
  if (typeof agentId !== "string" || !agentId.trim()) throw new TypeError("agentId required");
  if (typeof ownerId !== "string" || !ownerId.trim()) throw new TypeError("ownerId required");
  return {
    schemaVersion: 1,
    agentId,
    ownerId,
    createdAt: now,
    updatedAt: now,
    stages: Object.fromEntries(BOOTSTRAP_STAGES.map(stage => [stage, {
      status: "pending", updatedAt: now, evidence: [], blocker: null,
    }])),
  };
}

export function validatePersonalAgentBootstrap(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 ||
      typeof snapshot.agentId !== "string" || !snapshot.agentId ||
      typeof snapshot.ownerId !== "string" || !snapshot.ownerId ||
      !snapshot.stages || typeof snapshot.stages !== "object") {
    throw new TypeError("Invalid Personal Agent bootstrap snapshot");
  }
  for (const stage of BOOTSTRAP_STAGES) {
    const entry = snapshot.stages[stage];
    if (!entry || !STATES.has(entry.status) || !Array.isArray(entry.evidence) ||
        entry.evidence.some(ref => typeof ref !== "string" || !ref.trim())) {
      throw new TypeError(`Invalid bootstrap stage: ${stage}`);
    }
    if (entry.status === "completed" && entry.evidence.length === 0) {
      throw new TypeError(`Completed stage requires evidence: ${stage}`);
    }
  }
  return snapshot;
}

export function nextPersonalAgentBootstrapStage(snapshot) {
  validatePersonalAgentBootstrap(snapshot);
  return BOOTSTRAP_STAGES.find(stage => snapshot.stages[stage].status !== "completed") ?? null;
}

export function updatePersonalAgentBootstrap(snapshot, { stage, status, evidence = [], blocker = null, now = new Date().toISOString() }) {
  validatePersonalAgentBootstrap(snapshot);
  if (!STAGE_SET.has(stage)) throw new TypeError("Unknown bootstrap stage");
  if (!STATES.has(status)) throw new TypeError("Unknown bootstrap status");
  if (!Array.isArray(evidence) || evidence.some(ref => typeof ref !== "string" || !ref.trim())) {
    throw new TypeError("Evidence must be nonempty reference strings");
  }
  if (status === "completed" && evidence.length === 0) throw new TypeError("Completion requires evidence");
  if (status === "blocked" && (typeof blocker !== "string" || !blocker.trim())) {
    throw new TypeError("Blocked stage requires an explicit blocker");
  }
  const firstIncomplete = nextPersonalAgentBootstrapStage(snapshot);
  if (status === "completed" && stage !== firstIncomplete && snapshot.stages[stage].status !== "completed") {
    throw new Error("Bootstrap stages must complete in order");
  }
  return {
    ...snapshot,
    updatedAt: now,
    stages: {
      ...snapshot.stages,
      [stage]: { status, updatedAt: now, evidence: [...evidence], blocker: status === "blocked" ? blocker : null },
    },
  };
}
