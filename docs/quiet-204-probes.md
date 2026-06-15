# Quiet optional probes

Some UI reads are probes: the requested session or goal should exist, but the data being checked is optional. A fresh session usually has no prompt draft, and local/manual branches often have no GitHub PR. Treating those expected absences as `404` makes healthy UI flows look like failed network requests in browser consoles.

Quiet optional probe mode keeps the legacy API contract for normal callers while giving the UI an explicit no-noise path.

## Opt-in flag

Append `optional=1` to a supported probe request:

```http
GET /api/sessions/:id/draft?type=prompt&optional=1
GET /api/sessions/:id/pr-status?optional=1
GET /api/goals/:id/pr-status?optional=1
```

Only these absence cases are quieted. Bare requests keep their existing `404` behavior.

## Status contract

| Endpoint | Bare absence | `optional=1` expected absence | Missing parent |
|---|---:|---:|---:|
| `GET /api/sessions/:id/draft?type=prompt` | `404` draft not found | `204 No Content` | `404` session not found |
| `GET /api/sessions/:id/pr-status` | `404` no PR found | `204 No Content` | `404` session not found |
| `GET /api/goals/:id/pr-status` | `404` no PR found | `204 No Content` | `404` goal not found |

`204` responses have no JSON body. Do not call `res.json()` on them.

Quiet mode does not hide real lookup failures. If the session or goal id is invalid, or the parent resource is otherwise unavailable, the endpoint still returns `404`.

## Client handling

Use quiet mode only for optional UI polling or badge refreshes where absence is normal. Callers that need a hard not-found signal should keep using the bare endpoint.

Handle `204` before parsing JSON:

```ts
const res = await gatewayFetch(`/api/goals/${goalId}/pr-status?optional=1`);
if (res.status === 204) return null;
if (!res.ok) throw await errorFromResponse(res, `Failed: ${res.status}`);
return await res.json();
```

The same pattern applies to prompt draft restore and session PR status refresh. This prevents expected absence from surfacing as browser-console errors while preserving real errors for diagnostics.
