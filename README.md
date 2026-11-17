# CMG Adventures

Quest, challenge and progression engine for CMG ATLAS. This repository now contains the first offline quest schema and player-event progress reducer.

## Implemented

- Strict, versioned quest definitions with cluster, optional grid/server scope, objectives and enabled state.
- Player objectives for the two event types currently emitted by the native adapter: `player.joined` and `player.left`.
- Exact Core `game.event.received` outbox-record normalization, then immutable progress state with outbox-record ID idempotency, scope filtering, completion timestamps and deterministic offline simulation.
- A bounded Core event-outbox worker that loads enabled quest definitions, calculates progress, persists it through Core, and acknowledges events only after durable writes.
- Optimistic progress-version retries and Core event-lease tokens; duplicate events are protected by durable Core receipts.
- No direct database access, reward grants, or server mutations.

## Not implemented yet

- Production Core credentials and server configuration, deployment, and isolated ATLAS runtime validation.
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
