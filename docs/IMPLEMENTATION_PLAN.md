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
2. **Build offline simulation and validation — first version completed.** The pure reducer normalizes Core's actual `game.event.received` outbox record, then handles scope checks, outbox-record ID replay detection, progress increments and completion without a live server.
3. **Use supported Core events first — implemented for current adapter events.** Adventures now consumes Core outbox records for `player.joined` and `player.left`, calculates progress, persists through Core, and acknowledges only after durable writes. Other event producers remain pending.
4. Add player/tribe objectives — player join/leave objectives are implemented; tribe objectives and additional event producers remain pending.
5. Deliver rewards through Core worker contract — pending confirmed ATLAS grant implementation.
6. Add seasons, leaderboards and scheduled events — pending.

## Technical gates and risks
- Core now provides immutable quest revisions, server-scoped progress reads/writes, optimistic progress versions, and unique durable receipts per quest revision/outbox event. Production still requires isolated runtime and deployment validation.
- The native adapter PR now includes the source server UUID in generated event IDs. That change still requires review/merge and isolated runtime validation. Production progress still requires durable idempotency keyed by the Core outbox record UUID.
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
Versioned quest definitions, player join/leave progress, scope checks and offline simulation remain covered by the reducer tests. A Core-backed worker and durable progress API are now implemented with mocked transport tests; live Core database integration and isolated ATLAS runtime validation remain required. Tribe events and reward delivery remain pending. The adapter's player hooks remain disabled pending isolated ATLAS runtime validation.
