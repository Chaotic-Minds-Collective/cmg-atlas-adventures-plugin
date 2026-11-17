import { applyQuestEvent, createQuestProgressState, normalizeCoreOutboxEvent, validateQuestDefinition } from "./quest-engine.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL = /^cg_srv_[A-Za-z0-9_-]{40,}$/;
const DEFAULT_TIMEOUT_MS = 10000;
const EVENT_TYPES = Object.freeze(["player.joined", "player.left"]);

export class AdventuresWorkerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "AdventuresWorkerError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
  return value.toLowerCase();
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch (error) { throw new TypeError("baseUrl must be an absolute URL", { cause: error }); }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname))) {
    throw new TypeError("baseUrl must use HTTPS (HTTP is allowed only for localhost tests)");
  }
  if (url.username || url.password || url.search || url.hash) throw new TypeError("baseUrl must not contain credentials, query parameters, or a fragment");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function safeErrorMessage(error, credential) {
  const raw = error instanceof Error ? error.message : "Quest event processing failed";
  return (raw.replaceAll(credential, "[redacted]").replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "Quest event processing failed").slice(0, 1000);
}

function validateClaim(row, serverId) {
  const event = normalizeCoreOutboxEvent(row);
  const leaseToken = requireUuid(row.leaseToken, "leaseToken");
  if (typeof row.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(row.leaseExpiresAt))) throw new AdventuresWorkerError("Core returned an invalid event lease expiry");
  if (event.scope.serverId !== serverId) throw new AdventuresWorkerError("Core returned an event outside this server scope");
  return Object.freeze({ ...event, leaseToken, leaseExpiresAt: row.leaseExpiresAt, raw: row });
}

