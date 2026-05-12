# Context compaction

When a session's transcript grows too large for the active model's context
window, Bobbit can fold older turns into a shorter summary — *compaction*.
The transcript keeps moving forward, the user keeps their conversation
history in the UI, and the agent stops bleeding tokens on every turn.

This page documents the **client-facing** surface: the two triggers, the
rich summary card that appears in the transcript, how it round-trips across
navigation and reload, and the two test entrypoints. Server-side mechanics
(how the agent subprocess actually compacts, refresh-after-compaction RPC)
live in [internals.md](internals.md).

## Triggers

Compaction has two entrypoints on the client:

- **Manual** — the user types `/compact` in the prompt box. The slash
  command appends a `compact_cmd_*` user message, starts the blob squash
  animation, and RPC-calls the server's `compactRpc`. Wired in
  `src/ui/components/AgentInterface.ts` (`/compact` handler) and
  `src/server/agent/rpc-bridge.ts` (`compactRpc`).
- **Auto** — the agent subprocess emits `auto_compaction_start` when its
  pre-turn budget check decides another turn would blow the context window.
  Handled in `src/app/remote-agent.ts` alongside the manual path; the client
  normalises `auto_compaction_*` events into the same `compaction_start` /
  `compaction_end` shape so downstream code does not have to fork.

Both paths end with the same `compaction_end` event carrying
`tokensBefore`, a `success` flag, and (on failure) an `error` string.

## The rich summary card

Until this feature shipped, the transcript marker for a finished compaction
was a plain assistant text message — `"Context compacted from 12k tokens."`.
That worked but lost the trigger, the verdict, the timestamp, and any
sense of *how much* was actually reclaimed.

The new card replaces that text with a synthetic tool render. Surface:

- Tokens before / tokens after (em-dash when unknown).
- Reduction percentage (omitted when either count is unknown).
- Trigger pill — `manual` or `auto`.
- Success tick or failure cross plus the error string when it failed.
- Local timestamp from the client's `compaction_end`.

### Why a synthetic tool, not a new message role

The card piggybacks on Bobbit's existing tool-renderer machinery. The
synthetic assistant message carries a single `toolCall` block whose `name`
is `__compaction_summary`, plus a paired `toolResult`. Two leading
underscores keeps it off the real-tool registry — the LLM never sees this
"tool", it never appears in any role's tool list, and it does not consume
any token budget (the description-budget test walks `defaults/tools/`
extensions, not UI renderers).

Using `role: "assistant"` with a `toolCall` content block — rather than
inventing a new message role — means every existing reducer rule (ordering,
dedup, snapshot reconciliation) keeps applying uniformly.

### Test hooks

The renderer (`src/ui/tools/renderers/CompactionSummaryRenderer.ts`)
emits these stable selectors so e2e tests do not have to match on text:

| Selector | Purpose |
| --- | --- |
| `[data-testid="compaction-summary-card"]` | Card root. |
| `[data-test="tokens-before"]` | Before-token value. |
| `[data-test="tokens-after"]` | After-token value (or em-dash). |
| `[data-test="reduction-pct"]` | Reduction badge (when known). |
| `[data-test="trigger"]` | Trigger pill — text content is `manual` or `auto`. |
| `[data-test="verdict"]` | Tick or cross icon. |

### Payload shape

The payload type and envelope builder live in
`src/app/compaction-types.ts`:

```ts
interface CompactionSummaryPayload {
  schemaVersion: 1;
  trigger: "manual" | "auto";
  success: boolean;
  timestamp: string;            // ISO-8601
  tokensBefore: number | null;
  tokensAfter: number | null;   // null when the post-compaction snapshot
                                // has not landed yet (see "tokensAfter" below)
  reductionPct: number | null;  // null when either count is null
  error?: string;               // failure detail
}
```

`schemaVersion: 1` is reserved for forward compatibility — bump it if a
future renderer adds fields that older snapshots cannot supply.

### Why `tokensAfter` is often `null`

The server emits `compaction_end` *before* it broadcasts the
post-compaction state refresh, and there is no post-compaction usage count
on the `compaction_end` frame itself. The client samples its best-known
context-token count at the moment it applies `compaction-result`. If the
refresh has not landed yet, `tokensAfter` stays `null` and the card shows
`after —` with no reduction badge. The user can still see the new context
fill on the usage bar a moment later. A follow-up amend-action could
back-fill the field, but v1 accepts the null and keeps the reducer simple.

