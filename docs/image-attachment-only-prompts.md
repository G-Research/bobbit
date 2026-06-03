# Image / attachment-only prompts

How Bobbit handles a prompt that carries **only** an image or other attachment with no text body (or only whitespace), and how it recovers sessions that were already broken by the bug this feature fixes.

## The problem

The model API rejects a user message whose `ContentBlock` has a blank `text`
field — either next to an image block (`[{text:""},{image}]`) or as a standalone
empty text block (`[{text:""}]`). When a user attached an image and sent it with
no typed text, Bobbit forwarded `{ type: "prompt", message: "", images }` to the
agent, which built exactly such an invalid message. The user saw:

> Validation error: the text field in the ContentBlock at messages … is blank.
> Add text to the text field and try again.

Worse, the failure was **self-perpetuating**. The blank-text user message was
committed to the agent's persisted `.jsonl` transcript. Every later turn
re-sends the whole history, so the blank block was replayed and re-rejected on
each retry — even retries that *did* include text. The session became a
permanent blocker that no follow-up prompt could clear.

## The fix has two halves

1. **Source prevention** — synthesize a non-blank text body at dispatch time so
   no new attachment-only prompt can ever commit a blank block.
2. **Recovery** — un-poison sessions (and transcripts) that already committed a
   blank block before the fix existed, so they stop replaying it.

The synthetic body is the exact phrase `Attachments:`, defined once as
`ATTACHMENT_ONLY_TEXT` in `src/server/agent/rpc-bridge.ts`.

---

## Half 1 — source prevention

### `synthesizeAttachmentText` (the rule)

`synthesizeAttachmentText(text, images?, attachments?)` in `rpc-bridge.ts` is the
single source of truth for "an attachment-only prompt must carry non-blank
text". The rule:

- If `text` is non-blank after `trim()`, return it unchanged.
- Otherwise, if there is at least one image **or** attachment, return
  `ATTACHMENT_ONLY_TEXT` (`"Attachments:"`).
- Otherwise (blank text, no attachments) return `text` unchanged.

Trimming first means **whitespace-only** text counts as blank. Normal text,
text+image, and empty-with-no-attachments prompts all pass through untouched, so
this never regresses the common paths.

### Applied at the dispatch boundary

The helper is called once in `SessionManager.enqueuePrompt`
(`src/server/agent/session-manager.ts`), which is the single boundary every
prompt flows through. Synthesizing there — rather than at one happy-path call
site — guarantees **every** downstream delivery path inherits valid text:

- **Direct dispatch** (idle agent, empty queue) → `dispatchDirectPrompt`.
- **Queued drain** — the persisted queue row stores the already-synthesized
  dispatch text, so `drainQueue` later sends valid text. See
  [prompt-queue.md](prompt-queue.md).
- **Error-recovery prefix** — when an errored turn is implicitly unstuck, the
  recovery prefix is wrapped around the synthesized text.
- **Retry** — `dispatchDirectPrompt` records the synthesized text as
  `session.lastPromptText`, so a later retry re-sends valid text.

This is why the fix lives at the boundary and not at the WebSocket handler or
the bridge: the queue and retry paths would otherwise still ship blank text.

### Bridge backstop

`RpcBridge.prompt(text, images)` in `rpc-bridge.ts` also runs the text through
`synthesizeAttachmentText` (image case only). This is a defensive backstop for
any direct bridge caller that bypasses `enqueuePrompt`. The primary fix is still
the boundary call — the bridge can only see `images`, not non-image
`attachments`, so it cannot be the single source of truth.

---

## Half 2 — recovering already-broken sessions

A session that hit the validation error *before* this fix shipped still has the
blank block in two places: the **live agent process's in-memory history** and
the **persisted `.jsonl` transcript**. Both must be cleaned, because pi exposes
no history-edit RPC — Bobbit can only repair the transcript it owns and then
make the agent re-read it.

### Detecting the poison

`isBlankContentBlockError(errMsg)` in `session-manager.ts` matches the model's
validation message (`/text field in the ContentBlock/i` and `/is blank/i`). The
error state is captured **before** it is cleared, so the recovery paths know the
prior turn was poisoned by a blank block specifically (vs. any other API error).

### Transcript sanitizer

