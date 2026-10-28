import test from "node:test";
import assert from "node:assert/strict";
import {
  BOOTSTRAP_STAGES, MEMORY_TIERS, createPersonalAgentBootstrap,
  nextPersonalAgentBootstrapStage, updatePersonalAgentBootstrap,
  validatePersonalAgentBootstrap,
} from "../../src/agents/personal-agent-bootstrap.mjs";

test("fresh personal agent has ordered pending stages and three memory tiers", () => {
  const state = createPersonalAgentBootstrap({ agentId: "agent-1", ownerId: "owner-1", now: "2026-10-28T00:00:00Z" });
  assert.equal(nextPersonalAgentBootstrapStage(state), BOOTSTRAP_STAGES[0]);
  assert.deepEqual(MEMORY_TIERS, ["CANON", "Immediate", "Curated"]);
  assert.equal(validatePersonalAgentBootstrap(JSON.parse(JSON.stringify(state))).agentId, "agent-1");
});
test("cannot mark an unverified stage complete or skip stages", () => {
  const state = createPersonalAgentBootstrap({ agentId: "a", ownerId: "o" });
  assert.throws(() => updatePersonalAgentBootstrap(state, { stage: BOOTSTRAP_STAGES[0], status: "completed" }), /evidence/);
  assert.throws(() => updatePersonalAgentBootstrap(state, { stage: BOOTSTRAP_STAGES[1], status: "completed", evidence: ["receipt:2"] }), /order/);
});
test("blocked stages retain reason and resume without losing earlier receipts", () => {
  let state = createPersonalAgentBootstrap({ agentId: "a", ownerId: "o" });
  state = updatePersonalAgentBootstrap(state, { stage: BOOTSTRAP_STAGES[0], status: "completed", evidence: ["receipt:identity"] });
  state = updatePersonalAgentBootstrap(state, { stage: BOOTSTRAP_STAGES[1], status: "blocked", blocker: "missing capability" });
  const recovered = JSON.parse(JSON.stringify(state));
  assert.equal(nextPersonalAgentBootstrapStage(recovered), BOOTSTRAP_STAGES[1]);
  assert.equal(recovered.stages[BOOTSTRAP_STAGES[0]].evidence[0], "receipt:identity");
  assert.equal(recovered.stages[BOOTSTRAP_STAGES[1]].blocker, "missing capability");
  const resumed = updatePersonalAgentBootstrap(recovered, { stage: BOOTSTRAP_STAGES[1], status: "completed", evidence: ["receipt:intelligence"] });
  assert.equal(nextPersonalAgentBootstrapStage(resumed), BOOTSTRAP_STAGES[2]);
});
test("completion requires real reference-shaped evidence, not empty values", () => {
  const state = createPersonalAgentBootstrap({ agentId: "a", ownerId: "o" });
  assert.throws(() => updatePersonalAgentBootstrap(state, { stage: BOOTSTRAP_STAGES[0], status: "completed", evidence: [" "] }), /Evidence/);
  assert.throws(() => updatePersonalAgentBootstrap(state, { stage: BOOTSTRAP_STAGES[0], status: "blocked" }), /blocker/);
});
