import { createAdventuresWorker } from "./core-quest-worker.js";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

const leaseSeconds = integerEnv("ATLAS_QUEST_LEASE_SECONDS", 120, 15, 300);
const worker = createAdventuresWorker({
  baseUrl: requiredEnv("ATLAS_CORE_BASE_URL"),
  credential: requiredEnv("ATLAS_CORE_SERVICE_CREDENTIAL"),
  serverId: requiredEnv("ATLAS_SERVER_ID"),
  limit: integerEnv("ATLAS_QUEST_BATCH_SIZE", 1, 1, 100),
  leaseSeconds,
  requestTimeoutMs: integerEnv("ATLAS_QUEST_REQUEST_TIMEOUT_MS", 10000, 1, 60000),
  pollIntervalMs: integerEnv("ATLAS_QUEST_POLL_INTERVAL_MS", 5000, 250, 300000),
  leaseRenewIntervalMs: integerEnv("ATLAS_QUEST_LEASE_RENEW_INTERVAL_MS", Math.floor(leaseSeconds * 1000 / 3), 100, 149999),
  onError(error, status) {
    process.stderr.write(`${JSON.stringify({ event: "atlas_quest_worker_error", message: status.lastError, pollErrors: status.pollErrors })}\n`);
  }
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${JSON.stringify({ event: "atlas_quest_worker_stopping", signal })}\n`);
  try {
    const status = await worker.stop();
    process.stdout.write(`${JSON.stringify({ event: "atlas_quest_worker_stopped", ...status })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: "atlas_quest_worker_shutdown_error", message: error instanceof Error ? error.message : "shutdown failed" })}\n`);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

const status = worker.start();
process.stdout.write(`${JSON.stringify({ event: "atlas_quest_worker_started", serverId: process.env.ATLAS_SERVER_ID, lifecycle: status.lifecycle })}\n`);
