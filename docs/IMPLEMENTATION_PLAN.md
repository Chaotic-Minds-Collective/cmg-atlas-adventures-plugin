# CMG Adventures — Implementation Plan

## Purpose
Quest, challenge and progression system integrated with identity, tribes, events and rewards.

## Feature scope
- Quest chains, objectives and prerequisites
- Daily/weekly challenges and seasonal events
- Progression tracks and skill unlocks where supported
- Player/tribe leaderboards
- Rewards through Core entitlements and leased delivery
- Admin quest editor and versioned events

## Dependencies
- Core identity, event outbox, entitlements and reward delivery
- ATLAS adapter: verified player/tribe/death/kill/crafting/exploration events
- Player for progression; Tribes for group objectives
- Commerce for rewards; Connect for announcements

## Data ownership
Adventures owns quest definitions, progress, completions, seasons, leaderboard snapshots and anti-abuse metadata. Core owns identity, entitlements and reward jobs.

## Milestones
1. **Define quest schema and idempotent progress engine — first version completed.** The schema validates quest identity/revision, cluster/grid/server scope, objectives and currently supported player event types.
2. **Build offline simulation and validation — first version completed.** The pure reducer handles scope checks, event-ID replay detection, progress increments and completion without a live server.
3. **Use supported Core events first — partial.** Core accepts 23 normalized event types; the native ATLAS adapter currently emits only `player.joined` and `player.left`, which the engine supports. Other event producers and a durable Core outbox worker remain pending.
4. Add player/tribe objectives — player join/leave objectives are implemented; tribe objectives and additional event producers remain pending.
5. Deliver rewards through Core worker contract — pending confirmed ATLAS grant implementation.
6. Add seasons, leaderboards and scheduled events — pending.

## Technical gates and risks
- The current reducer is an offline, in-memory foundation. Production requires durable progress and a persistent unique constraint/idempotency record for processed event IDs.
- Event IDs must be globally unique across servers/grids; the native adapter must include server identity in generated IDs before cross-grid production use.
- Core's normalized event allowlist is broader than the native adapter's current event production. Only `player.joined` and `player.left` are presently emitted by the adapter.
- Reward delivery awaits confirmed ATLAS grant implementation.
- Prevent replay and cross-grid duplicate progress before production enablement.

## Shared engineering requirements
- Use authenticated, least-privilege Core APIs; no direct database credentials in plugins.
- Preserve provider identifiers as strings; display names are not identifiers.
- Carry cluster, grid and server context on applicable records/events.
- Use stable event IDs, idempotency keys and correlation IDs.
- Keep network work off game-critical threads; use bounded timeouts, retries and circuit breakers.
- Keep secrets out of source control and separate credentials per server/integration.
- Add unit tests, fake-adapter contract tests and isolated runtime compatibility tests.
- Gate unsupported features behind explicit capabilities; fail closed for privileged actions.
- Do not deploy to production or change live server configuration during repository planning.

## Current readiness
Versioned quest definitions, player join/leave progress, scope checks, event-ID replay detection and offline simulation are implemented with nine unit tests. Progress is in memory only; no Core outbox transport, durable persistence, tribe events or reward delivery is enabled. The adapter's player hooks remain disabled pending isolated ATLAS runtime validation.
