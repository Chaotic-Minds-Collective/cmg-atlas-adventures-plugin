const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECTIVE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PLAYER_EVENT_TYPES = new Set(["player.joined", "player.left"]);

export class QuestValidationError extends TypeError {
  constructor(message, path, code = "INVALID_QUEST") {
    super(message);
    this.name = "QuestValidationError";
    this.path = path;
    this.code = code;
  }
}

function fail(message, path, code) {
  throw new QuestValidationError(message, path, code);
}

function object(value, path, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path + " must be an object", path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path + " contains unsupported field " + key, path + "." + key, "UNKNOWN_FIELD");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(path + "." + key + " is required", path + "." + key, "REQUIRED_FIELD");
  }
  return value;
}

function text(value, path, max = 200) {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > max) {
    fail(path + " must be a non-empty string of at most " + max + " characters", path);
  }
  return value.trim();
}

function uuid(value, path) {
  const result = text(value, path, 36);
  if (!UUID.test(result)) fail(path + " must be a UUID", path, "INVALID_UUID");
  return result;
}

function positiveInteger(value, path, max = 100_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail(path + " must be an integer from 1 to " + max, path, "INVALID_TARGET");
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateQuestDefinition(input) {
  object(input, "quest", ["schemaVersion", "questId", "revision", "name", "enabled", "scope", "objectives"],
    ["schemaVersion", "questId", "revision", "name", "enabled", "scope", "objectives"]);
  if (input.schemaVersion !== 1) fail("quest.schemaVersion must equal 1", "quest.schemaVersion", "UNSUPPORTED_SCHEMA_VERSION");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail("quest.revision must be a positive integer", "quest.revision");
  if (typeof input.enabled !== "boolean") fail("quest.enabled must be a boolean", "quest.enabled");

  object(input.scope, "quest.scope", ["clusterId", "gridIds", "serverIds"], ["clusterId"]);
  const scope = { clusterId: uuid(input.scope.clusterId, "quest.scope.clusterId") };
  if (Object.hasOwn(input.scope, "gridIds")) {
    if (!Array.isArray(input.scope.gridIds) || input.scope.gridIds.length === 0) fail("quest.scope.gridIds must be a non-empty array", "quest.scope.gridIds");
    const gridIds = input.scope.gridIds.map((id, index) => text(id, "quest.scope.gridIds[" + index + "]"));
    if (new Set(gridIds).size !== gridIds.length) fail("quest.scope.gridIds must not contain duplicates", "quest.scope.gridIds");
    scope.gridIds = Object.freeze(gridIds);
  }
  if (Object.hasOwn(input.scope, "serverIds")) {
    if (!Array.isArray(input.scope.serverIds) || input.scope.serverIds.length === 0) fail("quest.scope.serverIds must be a non-empty array", "quest.scope.serverIds");
    const serverIds = input.scope.serverIds.map((id, index) => uuid(id, "quest.scope.serverIds[" + index + "]"));
    if (new Set(serverIds).size !== serverIds.length) fail("quest.scope.serverIds must not contain duplicates", "quest.scope.serverIds");
    scope.serverIds = Object.freeze(serverIds);
  }

  if (!Array.isArray(input.objectives) || input.objectives.length === 0 || input.objectives.length > 20) {
    fail("quest.objectives must contain one to twenty objectives", "quest.objectives");
  }
  const objectiveIds = new Set();
  const objectives = input.objectives.map((objective, index) => {
    const path = "quest.objectives[" + index + "]";
    object(objective, path, ["id", "eventType", "targetCount", "description"], ["id", "eventType", "targetCount"]);
    const id = text(objective.id, path + ".id", 64);
    if (!OBJECTIVE_ID.test(id)) fail(path + ".id must be a lowercase objective key", path + ".id");
    if (objectiveIds.has(id)) fail(path + ".id duplicates another objective", path + ".id", "DUPLICATE_ID");
    objectiveIds.add(id);
    if (typeof objective.eventType !== "string" || !PLAYER_EVENT_TYPES.has(objective.eventType)) {
      fail(path + ".eventType is not currently emitted by the native adapter", path + ".eventType", "UNSUPPORTED_EVENT_TYPE");
    }
    const result = {
      id,
      eventType: objective.eventType,
      targetCount: positiveInteger(objective.targetCount, path + ".targetCount")
    };
    if (Object.hasOwn(objective, "description")) result.description = text(objective.description, path + ".description", 300);
    return Object.freeze(result);
  });

  return deepFreeze({
    schemaVersion: 1,
    questId: uuid(input.questId, "quest.questId"),
    revision: input.revision,
    name: text(input.name, "quest.name", 100),
    enabled: input.enabled,
    scope: Object.freeze(scope),
    objectives: Object.freeze(objectives)
  });
}

export function createQuestProgressState(questInput) {
  const quest = validateQuestDefinition(questInput);
  return deepFreeze({
    schemaVersion: 1,
    questId: quest.questId,
    questRevision: quest.revision,
    processedEventIds: Object.freeze([]),
    players: Object.freeze(Object.create(null))
  });
}

function validateEvent(event) {
  object(event, "event", ["eventId", "eventType", "occurredAt", "scope", "payload"],
    ["eventId", "eventType", "occurredAt", "scope", "payload"]);
  const eventId = text(event.eventId, "event.eventId", 200);
  const eventType = text(event.eventType, "event.eventType", 100);
  const occurredAt = text(event.occurredAt, "event.occurredAt", 50);
  if (!Number.isFinite(Date.parse(occurredAt))) fail("event.occurredAt must be a valid timestamp", "event.occurredAt");
  object(event.scope, "event.scope", ["clusterId", "gridId", "serverId"], ["clusterId", "gridId", "serverId"]);
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) fail("event.payload must be an object", "event.payload");
  return {
    eventId,
    eventType,
    occurredAt,
    scope: {
      clusterId: uuid(event.scope.clusterId, "event.scope.clusterId"),
      gridId: text(event.scope.gridId, "event.scope.gridId"),
      serverId: uuid(event.scope.serverId, "event.scope.serverId")
    },
    payload: event.payload
  };
}

