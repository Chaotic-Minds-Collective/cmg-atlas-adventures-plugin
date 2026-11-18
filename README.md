# CMG Adventures

Quest, challenge and progression engine for CMG ATLAS. This repository now contains the first offline quest schema and player-event progress reducer.

## Implemented

- Strict, versioned quest definitions with cluster, optional grid/server scope, objectives and enabled state.
- Player objectives for the two event types currently emitted by the native adapter: `player.joined` and `player.left`.
- Exact Core `game.event.received` outbox-record normalization, then immutable progress state with outbox-record ID idempotency, scope filtering, completion timestamps and deterministic offline simulation.
- A Core event-outbox worker that loads enabled quest definitions, calculates progress, persists it through Core, and acknowledges events only after durable writes.
- A recurring `start()` / graceful `stop()` lifecycle, one-event default claim batch, active Core lease renewal, bounded request timeouts, poll-error recovery, and structured in-memory metrics.
- Optimistic progress-version retries and Core event-lease tokens; duplicate events are protected by durable Core receipts.
- A Node.js runtime entry point and `npm run start:worker` command for long-running deployment environments.
- No direct database access, reward grants, or server mutations.

## Not implemented yet

- Production Core credentials and server configuration, deployment, and isolated ATLAS runtime validation.
- Production validation of lease renewal against the deployed Core API and a live database.
- Tribe objectives, death/kill/crafting/exploration events, seasons, leaderboards, admin editor, or scheduled events.
- Reward claims or item delivery. Rewards must go through Core and remain blocked until ATLAS grants are verified.

Core accepts a wider normalized event allowlist, but the native adapter currently emits only player join/leave events. The worker consumes the same Core `game.event.received` records, persists each matching quest/player update through Core, and acknowledges only after durable persistence. Core stores processed-event receipts separately and clears the reducer's in-memory event list on persistence.

## Development

Requires Node.js 22 or later.

```bash
npm ci
npm run check
npm test
```

Tests use synthetic events and do not connect to Core or an ATLAS server.

## Running the worker

Set these environment variables in the worker's secret/configuration store (never commit credentials):

- `ATLAS_CORE_BASE_URL` — Core API base URL, including any API prefix.
- `ATLAS_CORE_SERVICE_CREDENTIAL` — server-scoped Core service credential.
- `ATLAS_SERVER_ID` — UUID for the server represented by that credential.
- `ATLAS_QUEST_BATCH_SIZE` — optional, defaults to `1`; increase only when the lease duration safely covers the full sequential batch.
- `ATLAS_QUEST_LEASE_SECONDS` — optional, defaults to `120`.
- `ATLAS_QUEST_POLL_INTERVAL_MS` — optional, defaults to `5000`.
- `ATLAS_QUEST_REQUEST_TIMEOUT_MS` — optional, defaults to `10000`.
- `ATLAS_QUEST_LEASE_RENEW_INTERVAL_MS` — optional heartbeat interval; default is one-third of the configured lease duration (40 seconds with the default 120-second lease).

Run `npm run start:worker`. SIGINT and SIGTERM stop future claims and wait for the active poll to finish before the process exits. The worker renews the active event lease while processing it. Keep the default one-event batch: later events in a multi-event claim wait sequentially and do not receive a heartbeat until processing begins.