## Round-tripping across navigation and reload

Compaction produces two artefacts:

1. The **live, rich synthetic** the client builds in `remote-agent.ts`
   from the `compaction_end` event.
2. The agent subprocess's own **plain-text marker** — a row whose text
   starts with `"Context compacted"`. This row is part of the transcript
   the server returns on every snapshot. We cannot edit the upstream
   agent from this PR, so the marker is here to stay.

If the reducer treated those as independent rows the user would see a
double — the card *and* the text — every time a snapshot landed after a
live compaction. The dedup logic in `src/app/message-reducer.ts`
(`compaction-result` action plus the `snapshot` merge) resolves this with
a two-way rule:

- **Live path — rich wins.** When the snapshot arrives and a rich
  synthetic for that compaction already exists, the server's plain-text
  marker is dropped from the merged result.
- **Reload path — server text is upgraded.** On a fresh page load there
  is no live synthetic. The reducer recognises the server's plain-text
  marker via `isServerCompactionTextMarker`, parses `tokensBefore` out of
  the formatted string with `parseTokensBeforeFromServerMarker`, and
  replaces the row in place with a rich synthetic via
  `upgradeServerCompactionMarker`. `tokensAfter` and `reductionPct` stay
  `null` (the marker text does not carry them); `trigger` defaults to
  `manual` because the row alone cannot disambiguate.

The "rich wins on live, server-wins-by-upgrade on reload" split exists
because the two sides have different information. The live event knows
the trigger and (post-refresh) the after-count. The persisted server row
knows nothing structural — only the formatted text. Upgrading the server
row preserves position and id while attaching whatever structure can be
recovered from the text.

These invariants are pinned by `tests/message-reducer.test.ts` cases 12,
12b, and 12c. The text-prefix parser is intentionally coupled to the
pi-coding-agent transcript format; case 12c's token-value assertion is
the regression sentinel if that format ever changes.

## Tests

Two new lanes cover compaction end to end.

### Real-LLM e2e

`tests/compaction.spec.ts` runs under `tests/playwright-e2e.config.ts`,
which spawns an isolated gateway on **port 3097** with
`BOBBIT_DIR=.e2e-real-bobbit` so it cannot collide with the dev
server's state. The test:

1. Creates a project + session against the isolated gateway.
2. Knocks down the model's `contextWindow` via `models.json` so a few
   prompts are enough to fill it (cheap and deterministic — does not
   depend on the model's real window).
3. Drives `/compact` from the prompt box.
4. Asserts the rich card renders (via the `data-testid` hook above) with
   no console errors and no error toast.
5. Navigates to a second session and back — card still there.
6. Reloads the page — card still there, materialised via the reload-path
   upgrade described above.

Run it with:

```bash
npm run test:e2e:real
```

This script (`package.json`) is separate from `npm run test:e2e`, which
uses the root `playwright-e2e.config.ts`. The real-LLM lane needs an API
key, so it is opt-in rather than part of the default e2e run.

### Manual-integration pressure test

`tests/manual-integration/compaction-pressure.spec.ts` exercises the
**real auto-compaction** path with real agents and Docker. It pushes a
session near the actual context limit, waits for the agent subprocess to
fire `auto_compaction_start` on its own, asserts the card renders with
`data-test="trigger"` reading `auto`, then sends one more prompt and
checks the agent keeps working post-compact. Runtime is roughly the same
as the rest of the manual suite (~5 min).

Run it with:

```bash
npm run test:manual
```

## Files

| Concern | File |
| --- | --- |
| Payload type + envelope builder + reload-upgrade helpers | `src/app/compaction-types.ts` |
| Live emission (manual + auto) | `src/app/remote-agent.ts` — `compaction_end` / `auto_compaction_end` |
| Reducer (placeholder, result, snapshot dedup, reload upgrade) | `src/app/message-reducer.ts` — `compaction-result` and `snapshot` cases |
| Renderer | `src/ui/tools/renderers/CompactionSummaryRenderer.ts` |
| Renderer registration | `src/ui/tools/index.ts` — `__compaction_summary` |
| Reducer unit tests | `tests/message-reducer.test.ts` — cases 12, 12b, 12c |
| Real-LLM e2e | `tests/compaction.spec.ts`, `tests/playwright-e2e.config.ts` |
| Manual-integration pressure test | `tests/manual-integration/compaction-pressure.spec.ts` |
| Full design rationale | `docs/design/compaction-e2e-rich-summary.md` |
