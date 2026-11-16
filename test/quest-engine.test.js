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

test("rejects progress state from a different quest revision", () => {
  const definition = quest();
  const state = createQuestProgressState(definition);
  assert.throws(() => applyQuestEvent(quest({ revision: 2 }), state, event("66666666-6666-4666-8666-000000000001")), /match the quest ID and revision/);
});


test("canonicalizes quest UUIDs and matches scope regardless of letter case", () => {
  const questId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const clusterId = "bcdefabc-defa-4bcd-9efa-bcdefabcdefa";
  const serverId = "cdefabcd-efab-4cde-abcd-cdefabcdefab";
  for (const uppercaseQuest of [false, true]) {
    const definition = quest({
      questId: uppercaseQuest ? questId.toUpperCase() : questId,
      scope: {
        clusterId: uppercaseQuest ? clusterId.toUpperCase() : clusterId,
        serverIds: [uppercaseQuest ? serverId.toUpperCase() : serverId]
      }
    });
    const validated = validateQuestDefinition(definition);
    assert.equal(validated.questId, questId);
    assert.equal(validated.scope.clusterId, clusterId);
    assert.deepEqual(validated.scope.serverIds, [serverId]);
    const state = createQuestProgressState(definition);
    assert.equal(state.questId, questId);
    const result = applyQuestEvent({ ...definition, questId }, state,
      event("abcdefab-cdef-4abc-8def-000000000001", {
        clusterId: uppercaseQuest ? clusterId : clusterId.toUpperCase(),
        serverId: uppercaseQuest ? serverId : serverId.toUpperCase()
      }));
    assert.equal(result.outcome.status, "applied");
    assert.equal(result.state.players["76561198000000000"].objectives["join-any-grid"], 1);
  }
});

test("treats differently cased outbox UUIDs as the same event", () => {
  const definition = quest();
  const eventId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  for (const ids of [[eventId.toUpperCase(), eventId], [eventId, eventId.toUpperCase()]]) {
    const first = applyQuestEvent(definition, createQuestProgressState(definition), event(ids[0]));
    const duplicate = applyQuestEvent(definition, first.state, event(ids[1]));
    assert.equal(first.outcome.eventId, eventId);
    assert.equal(duplicate.outcome.status, "duplicate");
    assert.equal(duplicate.state, first.state);
    assert.deepEqual(duplicate.state.processedEventIds, [eventId]);
    assert.equal(duplicate.state.players["76561198000000000"].objectives["join-any-grid"], 1);
  }
});

test("rejects duplicate server UUIDs with different letter case", () => {
  const serverId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  assert.throws(() => validateQuestDefinition(quest({
    scope: { clusterId: CLUSTER_ID, serverIds: [serverId, serverId.toUpperCase()] }
  })), (error) => error.path === "quest.scope.serverIds" && /duplicates/.test(error.message));
});
