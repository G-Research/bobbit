# Quiet optional probes

Some UI reads are probes: the requested session or goal should exist, but the data being checked is optional. A fresh session usually has no prompt draft, and local/manual branches may have no eligible GitHub PR target. Treating those definitive expected absences as `404` makes healthy UI flows look like failed network requests in browser consoles.

Quiet optional probe mode gives the UI an explicit no-noise path without hiding missing parents, unavailable worktrees, or meaningful coordinator state. Prompt drafts retain their legacy bare-request contract. Coordinated PR routes distinguish a definitive absence from a lookup that is cold, in flight, or failed.

## Opt-in flag

Append `optional=1` to a supported probe request:

```http
GET /api/sessions/:id/draft?type=prompt&optional=1
GET /api/sessions/:id/pr-status?optional=1
GET /api/goals/:id/pr-status?optional=1
```

The flag changes only the definitive-absence outcomes listed below. It does not suppress coordinator envelopes or other endpoint errors.

## Status contract

### Prompt drafts

| State | Bare request | `optional=1` |
|---|---:|---:|
| Draft present | `200` with `{ type, data }` | `200` with `{ type, data }` |
| Existing session, draft absent | `404` draft not found | `204 No Content` |
| Session absent | `404` session not found | `404` session not found |
| `type` query parameter absent | `400` | `400` |

### Coordinated PR status

The session and goal PR routes share this state matrix:

| State | Bare request | `optional=1` |
|---|---:|---:|
| Target is ineligible or its repository/head identity cannot be resolved | `404` no PR found | `204 No Content` |
| Eligible snapshot is cold or a refresh is in flight | `200` snapshot envelope | `200` snapshot envelope |
| Eligible lookup failed, with or without last-good data | `200` snapshot envelope with `lastError` | `200` snapshot envelope with `lastError` |
| Eligible lookup definitively found no PR | `200` snapshot envelope with `data: null` | `204 No Content` |
| PR found | `200` snapshot envelope with PR `data` | `200` snapshot envelope with PR `data` |
| Session or goal absent | `404` | `404` |
| Host working directory absent | `404` | `404` |
| Goal has no Git worktree, or the session is a Headquarters session | `409` Git unavailable response | `409` Git unavailable response |

A `204` therefore means the route has established a definitive expected absence: either there is no eligible coordinator target or a successful eligible lookup found no PR. It has no JSON body; never call `res.json()` on it.

By contrast, `200` with absent `data` does **not** establish that no PR exists. It represents a cold, in-flight, or cold-failed eligible lookup whose freshness or error metadata remains useful. See [Coordinated remote-state status](rest-api.md#coordinated-remote-state-status) for request intents and the exact envelope, and [Remote-state coordinator](remote-state-coordinator.md) for identity, call-budget, failure-retention, and redaction rules.

## Client handling

Use quiet mode only for optional UI polling or badge refreshes where definitive absence is normal. Callers that need to distinguish an ineligible or unresolved PR target as `404` should keep using the bare endpoint. Both modes must still consume `200` coordinator envelopes for cold, in-flight, failed, and found states.

Handle `204` before parsing JSON:

```ts
const res = await gatewayFetch(`/api/goals/${goalId}/pr-status?optional=1`);
if (res.status === 204) return null;
if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
return await res.json();
```

The same parse guard applies to prompt draft restore and session PR status refresh. After a non-`204` PR response, inspect the snapshot metadata and `data` according to the matrix above rather than treating every missing `data` field as "no PR."
