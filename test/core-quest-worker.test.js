import test from "node:test";
import assert from "node:assert/strict";
import { createAdventuresWorker, AdventuresWorkerError } from "../src/core-quest-worker.js";

const serverId = "22222222-2222-4222-8222-222222222222";
const clusterId = "11111111-1111-4111-8111-111111111111";
const questId = "99999999-9999-4999-8999-999999999999";
const eventId = "44444444-4444-4444-8444-444444444444";
const eventRecordId = "55555555-5555-4555-8555-555555555555";
const leaseToken = "33333333-3333-4333-8333-333333333333";
const platformId = "76561198000000000";
const credential = `cg_srv_${"s".repeat(40)}`;
const definition = {
  schemaVersion: 1, questId, revision: 1, name: "First Steps", enabled: true,
  scope: { clusterId, gridIds: ["A1"] },
  objectives: [{ id: "join-first-grid", eventType: "player.joined", targetCount: 1 }]
};
function row() {
  return {
    id: eventId, eventType: "game.event.received", aggregateType: "game_event", aggregateId: eventRecordId,
    payload: { eventRecordId, serverId, clusterId, gridId: "A1", correlationId: null, game: "atlas", eventId: "source-event", eventType: "player.joined", occurredAt: "2026-11-16T20:00:00.000Z", payload: { platformId, playerName: "Test Player" } },
    occurredAt: "2026-11-16T20:00:00.000Z", attempts: 1, leaseToken, leaseExpiresAt: "2026-11-16T20:02:00.000Z"
  };
}
function response(status, data) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
function worker(overrides = {}) {
  return createAdventuresWorker({ baseUrl: "https://core.example.test/api/v1", credential, serverId, fetchImpl: async () => response(200, { data: [] }), ...overrides });
}

test("validates configuration and prevents overlapping polls", async () => {
  assert.throws(() => createAdventuresWorker({}), /baseUrl/);
  assert.throws(() => worker({ credential: "bad" }), /service credential/);
  assert.throws(() => worker({ serverId: "bad" }), /serverId/);
  let release;
  const instance = worker({ fetchImpl: async () => new Promise((resolve) => { release = () => resolve(response(200, { data: [] })); }) });
  const first = instance.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(instance.pollOnce(), (error) => error instanceof AdventuresWorkerError && /already in progress/.test(error.message));
  release();
  await first;
});

test("persists matching quest progress before acknowledging the Core event", async () => {
  const calls = [];
  const instance = worker({ fetchImpl: async (url, options) => {
    const method = options.method;
    const path = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path, body, authorization: options.headers.authorization });
    if (path.endsWith("/events/claim")) return response(200, { data: [row()] });
    if (path.endsWith("/quests")) return response(200, { data: [{ questId, revision: 1, definition }] });
    if (path.endsWith(`/quests/${questId}/progress/${platformId}`)) return response(200, { data: { state: null, version: 0 } });
    if (path.endsWith(`/quests/${questId}/progress`)) return response(201, { data: { durable: true, duplicate: false, version: 1 } });
    if (path.endsWith(`/events/${eventId}/ack`)) return response(202, { data: { accepted: true, duplicate: false, eventId } });
    throw new Error(`Unexpected request ${method} ${path}`);
  } });
  const result = await instance.pollOnce();
  assert.equal(result.claimed, 1);
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.outcomes[0].status, "completed");
  assert.equal(result.outcomes[0].durable, true);
  const persist = calls.find((call) => call.path.endsWith(`/quests/${questId}/progress`));
  assert.equal(persist.body.eventId, eventId);
  assert.equal(persist.body.leaseToken, leaseToken);
  assert.equal(persist.body.expectedVersion, 0);
  assert.equal(persist.body.state.players[platformId].completed, true);
  assert.equal(calls.at(-1).path, `/api/v1/integrations/servers/${serverId}/events/${eventId}/ack`);
  assert.equal(calls.at(-1).body.outcome, "delivered");
  assert.ok(calls.every((call) => call.authorization === `Bearer ${credential}`));
});

test("acknowledges an event without progress when no player identity is present", async () => {
  const calls = [];
  const missingIdentity = { ...row(), payload: { ...row().payload, payload: { playerName: "No ID" } } };
  const instance = worker({ fetchImpl: async (url, options) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path.endsWith("/events/claim")) return response(200, { data: [missingIdentity] });
    if (path.endsWith(`/events/${eventId}/ack`)) return response(202, { data: { accepted: true, duplicate: false, eventId } });
    throw new Error(`Unexpected request ${path}`);
  } });
  const result = await instance.pollOnce();
  assert.equal(result.delivered, 1);
  assert.equal(result.outcomes[0].skipped, "missing_player_identity");
  assert.equal(calls.length, 2);
});
