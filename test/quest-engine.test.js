import assert from "node:assert/strict";
import test from "node:test";

import { applyQuestEvent, createQuestProgressState, normalizeCoreOutboxEvent, simulateQuest, validateQuestDefinition } from "../src/quest-engine.js";

const QUEST_ID = "d1111111-1111-4111-8111-111111111111";
const CLUSTER_ID = "c2222222-2222-4222-8222-222222222222";
const SERVER_A = "a3333333-3333-4333-8333-333333333333";
const SERVER_B = "b4444444-4444-4444-8444-444444444444";

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
    id: eventId,
    eventType: "game.event.received",
    aggregateType: "game_event",
    aggregateId: "55555555-5555-4555-8555-555555555555",
    payload: {
      eventRecordId: "55555555-5555-4555-8555-555555555555",
      serverId: overrides.serverId ?? SERVER_A,
      clusterId: overrides.clusterId ?? CLUSTER_ID,
      gridId: overrides.gridId ?? "A1",
      correlationId: null,
      game: "atlas",
      eventId: "source-" + eventId,
      eventType: overrides.eventType ?? "player.joined",
      occurredAt: overrides.occurredAt ?? "2026-11-16T20:00:00.000Z",
      payload: overrides.playerPayload ?? { platformId: "76561198000000000", playerName: "Player One" }
    }
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
  const first = applyQuestEvent(definition, createQuestProgressState(definition), event("66666666-6666-4666-8666-000000000001"));
  assert.equal(first.outcome.status, "applied");
  assert.equal(first.state.players["76561198000000000"].objectives["join-any-grid"], 1);
  const second = applyQuestEvent(definition, first.state, event("66666666-6666-4666-8666-000000000002", { gridId: "B1", serverId: SERVER_B }));
  assert.equal(second.outcome.status, "completed");
  assert.equal(second.state.players["76561198000000000"].completed, true);
  assert.equal(second.state.players["76561198000000000"].completedAt, "2026-11-16T20:00:00.000Z");
});

test("is idempotent for duplicate event IDs", () => {
  const definition = quest();
  const state = createQuestProgressState(definition);
  const first = applyQuestEvent(definition, state, event("66666666-6666-4666-8666-000000000001"));
  const duplicate = applyQuestEvent(definition, first.state, event("66666666-6666-4666-8666-000000000001"));
  assert.equal(duplicate.outcome.status, "duplicate");
  assert.equal(duplicate.state.players["76561198000000000"].objectives["join-any-grid"], 1);
  assert.equal(duplicate.state.processedEventIds.length, 1);
});

test("ignores events outside the quest cluster, grid, or server scope", () => {
  const definition = quest({ scope: { clusterId: CLUSTER_ID, gridIds: ["A1"], serverIds: [SERVER_A] } });
  const state = createQuestProgressState(definition);
  const wrongGrid = applyQuestEvent(definition, state, event("66666666-6666-4666-8666-000000000009", { gridId: "B1", serverId: SERVER_A }));
  assert.equal(wrongGrid.outcome.status, "out_of_scope");
  const wrongCluster = applyQuestEvent(definition, state, event("66666666-6666-4666-8666-000000000010", { clusterId: SERVER_A, gridId: "A1", serverId: SERVER_A }));
  assert.equal(wrongCluster.outcome.status, "out_of_scope");
});

test("ignores events without the adapter's normalized platformId", () => {
  const definition = quest();
  const result = applyQuestEvent(definition, createQuestProgressState(definition), event("66666666-6666-4666-8666-000000000011", { playerPayload: { playerName: "No ID" } }));
  assert.equal(result.outcome.status, "missing_player_identity");
  assert.equal(result.state.processedEventIds.length, 0);
});

test("does not advance disabled quests or unmatched event types", () => {
  const disabled = quest({ enabled: false });
  const disabledResult = applyQuestEvent(disabled, createQuestProgressState(disabled), event("66666666-6666-4666-8666-000000000012"));
  assert.equal(disabledResult.outcome.status, "disabled");
  const definition = quest();
  const unmatched = applyQuestEvent(definition, createQuestProgressState(definition), event("66666666-6666-4666-8666-000000000013", { eventType: "player.left" }));
  assert.equal(unmatched.outcome.status, "unmatched");
});

test("simulates a deterministic event sequence without a live server", () => {
  const definition = quest();
  const result = simulateQuest(definition, [event("66666666-6666-4666-8666-000000000001"), event("66666666-6666-4666-8666-000000000001"), event("66666666-6666-4666-8666-000000000002")]);
  assert.deepEqual(result.outcomes.map((item) => item.status), ["applied", "duplicate", "completed"]);
  assert.equal(result.state.players["76561198000000000"].completed, true);
});

test("accepts only Core game-event outbox records for ATLAS", () => {
  const definition = quest();
  const state = createQuestProgressState(definition);
  assert.throws(() => applyQuestEvent(definition, state, { ...event("66666666-6666-4666-8666-000000000007"), eventType: "other.event" }), /must be game.event.received/);
  const wrongGame = event("66666666-6666-4666-8666-000000000008");
  wrongGame.payload.game = "ark";
  assert.throws(() => applyQuestEvent(definition, state, wrongGame), /game must be atlas/);
});

test("normalizes uppercase UUIDs at quest and outbox scope boundaries", () => {
  const definition = quest({
    questId: QUEST_ID.toUpperCase(),
    scope: { clusterId: CLUSTER_ID.toUpperCase(), gridIds: ["A1", "B1"] }
  });
  const state = createQuestProgressState(definition);
  const uppercaseEventId = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
  const outbox = event(uppercaseEventId, { clusterId: CLUSTER_ID.toUpperCase(), serverId: SERVER_A.toUpperCase() });
  const result = applyQuestEvent(definition, state, outbox);
  assert.equal(result.outcome.status, "applied");
  assert.equal(result.outcome.eventId, uppercaseEventId.toLowerCase());
});

test("normalization copies nested player payloads before recursively freezing them", () => {
  const playerPayload = Object.freeze({ platformId: "76561198000000000", details: { name: "before" } });
  const outbox = event("66666666-6666-4666-8666-000000000014", { playerPayload });
  const normalized = normalizeCoreOutboxEvent(outbox);
  assert.equal(Object.isFrozen(playerPayload.details), false);
  playerPayload.details.name = "after";
  assert.equal(normalized.payload.details.name, "before");
  assert.equal(Object.isFrozen(normalized.payload), true);
  assert.equal(Object.isFrozen(normalized.payload.details), true);
});

test("rejects progress state from a different quest revision", () => {
  const definition = quest();
  const state = createQuestProgressState(definition);
  assert.throws(() => applyQuestEvent(quest({ revision: 2 }), state, event("66666666-6666-4666-8666-000000000001")), /match the quest ID and revision/);
});
