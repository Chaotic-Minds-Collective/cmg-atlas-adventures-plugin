import assert from "node:assert/strict";
import test from "node:test";

import { applyQuestEvent, createQuestProgressState, simulateQuest, validateQuestDefinition } from "../src/quest-engine.js";

const QUEST_ID = "11111111-1111-4111-8111-111111111111";
const CLUSTER_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_A = "33333333-3333-4333-8333-333333333333";
const SERVER_B = "44444444-4444-4444-8444-444444444444";

function quest(overrides = {}) {
  return {
    schemaVersion: 1,
    questId: QUEST_ID,
    revision: 1,
    name: "First Steps",
    enabled: true,
    scope: { clusterId: CLUSTER_ID, gridIds: ["A1", "B1"] },
    objectives: [{ id: "join-any-grid", eventType: "player.joined", targetCount: 2 }],
    ...overrides
  };
}

function event(eventId, overrides = {}) {
  return {
    eventId,
    eventType: "player.joined",
    occurredAt: "2026-11-16T20:00:00.000Z",
    scope: { clusterId: CLUSTER_ID, gridId: "A1", serverId: SERVER_A },
    payload: { platformId: "76561198000000000", playerName: "Player One" },
    ...overrides
  };
}

test("validates versioned quest definitions and freezes the result", () => {
  const result = validateQuestDefinition(quest());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.objectives[0].eventType, "player.joined");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.objectives[0]), true);
});

test("rejects unsupported event types, unknown fields, and duplicate objectives", () => {
  assert.throws(() => validateQuestDefinition(quest({ objectives: [{ id: "x", eventType: "tribe.created", targetCount: 1 }] })), /not currently emitted/);
  assert.throws(() => validateQuestDefinition({ ...quest(), unsafe: true }), /unsupported field unsafe/);
  assert.throws(() => validateQuestDefinition(quest({ objectives: [
    { id: "same", eventType: "player.joined", targetCount: 1 },
    { id: "same", eventType: "player.left", targetCount: 1 }
  ] })), /duplicates another objective/);
});

test("applies events to the matching player and completes at the target", () => {
  const definition = quest();
  const first = applyQuestEvent(definition, createQuestProgressState(definition), event("evt-1"));
  assert.equal(first.outcome.status, "applied");
  assert.equal(first.state.players["76561198000000000"].objectives["join-any-grid"], 1);
  const second = applyQuestEvent(definition, first.state, event("evt-2", { scope: { clusterId: CLUSTER_ID, gridId: "B1", serverId: SERVER_B } }));
  assert.equal(second.outcome.status, "completed");
  assert.equal(second.state.players["76561198000000000"].completed, true);
  assert.equal(second.state.players["76561198000000000"].completedAt, "2026-11-16T20:00:00.000Z");
});

test("is idempotent for duplicate event IDs", () => {
  const definition = quest();
  const state = createQuestProgressState(definition);
  const first = applyQuestEvent(definition, state, event("evt-1"));
  const duplicate = applyQuestEvent(definition, first.state, event("evt-1"));
  assert.equal(duplicate.outcome.status, "duplicate");
  assert.equal(duplicate.state.players["76561198000000000"].objectives["join-any-grid"], 1);
  assert.equal(duplicate.state.processedEventIds.length, 1);
});

test("ignores events outside the quest cluster, grid, or server scope", () => {
  const definition = quest({ scope: { clusterId: CLUSTER_ID, gridIds: ["A1"], serverIds: [SERVER_A] } });
  const state = createQuestProgressState(definition);
  const wrongGrid = applyQuestEvent(definition, state, event("evt-grid", { scope: { clusterId: CLUSTER_ID, gridId: "B1", serverId: SERVER_A } }));
  assert.equal(wrongGrid.outcome.status, "out_of_scope");
  const wrongCluster = applyQuestEvent(definition, state, event("evt-cluster", { scope: { clusterId: SERVER_A, gridId: "A1", serverId: SERVER_A } }));
  assert.equal(wrongCluster.outcome.status, "out_of_scope");
});

test("ignores events without the adapter's normalized platformId", () => {
  const definition = quest();
  const result = applyQuestEvent(definition, createQuestProgressState(definition), event("evt-no-player", { payload: { playerName: "No ID" } }));
  assert.equal(result.outcome.status, "missing_player_identity");
  assert.equal(result.state.processedEventIds.length, 0);
});

test("does not advance disabled quests or unmatched event types", () => {
  const disabled = quest({ enabled: false });
  const disabledResult = applyQuestEvent(disabled, createQuestProgressState(disabled), event("evt-disabled"));
  assert.equal(disabledResult.outcome.status, "disabled");
  const definition = quest();
  const unmatched = applyQuestEvent(definition, createQuestProgressState(definition), event("evt-left", { eventType: "player.left" }));
  assert.equal(unmatched.outcome.status, "unmatched");
});

test("simulates a deterministic event sequence without a live server", () => {
  const definition = quest();
  const result = simulateQuest(definition, [event("evt-1"), event("evt-1"), event("evt-2")]);
  assert.deepEqual(result.outcomes.map((item) => item.status), ["applied", "duplicate", "completed"]);
  assert.equal(result.state.players["76561198000000000"].completed, true);
});

test("rejects progress state from a different quest revision", () => {
  const definition = quest();
  const state = createQuestProgressState(definition);
  assert.throws(() => applyQuestEvent(quest({ revision: 2 }), state, event("evt-1")), /match the quest ID and revision/);
});