function copyPlayers(players) {
  const copy = Object.create(null);
  for (const [key, value] of Object.entries(players)) copy[key] = value;
  return copy;
}

/** Apply one normalized Core event. Progress is immutable and event-ID idempotent within this state. */
export function applyQuestEvent(questInput, stateInput, eventInput) {
  const quest = validateQuestDefinition(questInput);
  if (!stateInput || typeof stateInput !== "object" || Array.isArray(stateInput)) fail("state must be an object", "state");
  if (stateInput.questId !== quest.questId || stateInput.questRevision !== quest.revision) {
    fail("progress state must match the quest ID and revision", "state", "STATE_MISMATCH");
  }
  if (!Array.isArray(stateInput.processedEventIds) || !stateInput.players || typeof stateInput.players !== "object") {
    fail("progress state has an invalid shape", "state");
  }
  const event = validateEvent(eventInput);
  if (stateInput.processedEventIds.includes(event.eventId)) {
    return Object.freeze({ state: stateInput, outcome: Object.freeze({ status: "duplicate", eventId: event.eventId }) });
  }
  if (!quest.enabled) return Object.freeze({ state: stateInput, outcome: Object.freeze({ status: "disabled", eventId: event.eventId }) });
  if (event.scope.clusterId !== quest.scope.clusterId ||
      (quest.scope.gridIds && !quest.scope.gridIds.includes(event.scope.gridId)) ||
      (quest.scope.serverIds && !quest.scope.serverIds.includes(event.scope.serverId))) {
    return Object.freeze({ state: stateInput, outcome: Object.freeze({ status: "out_of_scope", eventId: event.eventId }) });
  }
  const matchingObjectives = quest.objectives.filter((objective) => objective.eventType === event.eventType);
  if (matchingObjectives.length === 0) return Object.freeze({ state: stateInput, outcome: Object.freeze({ status: "unmatched", eventId: event.eventId }) });
  const platformId = typeof event.payload.platformId === "string" ? event.payload.platformId.trim() : "";
  if (!platformId || platformId.length > 128) {
    return Object.freeze({ state: stateInput, outcome: Object.freeze({ status: "missing_player_identity", eventId: event.eventId }) });
  }

  const processedEventIds = [...stateInput.processedEventIds, event.eventId];
  const players = copyPlayers(stateInput.players);
  const current = players[platformId] ?? { objectives: Object.create(null), completed: false, completedAt: null };
  const objectiveProgress = Object.assign(Object.create(null), current.objectives);
  if (current.completed) {
    players[platformId] = deepFreeze({ objectives: Object.freeze(objectiveProgress), completed: true, completedAt: current.completedAt });
    const state = deepFreeze({ ...stateInput, processedEventIds: Object.freeze(processedEventIds), players: Object.freeze(players) });
    return Object.freeze({ state, outcome: Object.freeze({ status: "already_completed", eventId: event.eventId, platformId }) });
  }

  for (const objective of matchingObjectives) {
    const currentCount = objectiveProgress[objective.id] ?? 0;
    objectiveProgress[objective.id] = Math.min(objective.targetCount, currentCount + 1);
  }
  const completed = quest.objectives.every((objective) => (objectiveProgress[objective.id] ?? 0) >= objective.targetCount);
  players[platformId] = deepFreeze({
    objectives: Object.freeze(objectiveProgress),
    completed,
    completedAt: completed ? event.occurredAt : null
  });
  const state = deepFreeze({
    schemaVersion: 1,
    questId: quest.questId,
    questRevision: quest.revision,
    processedEventIds: Object.freeze(processedEventIds),
    players: Object.freeze(players)
  });
  return Object.freeze({
    state,
    outcome: Object.freeze({ status: completed ? "completed" : "applied", eventId: event.eventId, platformId, completed })
  });
}

export function simulateQuest(questInput, events) {
  if (!Array.isArray(events)) fail("events must be an array", "events");
  let state = createQuestProgressState(questInput);
  const outcomes = [];
  for (const event of events) {
    const result = applyQuestEvent(questInput, state, event);
    state = result.state;
    outcomes.push(result.outcome);
  }
  return deepFreeze({ state, outcomes: Object.freeze(outcomes) });
}
