# CMG Adventures

Quest, challenge and progression engine for CMG ATLAS. This repository now contains the first offline quest schema and player-event progress reducer.

## Implemented

- Strict, versioned quest definitions with cluster, optional grid/server scope, objectives and enabled state.
- Player objectives for the two event types currently emitted by the native adapter: `player.joined` and `player.left`.
- Exact Core `game.event.received` outbox-record normalization, then immutable progress state with outbox-record ID idempotency, scope filtering, completion timestamps and deterministic offline simulation.
- No network calls, database access, reward grants, or server mutations.

## Not implemented yet

- Durable progress persistence and production Core event-outbox worker.
- Tribe objectives, death/kill/crafting/exploration events, seasons, leaderboards, admin editor, or scheduled events.
- Reward claims or item delivery. Rewards must go through Core and remain blocked until ATLAS grants are verified.

Core accepts a wider normalized event allowlist, but the native adapter currently emits only player join/leave events. The reducer accepts the same claimed record shape delivered by the existing `CoreEventOutboxConsumer`; transport/acknowledgement wiring is still pending. Its in-memory processed-event list is not a substitute for durable production idempotency.

## Development

Requires Node.js 22 or later.

```bash
npm ci
npm run check
npm test
```

Tests use synthetic events and do not connect to Core or an ATLAS server.