export function createAdventuresWorker(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const credential = options.credential;
  if (typeof credential !== "string" || !CREDENTIAL.test(credential)) throw new TypeError("credential must be a valid Core service credential");
  const serverId = requireUuid(options.serverId, "serverId");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const limit = options.limit ?? 25;
  const leaseSeconds = options.leaseSeconds ?? 120;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxProgressConflicts = options.maxProgressConflicts ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) throw new TypeError("leaseSeconds must be between 15 and 300");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) throw new TypeError("requestTimeoutMs must be between 1 and 60000");
  if (!Number.isInteger(maxProgressConflicts) || maxProgressConflicts < 1 || maxProgressConflicts > 10) throw new TypeError("maxProgressConflicts must be between 1 and 10");

  const basePath = baseUrl.pathname === "/" ? "" : baseUrl.pathname;
  const endpoint = `${baseUrl.origin}${basePath}/integrations/servers/${serverId}`;
  let polling = false;

  async function request(path, method = "GET", body) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error("Core request timed out")); }, requestTimeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (!response.ok) {
        let code = null;
        try { code = (await response.clone().json())?.error?.code ?? null; } catch { /* retain HTTP status */ }
        throw new AdventuresWorkerError(`Core request failed with HTTP ${response.status}${code ? ` (${code})` : ""}`, { status: response.status, code });
      }
      let result;
      try { result = await response.json(); } catch (error) { throw new AdventuresWorkerError("Core returned invalid JSON", { cause: error, status: response.status }); }
      return { status: response.status, result };
    } catch (error) {
      if (timedOut) throw new AdventuresWorkerError("Core request timed out", { cause: error });
      if (error instanceof AdventuresWorkerError) throw error;
      throw new AdventuresWorkerError("Core request failed before a valid response was received", { cause: error });
    } finally { clearTimeout(timeout); }
  }

  async function loadQuests() {
    const { status, result } = await request("/quests");
    if (status !== 200 || !Array.isArray(result?.data)) throw new AdventuresWorkerError("Core returned an invalid quest catalogue", { status });
    return result.data.map((row) => {
      const definition = validateQuestDefinition(row?.definition);
      if (row.questId !== definition.questId || row.revision !== definition.revision) throw new AdventuresWorkerError("Core returned mismatched quest metadata");
      return definition;
    });
  }

  async function loadProgress(quest, platformId) {
    const path = `/quests/${quest.questId}/progress/${encodeURIComponent(platformId)}?revision=${quest.revision}`;
    const { status, result } = await request(path);
    if (status !== 200 || !result?.data || !Number.isInteger(result.data.version) || result.data.version < 0) throw new AdventuresWorkerError("Core returned an invalid quest progress record", { status });
    return result.data;
  }

  async function persistProgress(quest, event, platformId) {
    let current = await loadProgress(quest, platformId);
    for (let attempt = 0; attempt < maxProgressConflicts; attempt += 1) {
      const baseState = current.state ?? createQuestProgressState(quest);
      const applied = applyQuestEvent(quest, baseState, event.raw);
      if (!["applied", "completed", "already_completed"].includes(applied.outcome.status)) return applied.outcome;
      try {
        const { status, result } = await request(`/quests/${quest.questId}/progress`, "POST", {
          revision: quest.revision,
          eventId: event.eventId,
          leaseToken: event.leaseToken,
          platformId,
          expectedVersion: current.version,
          state: applied.state
        });
        if (![200, 201].includes(status) || result?.data?.durable !== true) throw new AdventuresWorkerError("Core did not confirm durable quest progress", { status });
        return Object.freeze({ ...applied.outcome, durable: true, duplicate: result.data.duplicate === true, version: result.data.version });
      } catch (error) {
        if (!(error instanceof AdventuresWorkerError) || error.status !== 409 || error.code !== "QUEST_PROGRESS_CONFLICT" || attempt + 1 >= maxProgressConflicts) throw error;
        current = await loadProgress(quest, platformId);
      }
    }
    throw new AdventuresWorkerError("Quest progress remained contended after bounded retries");
  }

  async function acknowledge(event, outcome, error) {
    const body = { leaseToken: event.leaseToken, outcome };
    if (error !== undefined) body.error = error;
    const { status, result } = await request(`/events/${event.eventId}/ack`, "POST", body);
    if (status !== 202 || result?.data?.accepted !== true || result.data.eventId !== event.eventId) throw new AdventuresWorkerError("Core did not confirm the event acknowledgement", { status });
    return result.data;
  }

  async function processEvent(event) {
    const platformId = typeof event.payload.platformId === "string" ? event.payload.platformId.trim() : "";
    if (!platformId || platformId.length > 128) return Object.freeze({ matched: 0, updated: 0, skipped: "missing_player_identity" });
    const quests = await loadQuests();
    let updated = 0;
    let matched = 0;
    for (const quest of quests) {
      const preview = applyQuestEvent(quest, createQuestProgressState(quest), event.raw);
      if (!["applied", "completed"].includes(preview.outcome.status)) continue;
      matched += 1;
      await persistProgress(quest, event, platformId);
      updated += 1;
    }
    return Object.freeze({ matched, updated });
  }

  async function pollOnce() {
    if (polling) throw new AdventuresWorkerError("An Adventures poll is already in progress");
    polling = true;
    try {
      const { status, result } = await request("/events/claim", "POST", { limit, leaseSeconds, eventTypes: [...EVENT_TYPES] });
      if (status !== 200 || !Array.isArray(result?.data)) throw new AdventuresWorkerError("Core returned an invalid event claim response", { status });
      const summary = { claimed: result.data.length, delivered: 0, failed: 0, acknowledgementErrors: [], outcomes: [] };
      for (const raw of result.data) {
        let event;
        try { event = validateClaim(raw, serverId); }
        catch (error) {
          summary.acknowledgementErrors.push(Object.freeze({ eventId: raw?.id ?? null, message: safeErrorMessage(error, credential) }));
          continue;
        }
        let handlerError;
        let outcome;
        try { outcome = await processEvent(event); }
        catch (error) { handlerError = safeErrorMessage(error, credential); }
        try {
          await acknowledge(event, handlerError === undefined ? "delivered" : "failed", handlerError);
          if (handlerError === undefined) { summary.delivered += 1; summary.outcomes.push(Object.freeze({ eventId: event.eventId, ...outcome })); }
          else summary.failed += 1;
        } catch (error) {
          summary.acknowledgementErrors.push(Object.freeze({ eventId: event.eventId, message: safeErrorMessage(error, credential) }));
        }
      }
      summary.acknowledgementErrors = Object.freeze(summary.acknowledgementErrors);
      summary.outcomes = Object.freeze(summary.outcomes);
      return Object.freeze(summary);
    } finally { polling = false; }
  }

  return Object.freeze({ pollOnce });
}
