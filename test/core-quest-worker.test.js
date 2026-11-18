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
    occurredAt: "2026-11-16T20:00:00.000Z", attempts: 1, leaseToken, leaseExpiresAt: new Date(Date.now() + 120000).toISOString()
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
    if (path.endsWith(`/events/${eventId}/renew`)) return response(200, { data: { renewed: true, eventId, leaseExpiresAt: new Date(Date.now() + 180000).toISOString() } });
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
  assert.equal(result.outcomes[0].skipped, 1);
  assert.equal(result.outcomes[0].skipReason, "missing_player_identity");
  assert.equal(result.skipped, 1);
  assert.equal(calls.length, 2);
});


test("runs a recurring poll loop and stop drains the active poll without claiming again", async () => {
  let claims = 0;
  let releaseClaim;
  const instance = worker({ pollIntervalMs: 250, fetchImpl: async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/events/claim")) {
      claims += 1;
      if (claims === 1) return new Promise((resolve) => { releaseClaim = () => resolve(response(200, { data: [] })); });
      return response(200, { data: [] });
    }
    throw new Error(`Unexpected request ${path}`);
  } });

  const started = instance.start();
  assert.equal(started.lifecycle, "running");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claims, 1);
  const stopping = instance.stop();
  assert.equal(instance.getStatus().lifecycle, "stopping");
  releaseClaim();
  const stopped = await stopping;
  assert.equal(stopped.lifecycle, "stopped");
  assert.equal(stopped.polls, 1);
  assert.equal(claims, 1);
});

test("reports recurring poll errors and continues polling until stopped", async () => {
  let claims = 0;
  let observedErrors = 0;
  const instance = worker({ pollIntervalMs: 250, onError: () => { observedErrors += 1; }, fetchImpl: async () => {
    claims += 1;
    if (claims === 1) throw new Error("temporary network failure");
    return response(200, { data: [] });
  } });
  instance.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const status = await instance.stop();
  assert.equal(status.lifecycle, "stopped");
  assert.equal(status.pollErrors, 1);
  assert.equal(observedErrors, 1);
  assert.ok(claims >= 2);
});

test("validates lifecycle polling interval and error observer", () => {
  assert.throws(() => worker({ pollIntervalMs: 10 }), /pollIntervalMs/);
  assert.throws(() => worker({ leaseRenewIntervalMs: 10000, leaseSeconds: 15 }), /leaseRenewIntervalMs/);
  assert.throws(() => worker({ onError: true }), /onError/);
});


test("renews an active Core event lease while a slow quest update is running", async () => {
  let renewals = 0;
  const calls = [];
  const instance = worker({ leaseSeconds: 15, leaseRenewIntervalMs: 250, fetchImpl: async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith("/events/claim")) return response(200, { data: [row()] });
    if (path.endsWith(`/events/${eventId}/renew`)) {
      renewals += 1;
      return response(200, { data: { renewed: true, eventId, leaseExpiresAt: new Date(Date.now() + 15000).toISOString() } });
    }
    if (path.endsWith("/quests")) {
      await new Promise((resolve) => setTimeout(resolve, 650));
      return response(200, { data: [{ questId, revision: 1, definition }] });
    }
    if (path.endsWith(`/quests/${questId}/progress/${platformId}`)) return response(200, { data: { state: null, version: 0 } });
    if (path.endsWith(`/quests/${questId}/progress`)) return response(201, { data: { durable: true, duplicate: false, version: 1 } });
    if (path.endsWith(`/events/${eventId}/ack`)) return response(202, { data: { accepted: true, duplicate: false, eventId } });
    throw new Error(`Unexpected request ${path}`);
  } });
  const result = await instance.pollOnce();
  assert.equal(result.delivered, 1);
  assert.ok(renewals >= 2);
  assert.equal(instance.getStatus().leaseRenewals, renewals);
  assert.ok(calls.indexOf(`/api/v1/integrations/servers/${serverId}/events/${eventId}/renew`) < calls.indexOf(`/api/v1/integrations/servers/${serverId}/events/${eventId}/ack`));
});
