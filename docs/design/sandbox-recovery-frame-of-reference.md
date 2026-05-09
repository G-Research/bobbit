# Sandbox-Recovery Frame-of-Reference Carry-Over

**Status**: shipped
**Related**: [`unify-session-status.md`](unify-session-status.md), [`streaming-dedup-reorder.md`](streaming-dedup-reorder.md), [`perm-frame-late-joiner-seq-replay.md`](perm-frame-late-joiner-seq-replay.md) (single-allocation pin for the perm-frame seq, same bug-class as the respawn-helper callsite pin)
**Code**: `src/server/agent/session-manager.ts` — `_respawnAgentInPlace`, `_snapshotStreamingFrameOfReference`, `EventBuffer.seedNextSeq`

---

## Why this exists

The client gates every applied frame on two monotonic counters:

- `_highestSeq` — any frame with `seq <= _highestSeq` is silently dropped.
- `_lastStatusVersion` — any status mutation with `version <= _lastStatusVersion` is dropped.

These counters live on `RemoteAgent` and are **never reset while the WebSocket stays open**. They were introduced by [`unify-session-status`](unify-session-status.md) (status dedup) and the streaming-dedup envelope (seq dedup) to make replays and reconnects idempotent.

That correctness property has a sharp edge: any server-side path that **rebuilds `SessionInfo` + `EventBuffer` while the client's WS stays attached** must seed the new counters from the old high-water marks. Otherwise the fresh `EventBuffer` starts at `seq=1` and the fresh `SessionInfo` at `statusVersion=0`, every post-respawn frame fails the client's `>` check, and the UI freezes until the user reloads.

The original PR (`restart-preserves-streaming-frame`) wired this carry-over into the two restart sites it knew about. **One production caller was missed**: `recoverSandboxSessions` (Docker container recreation). The symptom — "UI receives no events from the agent after a sandbox respawn, clears on reload" — was the same bug, same root cause, third site.

This doc consolidates the invariant so the next person who adds a fourth in-place respawn path doesn't re-hit it.

## The invariant

> **If the WebSocket stays open across an agent respawn, the new `EventBuffer.lastSeq` and `SessionInfo.statusVersion` MUST be seeded from the pre-respawn high-water marks.**

Concretely:

1. Snapshot `{ lastSeq, lastStatusVersion }` from the existing `SessionInfo` via `_snapshotStreamingFrameOfReference()`.
2. Stash on the `PersistedSession` as the private `_restartFrameOfReference` field.
3. `restoreSession()` reads it, primes `EventBuffer.seedNextSeq(lastSeq + 1)`, and constructs the new `SessionInfo` with `statusVersion: lastStatusVersion`.
4. The very next live frame lands at `seq = lastSeq + 1` / `version = lastStatusVersion + 1` and advances the client's trackers naturally.

The carry-over field is private (no protocol change) and unconditionally cleared in a `finally` so it never leaks into a later boot path.

## The four in-place respawn sites

All routed through `SessionManager._respawnAgentInPlace(session, ps, opts?)`:

| Caller | Trigger | Carry-over option |
|---|---|---|
| `restartAgent` | Manual restart, dead-process recovery | `mutatePs` stashes saved `allowedTools` |
| `_restartSessionWithUpdatedRole` | Tool-grant or role change requires fresh process | `mutatePs` stashes role override |
| `recoverSandboxSessions` | Docker container recreated (the bug fix) | none |
| `ensureSessionAlive` (in-memory branch) | Terminated `SessionInfo` still has attached clients | none |

The helper owns the full dance: save-clients → unsubscribe → snapshot frame-of-reference → stop RPC client → delete from `sessions` map → stash carry-over on `ps` → `restoreSession(ps)` → re-attach saved clients (filtered by `readyState === 1`) → `broadcastStatus(restored, finalStatus ?? "idle")`. The cleanup of `_restartFrameOfReference` and `_overrideAllowedTools` is centralised in one `finally`, replacing three duplicated cleanups in the prior shape.

## Why timing matters: snapshot AFTER `unsubscribe()`

The original two sites snapshotted **before** `unsubscribe()`. That left a narrow window where a final in-flight event (e.g. an `agent_end` frame already enqueued on the event bus) could write `eventBuffer.lastSeq + 1` between the snapshot and the unsubscribe. The carry-over would be one short, and that one frame's worth of `seq` space would be replayed under the new buffer — invisible most of the time, but a real ordering hazard.

Snapshotting **after** `unsubscribe()` closes the window: by the time we read `lastSeq`, no further events can be appended. The fix is baked into the helper, which means it tightens the two pre-existing sites for free.

## Sites correctly NOT routed through the helper

Two paths rebuild `SessionInfo` + `EventBuffer` but do **not** need carry-over, because they have **no live WS clients** and therefore no client-side `_highestSeq` to outrun:

- **`restoreOneSession`** (boot) — runs before any WS connects. Fresh `_highestSeq=0` on the client side too.
- **`addClient` dormant-revive** — when a client attaches to a session whose agent process exited cleanly, the client begins from `_highestSeq=0` for that session id (it's a fresh `RemoteAgent`).

Routing these through the helper would seed off a zero `lastSeq` and add cost without value. The helper is intentionally for "WS stays open across respawn" only.

## Test coverage

- `tests/restart-preserves-streaming-frame.test.ts` — pins the original two sites; unchanged.
- `tests/sandbox-recovery-respawn-helper.test.ts` — drives `_respawnAgentInPlace` against a fake `SessionInfo` + fake client, asserts `_highestSeq` and `_lastStatusVersion` carry-over for the sandbox-recovery shape (no `_overrideAllowedTools`).
- `tests/sandbox-recovery-preserves-streaming-frame.test.ts` — end-to-end on the `recoverSandboxSessions` path.
- `tests/manual-integration/sandbox-recovery-frame-continuity.spec.ts` — real Docker: starts a sandboxed session, advances `seq` / `statusVersion`, `docker rm -f`s the project container, drives one more turn, asserts post-recovery events reach the client.

## When to extend this

If you add a new code path that rebuilds `SessionInfo` while clients stay attached:

1. Route it through `_respawnAgentInPlace`. Don't reimplement the dance.
2. Pass a `mutatePs` callback if you need to thread overrides (saved tools, role change) into `restoreSession`.
3. Optionally pass `finalStatus` if "idle" isn't the right post-respawn status.
4. Add an entry to the table above.

If you add a path where clients are NOT attached (boot, dormant revive, archive replay), call `restoreSession` directly. The helper is not a general-purpose wrapper.
