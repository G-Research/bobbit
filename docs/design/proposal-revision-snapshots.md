# Proposal Revision Snapshots

Status: design — ready to implement.
Owner: single-coder task.
Related: [docs/design/editable-proposals.md](./editable-proposals.md), [docs/internals.md — Editable proposals](../internals.md#editable-proposals).

## Problem

When an agent emits multiple `propose_*` and `edit_proposal` calls in the same session, the chat transcript shows multiple cards but the preview panel only ever holds the latest revision on disk (`.bobbit/state/proposal-drafts/<sessionId>/<type>.{md,yaml}`). Two concrete UX failures:

1. `edit_proposal` has no tool renderer — falls through to `DefaultRenderer`, no "Open proposal" button.
2. `propose_*` "Open proposal" loads the in-flight tool params, not a snapshot. Clicking the *original* propose card after subsequent edits silently rolls the live draft back to the original payload — destroying every later edit.

## Goal

Every proposal-mutating tool call (`propose_*` and `edit_proposal`) renders a card whose "Open proposal" button restores the proposal panel to *exactly* the revision that existed immediately after that call. Clicking an older card writes the snapshot's contents back to the live draft as a *new* snapshot (`rev = currentRev + 1`) — discoverable history, monotonic counter, no silent rollback.

## Non-goals

- Generic snapshot/history UI for non-proposal tools.
- Diff visualization beyond compact `old_text → new_text` on the edit card.
- User-facing revision picker / timeline view inside the proposal panel itself — the chat cards *are* the timeline.
- Concurrent-edit handling (a session has one agent at a time).
- `propose_workflow`. The codebase has 5 proposal types: `goal | project | role | tool | staff`. Confirmed via `PROPOSAL_TYPES` in `src/server/proposals/proposal-files.ts` and `PROPOSAL_TOOL_NAMES` in `src/ui/tools/index.ts`. The tool extension still declares `workflow` in its enum but registers no `propose_workflow` tool — leave that surface untouched.

## On-disk layout

**Per-rev files** under a `<type>.history/` subdir:

```
<stateDir>/proposal-drafts/<sessionId>/
  goal.md                       ← live draft (unchanged)
  goal.history/
    1.md
    2.md
    3.md
  project.yaml
  project.history/
    1.yaml
    2.yaml
```

Justification (vs single append-only `<type>.history.jsonl`):

- Reuses the existing tmp-file + `fs.rename` atomic write helpers in `proposal-files.ts` verbatim. Append-only JSONL needs new fsync/append discipline and partial-line recovery code we don't have.
- Trivially survives partial writes — a half-written `<rev>.<ext>.tmp` is invisible to the rev scan and cleaned up on next mkdir.
- Identical extension to the live draft — same plugin parser/serializer applies, no encoding shim.
- Cleanup is free: the per-session draft dir is reaped by `purgeOneSession` at the 7-day mark (deferred from archive by the [archived-proposal-reopen feature](../archived-proposal-reopen.md), so Path A / Path B can still read the snapshots after archive); the `<type>.history/` subdir goes with it.
- Restart-safe rev recovery is one `readdir` + `parseInt` reduce — no metadata file to keep in sync.

The cost — one inode per rev — is negligible (proposals are typically <10 KB each, history bounded by session lifetime, dir blown away on session terminate).

## Rev counter source of truth

**Server-side, implicit.** The current rev for `(sessionId, type)` is the maximum integer parsed from filenames in `<type>.history/`. No metadata file. `writeSnapshot` computes `latestRev() + 1`, then atomically writes `<that>.<ext>`. Restored on server restart by re-scanning the dir on first access.

Filename grammar: `^(\d+)\.(md|yaml)$`. Anything else is ignored. Leading zeros not used; integer parse with `Number.isFinite` guard.

## API surface — `src/server/proposals/proposal-files.ts`

New helpers (all paths under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/`):

```ts
/** Write <rev>.<ext> atomically. Caller passes the rev (typically latestRev+1). */
export async function writeSnapshot(
  stateDir: string,
  sessionId: string,
  type: ProposalType,
  rev: number,
  content: string,
): Promise<void>;

/** Read snapshot content, or undefined if missing. */
export async function readSnapshot(
  stateDir: string,
  sessionId: string,
  type: ProposalType,
  rev: number,
): Promise<string | undefined>;

/** Scan history dir; return the highest integer rev, or 0 if empty/missing. */
export async function latestRev(
  stateDir: string,
  sessionId: string,
  type: ProposalType,
): Promise<number>;

/**
 * Copy snapshot N back to the live draft AND write a new snapshot at currentRev+1
 * whose contents equal snapshot N. Returns the new rev and the parsed fields.
 * Atomic via the same tmp+rename pattern. ENOENT on the source snapshot returns
 * { ok: false, code: "SNAPSHOT_NOT_FOUND" } (not thrown).
 */
export async function restoreSnapshot(
  stateDir: string,
  sessionId: string,
  type: ProposalType,
  rev: number,
): Promise<
  | { ok: true; newRev: number; fields: Record<string, unknown> }
  | { ok: false; code: "SNAPSHOT_NOT_FOUND"; message: string }
  | ParseError
>;
```

### Hooking into the existing write paths

**`writeProposalFile`** — extend to return `Promise<{ rev: number }>`. After the existing live-file rename succeeds, it computes `rev = (await latestRev(...)) + 1` and calls `writeSnapshot(..., rev, content)`. Snapshot-write failure is *non-fatal* — log and return `rev: 0` (signals "snapshot disabled" to the caller; live draft is still intact). Callers must update to `await writeProposalFile(...)` and read `.rev` if they need to broadcast it.

**`editProposalFile`** — extend `EditSuccess` to `{ ok: true; newContent: string; parsed: TypedProposal; rev: number }`. Same logic: after live rename succeeds, write snapshot. Failed edits (any of the existing error codes) do *not* bump rev and do *not* write a snapshot — the file on disk is already byte-for-byte unchanged, so the invariant is preserved.

**`restoreSnapshot`** — internally:
1. `readSnapshot(rev)` → fail with `SNAPSHOT_NOT_FOUND` if missing.
2. Validate via `plugin.parse(content)` — if it fails (corruption), return `ParseError`.
3. Compute `newRev = (await latestRev()) + 1`.
4. `fsp.writeFile(<live>.tmp, content)` → `fsp.rename` to live path.
5. `writeSnapshot(..., newRev, content)`.
6. Return `{ ok: true, newRev, fields: parsed.value.fields }`.

The mid-session crash window between live rename and snapshot write leaves a live draft 1 rev ahead of the history dir — benign; the next write recomputes `latestRev` from the dir (which still tops out at `currentRev`), so it picks `currentRev + 1` again. The live draft contents agree with that snapshot, so observable state stays consistent.

## WS protocol — `src/server/ws/protocol.ts`

Extend `proposal_update` with `rev: number`. Stamped by every emitter:

```ts
| { type: "proposal_update";
    sessionId: string;
    proposalType: "goal" | "project" | "role" | "tool" | "staff";
    fields: Record<string, unknown>;
    rev: number;                                          // NEW
    streaming: false;
    source: "edit" | "seed" | "rehydrate" | "restore";   // "restore" added
  }
```

No new event type. Restore reuses `proposal_update` with `source: "restore"`. The existing `proposal_cleared` event is unchanged.

## REST endpoint — `src/server/server.ts`

Add inside the existing proposal route block (~L5750), update the regex to accept the new suffix:

```
^/api/sessions/([^/]+)/proposal/([^/]+)(/edit|/seed|/restore)?$
```

`POST /api/sessions/:id/proposal/:type/restore`

Body: `{ rev: number }`.

Responses:

| Status | Body |
|---|---|
| 200 | `{ ok: true, newRev: number, fields: Record<string, unknown> }` |
| 400 | `{ ok: false, code: "INVALID_BODY", message }` (rev not a non-negative integer) |
| 404 | `{ ok: false, code: "SNAPSHOT_NOT_FOUND", message }` |
| 400 | `ParseError` shape on snapshot parse failure |
| 500 | `{ error }` on unexpected throw |

On 200, broadcast a `proposal_update` with `source: "restore"`, `fields = result.fields`, `rev = result.newRev`. The client's existing `onProposal` callback handles the panel rebuild — no extra plumbing.

### Stamping `rev` on the existing seed/edit broadcasts

- `seed` handler: add `rev: writeResult.rev` to the broadcast payload, return it in the JSON body too: `{ ok: true, rev }`.
- `edit` handler: add `rev: result.rev` to broadcast and to the JSON body: `{ ok: true, newContent, rev }`.
- WS `rehydrate` path in `src/server/ws/handler.ts` (~L328): after `parseProposalFile` succeeds, call `latestRev(stateDir, sessionId, proposalType)` and stamp `rev` on the rebroadcast payload. If `latestRev` returns 0 (e.g. legacy session with a draft but no history dir), use 0 — clients treat 0 as "snapshot system unavailable for this draft".

## Tool extension — `defaults/tools/proposals/extension.ts`

The seed and edit gateway calls already return JSON. Read `rev` from the response body and embed it in the tool-result text via a structured marker:

```
__proposal_rev_v1__:<integer>
```

Format choice mirrors the `__preview_snapshot_v1__` marker used by the preview tool: a single line, prefix-anchored, easy to grep with a regex `/__proposal_rev_v1__:(\d+)\b/`. The marker is appended to the existing ack text so the `propose_*` cards still show "Proposal submitted. Waiting for user response." human-side; renderers strip it before display.

### `seedProposal` (propose_*)

```ts
async function seedProposal(type, args): Promise<number | undefined> { ... }
```

Returns the parsed `rev` from the seed response (`undefined` on failure). Each `propose_*` `execute()` becomes:

```ts
async execute(_id, args) {
  const rev = await seedProposal("goal", args);
  return ack(rev);
}

function ack(rev?: number) {
  const lines = ["Proposal submitted. Waiting for user response."];
  if (typeof rev === "number" && rev > 0) lines.push(`__proposal_rev_v1__:${rev}`);
  return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
}
```

### `edit_proposal`

The existing implementation already passes through the gateway JSON body. Extend it to additionally append the marker on success (when `bodyJson.ok === true && typeof bodyJson.rev === "number"`):

```ts
const isError = status < 200 || status >= 300;
let text = bodyJson !== undefined ? JSON.stringify(bodyJson, null, 2) : bodyText;
if (!isError && bodyJson && typeof (bodyJson as any).rev === "number") {
  text += `\n__proposal_rev_v1__:${(bodyJson as any).rev}`;
}
return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
```

Failed edits (4xx) keep their structured error body but get *no* marker — renderer treats absence of marker as "not restorable".

## Renderer changes

### `src/ui/tools/renderers/ProposalRenderer.ts`

- New module-private helper `parseRevFromResult(result: ToolResultMessage | undefined): number | undefined` — scans `result.content` for the regex `/__proposal_rev_v1__:(\d+)\b/`, returns the integer or undefined.
- In `render()`, after the `result` truthy check, parse `rev` once.
- "Open proposal" button:
  - With `rev`: dispatch `proposal-open` with `{ type, rev }` (no `fields`).
  - Without `rev` (legacy archived sessions): keep dispatching `{ type, fields }`.
- Optional cosmetic: render `rev N` next to the title when present.

### `src/ui/tools/renderers/EditProposalRenderer.ts` (new)

```ts
export class EditProposalRenderer implements ToolRenderer {
  render(params, result, isStreaming): ToolRenderResult {
    const state = getToolState(result, isStreaming);
    const { type, old_text, new_text } = parseParams(params) ?? {};
    const rev = parseRevFromResult(result);
    const errCode = parseErrorCodeFromResult(result); // reads JSON body for `code`
    const isFailure = !!result?.isError || (result && rev === undefined);

    return {
      content: html`
        <div class="space-y-2">
          ${renderHeader(state, FileText, `Edit ${type ?? ""} proposal`)}
          <div class="text-xs space-y-1 font-mono">
            <div><span class="text-red-500">−</span> ${truncate(old_text ?? "", 120)}</div>
            <div><span class="text-green-500">+</span> ${truncate(new_text ?? "", 120)}</div>
          </div>
          ${rev !== undefined ? html`<div class="text-xs text-muted">rev ${rev}</div>` : ""}
          ${isFailure && errCode ? html`<div class="text-xs text-red-500">${errCode}</div>` : ""}
          ${result && rev !== undefined ? html`
            <div class="flex justify-end">
              <button @click=${(e: Event) => {
                e.preventDefault(); e.stopPropagation();
                document.dispatchEvent(new CustomEvent("proposal-open", {
                  detail: { type, rev },
                }));
              }} class="...">Open proposal</button>
            </div>
          ` : ""}
        </div>
      `,
      isCustom: false,
    };
  }
}
```

Truncation: ~120 chars each, with `…` ellipsis. Whitespace preserved (font-mono).

### `src/ui/tools/index.ts`

```ts
import { EditProposalRenderer } from "./renderers/EditProposalRenderer.js";
registerToolRenderer("edit_proposal", new EditProposalRenderer());
```

`view_proposal` keeps its DefaultRenderer fallback — no card UX needed.

## Client wiring — `src/app/session-manager.ts`

`proposalOpenHandler` (~L1227) gains a branch on `detail.rev`:

```ts
const proposalOpenHandler = (async (e: CustomEvent) => {
  if (activeSessionId() !== sessionId) return;
  const { type, fields, rev } = e.detail || {};
  if (!type || !isProposalType(type)) return;
  clearProposalDismissedTyped(sessionId, type);

  if (typeof rev === "number" && Number.isFinite(rev) && rev > 0) {
    // Snapshot restore — server is authoritative; broadcast rebuilds the slot.
    try {
      const res = await api.restoreProposalSnapshot(sessionId, type, rev);
      if (!res.ok) {
        // Surface SNAPSHOT_NOT_FOUND as a small toast or console.warn —
        // do not fall back to legacy fields path (snapshot really is gone).
        console.warn(`[proposal] restore failed: ${res.code}`);
      }
      // proposal_update broadcast handles slot population via remote.onProposal.
    } catch (err) {
      console.warn("[proposal] restore threw:", err);
    }
    return;
  }

  // Legacy path (archived sessions with no rev marker): existing fields fan-out.
  if (!fields) return;
  const callbackMap = { goal: remote.onGoalProposal, role: remote.onRoleProposal,
    tool: remote.onToolProposal, staff: remote.onStaffProposal,
    project: remote.onProjectProposal };
  const cb = callbackMap[type];
  if (cb) cb(fields, false);
  if (remote.onProposal) remote.onProposal(type, fields, false);
}) as EventListener;
```

Add `restoreProposalSnapshot(sessionId, type, rev)` to `src/app/api.ts` — POSTs to `/api/sessions/:id/proposal/:type/restore` with `{ rev }` body, returns the typed JSON.

### Slot rev field

`ProposalSlot.rev` already exists (`src/app/proposal-registry.ts:28`). The unified `onProposal` reducer must overwrite `slot.rev` with the server-stamped `rev` from the WS event (rather than the client-incremented value) so the panel header reflects the authoritative server rev. Find the slot-update site in `proposal-helpers.ts` / `onProposal` callback and assign `slot.rev = event.rev` whenever the event carries one.

## Visual indicator — `src/app/render.ts`

Both `goalProposalPanel()` (~L1813) and `projectProposalPanel()` (~L1590) and the role/tool/staff panels gain a small badge near the title:

```ts
const slot = state.activeProposals[type];
const revBadge = slot && slot.rev > 0
  ? html`<span class="text-xs text-muted ml-2">rev ${slot.rev}</span>`
  : "";
```

Place adjacent to the existing title heading. No clickable affordance — purely informational.

## Restart survival

- Snapshots live alongside drafts under the per-session dir → reaped together with the live draft on the 7-day purge. (Archive itself does **not** delete the directory — the archived-proposal-reopen flow needs the snapshots on disk so a cloned assistant session can resume from the latest rev. See [docs/archived-proposal-reopen.md](../archived-proposal-reopen.md).)
- WS-attach rehydrate (`src/server/ws/handler.ts` ~L328) reads the latest live draft and now also calls `latestRev(...)` to stamp `rev` on the rebroadcast `proposal_update {source: "rehydrate"}`. If the history dir is missing (legacy session predating this change), `rev = 0` — client treats as "no snapshots available" but panel still renders.

## Edge cases

| Case | Behavior |
|---|---|
| Streaming partial fields (dual-fire path in `_checkToolProposals`) | Does NOT touch disk → no spurious rev bumps. Confirmed: the streaming path emits in-memory `proposal_update` from the client's WS observer of in-flight tool calls; only the gateway-side `seed` POST writes the file. |
| Failed `edit_proposal` (e.g. `OLD_TEXT_NOT_FOUND`) | Atomic rollback already in place; no snapshot written; renderer shows error code without "Open proposal" button. |
| Concurrent edits | Out of scope. |
| Workflow type | Excluded — codebase has 5 types. |
| Restore of nonexistent rev | `SNAPSHOT_NOT_FOUND` 404; client logs warning, does not fall back to legacy `fields` path. |
| Mid-restore crash between live rename and snapshot write | Live draft is 1 rev ahead of dir; next write picks `currentRev + 1` (same number) and overwrites — observable state remains consistent. |
| Snapshot file corruption | `restoreSnapshot` returns `ParseError`; live draft untouched. |
| Legacy archived sessions (no `__proposal_rev_v1__` marker on old transcripts) | Renderer falls back to dispatching `{ type, fields }`; existing fields-roundtrip behavior preserved. No new bug, no new fix path needed. |
| Snapshot dir disk-full / write fails | Snapshot write is non-fatal — live draft committed, `rev: 0` returned, broadcast carries `rev: 0`, client treats slot as "snapshot disabled". User experience degrades to current behavior; no crash. |

## Testing plan

### Unit — `tests/proposal-files-snapshots.test.ts` (new)

- `writeProposalFile` returns monotonically increasing `rev` (1, 2, 3) across calls.
- `editProposalFile` increments rev on success; failed edits do not.
- `latestRev` returns 0 on empty/missing history dir; max integer otherwise; ignores garbage filenames.
- `readSnapshot` returns content; `undefined` on missing rev.
- `restoreSnapshot` round-trip: write rev 1 with fields A, edit to fields B (rev 2), restore rev 1 → produces rev 3 with fields A; live draft equals fields A.
- Cleanup: `rm -rf <session dir>` removes both live and history.

### Unit — renderer tests (Playwright file:// fixture)

- `ProposalRenderer` extracts rev from result content; "Open proposal" dispatches `{ type, rev }` with rev present and `{ type, fields }` without.
- `EditProposalRenderer` renders truncated old/new text (>120 chars → ellipsis); shows error code on failure; omits button when no rev.

### Browser E2E — `tests/e2e/ui/proposal-revision-snapshots.spec.ts` (new)

Four-step pattern:

1. **Navigate** — open a session, mock-agent emits `propose_goal` then two `edit_proposal` calls. Three cards appear in the transcript.
2. **Happy path** — click the *first* propose card → panel shows fields from rev 1, header reads `rev 3` (restore writes rev 3 with rev 1's contents). Click the second edit card → panel shows rev 2 contents, header reads `rev 4`. Accept proceeds via the existing flow.
3. **Persistence** — reload the page; the panel rehydrates with the latest rev (rev 4). Earlier-card clicks still work.
4. **Cleanup** — terminate the session; assert `<stateDir>/proposal-drafts/<sessionId>/` is gone (history subdirs included).

## Implementation checklist

1. `src/server/proposals/proposal-files.ts` — add `writeSnapshot`, `readSnapshot`, `latestRev`, `restoreSnapshot`; extend `writeProposalFile` and `editProposalFile` signatures to return `rev`.
2. `src/server/server.ts` — extend proposal regex; add `/restore` handler; stamp `rev` on `seed` and `edit` JSON bodies and broadcasts.
3. `src/server/ws/protocol.ts` — add `rev: number` and `"restore"` source variant to `proposal_update`.
4. `src/server/ws/handler.ts` — stamp `rev` on rehydrate broadcast.
5. `defaults/tools/proposals/extension.ts` — `seedProposal` returns rev; both ack texts include `__proposal_rev_v1__:N`; `edit_proposal` execute appends marker on success.
6. `src/ui/tools/renderers/ProposalRenderer.ts` — parse marker; conditional `rev` vs `fields` dispatch.
7. `src/ui/tools/renderers/EditProposalRenderer.ts` — new file.
8. `src/ui/tools/index.ts` — register `edit_proposal` renderer.
9. `src/app/api.ts` — `restoreProposalSnapshot` helper.
10. `src/app/session-manager.ts` — `proposalOpenHandler` rev branch.
11. `src/app/proposal-helpers.ts` (or wherever `onProposal` reducer lives) — slot.rev := event.rev.
12. `src/app/render.ts` — `rev N` badge in each proposal panel.
13. Tests as above.

## Constraints respected

- All changes confined to: `src/server/proposals/`, `src/server/server.ts` (proposal route block), `src/server/ws/{protocol,handler}.ts`, `defaults/tools/proposals/`, `src/ui/tools/renderers/`, `src/ui/tools/index.ts`, `src/app/{session-manager,api,proposal-helpers,proposal-registry,render}.ts`.
- `propose_*` tool parameter schemas unchanged.
- Existing `mergeFields` shallow-merge behavior preserved — restore writes a full snapshot to the live draft, so the subsequent `proposal_update` carries a complete `fields` payload and merge is idempotent.
- AGENTS.md "Edit a proposal mid-session / proposals as files" entry verified — atomic rename, structured error codes, per-session dir cleanup, and dual-fire streaming path all map cleanly onto this design.