`src/server/agent/transcript-sanitizer.ts` repairs the persisted `.jsonl`:

- `sanitizeTranscriptContent(content)` is a **pure, idempotent, one-pass**
  rewrite. For each `role:"user"` message whose effective text is blank, it
  rewrites the content to carry `ATTACHMENT_ONLY_TEXT`, covering all shapes:
  string content, an image-adjacent empty text block, a missing text block (a
  leading text block is inserted), and non-string/non-array content. Every other
  line is left **byte-identical**, including trailing-newline shape, so
  re-running is a no-op.
- **Tool results are never touched.** Tool results are also persisted as
  `role:"user"` messages with a `tool_result` / `toolResult` block and no text —
  that is valid history. Rewriting them to `"Attachments:"` would corrupt
  tool-call history and break tool-result ordering, so any user message
  carrying a tool-result block is left byte-identical.

`sanitizeAgentTranscriptFile(...)` wraps the pure function with I/O, called at
the **rehydration boundary** in `session-setup.ts` — just before the
`switch_session` RPC on respawn / continue-archived, so the agent rehydrates
from clean history. It is best-effort and non-fatal: any read/write failure is
swallowed so restore/respawn still proceeds.

#### Sanitizer safety constraints

Because the sanitizer writes to disk based on a persisted (potentially hostile
or malformed) `agentSessionFile` path, the write path is hardened:

- `resolveSafeSessionsPath` is a **symlink/TOCTOU-resistant** resolver: it
  rejects `..` traversal, requires the real parent directory to resolve (via
  `realpathSync`, which follows directory symlinks) inside the real agent
  sessions root, and rejects targets that are symlinks or not regular files.
- The path is validated **before reading** and **re-validated immediately
  before writing**, then written with `O_NOFOLLOW` (where the platform provides
  it) so a symlink swapped in after the check is not followed.
- `isWithinAgentSessionsDir` is a cheaper lexical-only prefix check kept for
  callers/tests that don't need the filesystem-touching variant.
- Sandboxed sessions: the read runs in-container; the write is host-side via the
  bind-mounted sessions dir (container path → host path translation).

### Live process recovery

Sanitizing the transcript is not enough — the **live** agent process still holds
the blank block in memory, so re-prompting the same process would replay and
re-fail. `_recoverBlankTextPoison(session)` respawns the agent in place
(`_respawnAgentInPlace`) so it rehydrates from the now-sanitized `.jsonl`. It
returns `undefined` when there is no persisted transcript to rehydrate from
(e.g. a unit harness), in which case the caller falls back to the normal
synthesized-dispatch path.

Two callers route a poisoned session through recovery:

- **Follow-up prompt** (`enqueuePrompt`'s implicit-unstick path): when the prior
  turn was poisoned, it respawns, then dispatches the follow-up against clean
  history — no recovery prefix needed, because the poisoned turn is gone.
- **Retry** (`retryLastPrompt`): respawns, then re-dispatches the original
  prompt with its image preserved and the text run through
  `synthesizeAttachmentText`.

In both, if the recovered dispatch text is still blank (e.g. a legacy non-image
attachment-only send where attachments aren't tracked on `SessionInfo`), the
code falls back to `ATTACHMENT_ONLY_TEXT` unconditionally rather than re-send
invalid content.

---

## Pinning tests

| Concern | Test |
|---|---|
| `synthesizeAttachmentText` rule (blank/whitespace/text/no-attachment) | `tests/synthesize-attachment-text.test.ts` |
| Dispatch boundary: empty/whitespace text + image → non-blank dispatch; stuck-session retry preserves image | `tests/image-only-prompt-dispatch.test.ts` |
| Stuck-session recovery via respawn + sanitized rehydrate; legacy non-image case; non-poison errors unaffected | `tests/image-only-prompt-unstick-recovery.test.ts` |
| Sanitizer correctness, idempotency, tool-result protection, path-safety guards | `tests/transcript-sanitizer.test.ts` |

## Related

- [prompt-queue.md](prompt-queue.md) — how queued prompts persist and drain.
- [auto-retry.md](auto-retry.md) — error-state gating and the retry/unstick lifecycle.
- [debugging.md](debugging.md) — symptom entry for the blank-ContentBlock error.
