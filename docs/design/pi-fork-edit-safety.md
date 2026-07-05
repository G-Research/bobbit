# pi-fork edit-safety: workaround inventory and recommendation

Status: design spike (Wave-5 lane W5.5, `(pi-fork)`)
Scope: whether Bobbit should maintain a fork of `@earendil-works/pi-*` (currently pinned at
`0.79.6`) for edit-safety and related root-cause fixes, vs. continue working around pi from
Bobbit-core, vs. upstream.

## TL;DR

**Recommendation: stay + harden, do not fork.** Bobbit currently carries exactly **three**
workarounds that are forced by genuine pi behavior (not merely "things pi doesn't do yet"), all
three are small, well-isolated, and already shipped with test coverage. The one edit-safety gap
that *cannot* be worked around from outside pi (non-atomic file writes) is also the
lowest-probability, lowest-impact item on the list, because Bobbit's worktree-per-session model
already contains almost all of the blast radius a corrupted write could cause. pi itself ships
extremely fast (six releases, `0.79.6` → `0.80.3`, in the two weeks before this spike) and is a
large, actively maintained, popular project (67.7k stars, 8.3k forks, merges external PRs weekly)
with a formal but real contribution path. Forking would trade three small, targeted workarounds
for a permanent rebase burden against that release cadence. The better move for the one
un-workaroundable gap is a scoped upstream issue/PR (assessed as viable below, **not opened by
this spike** per its instructions), not a fork.

## 1. Workaround inventory

Bobbit generates several "pi extensions" at runtime (content-addressed under
`.bobbit/state/<name>/<hash>/*.ts`, loaded via `--extension`). Not all of them are workarounds for
a pi defect — several (`tool-guard-extension.ts`, `provider-bridge-extension.ts`,
`google-code-assist-provider-extension.ts`) are ordinary uses of pi's *designed* extension hooks
(`tool_call`, `before_agent_start`, `registerProvider()`) to add Bobbit-specific behavior pi was
never expected to have. Those are not counted below. The table only lists mechanisms that exist
**because pi does something Bobbit needs to route around**.

| Workaround | pi behavior that forces it | Bobbit side | pi side (evidence) | Mechanism |
|---|---|---|---|---|
| **Tool-result error bridge** | A custom tool's `execute()` can resolve normally while returning an MCP-style payload with `isError`/`is_error: true`. pi's agent loop only sets the tool result's `isError` from whether `execute()` *threw*, never from the resolved payload's own flag. | `src/server/agent/tool-result-error-bridge-extension.ts:1-166` — generates an extension that wraps `pi.tool`/`registerTool`/`pi.tools.register` and converts a returned `isError:true` payload into a thrown error so pi persists/broadcasts the result as errored. Applied at initial spawn (`session-setup.ts:958`) and on respawn/role-reassignment (`session-manager.ts:2740`). A second, defensive layer exists client-side: `src/ui/tools/renderers/ActivateSkillRenderer.ts:52-59` explicitly documents that it cannot gate error display on `result.isError` for the same reason. | `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:416-433` (`executePreparedToolCall`) — line 433 `return { result, isError: false }` unconditionally when `tool.execute()` resolves; `isError` only flips to `true` in the `catch` block at line 435-441 when `execute()` throws. Confirmed no inspection of the resolved `result` object anywhere in that function. | Wraps pi's own registration API from a generated extension (belt-and-suspenders: server-side conversion + client-side defensive rendering). |
| **Orphan tool-result hardening** (2-layer) | pi has no orphan-tool-result pruning of its own. `firstKeptEntryId` is emitted on compaction (`session-manager.js:42-48`) as a marker only; nothing in pi's session-manager or agent-session ever validates that a persisted `toolResult`/`function_call_output` still has a matching, non-aborted, non-errored producing tool call before rehydrating it into a provider request. Bobbit's own compaction/abort/error paths can leave such orphans, which OpenAI Responses / Codex will reject outright, wedging the session. | Layer 1: `src/server/agent/transcript-sanitizer.ts` (`sanitizeTranscriptContent()`, line 152) repairs persisted `.jsonl` at the restore boundary before `switch_session` rehydrates it — drops orphan `toolResult` rows/blocks, respects `firstKeptEntryId` when resolvable, falls back to the legacy compaction-marker heuristic otherwise. Layer 2: `src/server/agent/openai-orphan-tool-result-extension.ts` generates a `before_provider_request` extension that does a final payload-local scan filtering orphan `function_call_output` items. Doc: `docs/orphan-tool-result-hardening.md`. | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:42-48,716` (`firstKeptEntryId` bookkeeping only); `rg orphan` across `dist/core` returns **zero** matches — pi performs no orphan-result validation anywhere in its own runtime. | Restore-time transcript rewrite + `before_provider_request` hook (the latter is a supported pi hook, used defensively). |
| **Bedrock request-header patch** | pi's Bedrock provider builds its own `BedrockRuntimeClient` internally; there is no supported hook to inject custom request headers into that client (AI Gateway needs Bobbit-specific headers on Bedrock traffic). | `src/server/agent/pi-ai-bedrock-headers-patch.ts:1-143` — **live-patches the installed vendor file** `node_modules/@earendil-works/pi-ai/dist/providers/amazon-bedrock.js` by string-anchored source rewriting (`patchPiAiBedrockFile()`, line 111): finds the import anchor and the `new BedrockRuntimeClient(config)` anchor, splices in a generated middleware-injection helper, rewrites the file on disk, and is idempotent via a marker string. Explicitly anticipates upstream anchor drift (`"skipped"` branch, line 117, warns rather than crashes). Regression-pinned by `tests/pi-ai-bedrock-headers-patch.test.ts` and documented in `docs/pi-0.77-opus-4.8.md` ("Bedrock patch and RPC lifecycle coverage"). | `node_modules/@earendil-works/pi-ai/dist/providers/amazon-bedrock.js` (anchors: `import { transformMessages } from "./transform-messages.js";` and `const client = new BedrockRuntimeClient(config);`). | **Direct vendor source-patch**, applied at process start (`ensurePiAiBedrockHeadersPatch()`), not an extension. This is the highest-risk workaround in the inventory: it edits pi's own installed code rather than routing around it. |

Adjacent items that are **not** pi-behavior workarounds, for completeness against the task's scan list:

- **PERF-02 (RPC line-buffer O(N²))** — `src/server/agent/rpc-bridge.ts` `handleData()`. This is a
  bug in **Bobbit's own** stdout-framing code for pi's JSON-RPC-over-stdout protocol, not a
  workaround for a pi defect; pi's IPC framing (newline-delimited JSON) is unremarkable. Fixed in
  `83413138` (PERF-02, already merged). Included here only because the task named it explicitly.
- **`--tools` unified allowlist interaction** (`docs/pi-0.77-opus-4.8.md` §"Verification
  sub-session tool activation") — Bobbit avoids passing pi's `--tools` flag to sub-sessions
  because it can filter out Bobbit extension/MCP tools alongside pi builtins. This is a
  configuration-shape adaptation, not a defect workaround.
- **Respawn/role-reassignment mirroring** — every workaround above is re-applied identically across
  initial spawn, restore, role-reassignment, and force-abort respawn (see the two call sites per
  row above). This isn't a distinct pi quirk; it's the operational tax of pi giving Bobbit no
  single choke point for "this session's extension set," so every lifecycle transition that
  rebuilds spawn args must remember to re-thread all three workarounds. A missed call site here
  is exactly the "silent merge-drop" failure class the overnight run already burned down once
  (`fdfebed0` restored a dropped `writeOpenAiOrphanToolResultExtension()` call site).
- **`google-code-assist-provider-extension.ts`** — explicitly *not* a patch: its own header
  comment states the design choice ("Rather than patch pi-ai … we use the supported
  `ExtensionAPI.registerProvider()` hook"). Good precedent that Bobbit already prefers the
  supported-hook path over vendor patching when one exists — the Bedrock patch above exists only
  because no such hook was available for that case.

## 2. Edit-safety assessment

pi's edit surface is `edit.js` (targeted find/replace) and `write.js` (full overwrite), both under
`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/`. Both share the same mutation path:

- **Within-process serialization exists.** `file-mutation-queue.js` (`withFileMutationQueue()`,
  lines 27-51) resolves each path with `realpath()` and chains operations on the same resolved
  path through a promise queue — concurrent `edit`/`write` calls against the *same file within one
  pi process* are serialized, not raced. `edit.js:177` and `write.js` (via `wrapToolDefinition`)
  both go through this queue.
- **No atomic write.** Both tools call `fsWriteFile(path, content, "utf-8")` directly
  (`edit.js:208`, `write.js:15`) — a single `fs.promises.writeFile`, no temp-file-then-rename, no
  `fsync`. A process kill (OOM killer, SIGKILL, host crash) mid-write can leave a truncated or
  partially-overwritten file. This is a real gap and it is **not fixable from outside pi** — there
  is no extension hook between "read the file" and "write the file" inside `execute()`; only pi's
  own source can add temp+rename+fsync here.
- **No conflict/staleness detection.** `edit.js:198` reads the file, computes the diff purely
  in-memory, and writes the result with no re-check that the file's content or mtime still matches
  what was read (no content-hash anchoring). If something else — a human in an editor, a second
  tool call issued by mistake, a git operation — modifies the file between pi's read and write, the
  edit silently clobbers that intervening change with no error and no merge. This is exactly the
  gap the "oh-my-pi" survey (see `~/Documents/dev/bobbit-fable-refactor/INSIGHTS.md:79,109,134`)
  flags as its differentiator: hashline (content-hash-anchored) edits plus LSP validation wired
  into every write. That survey is READMEs-only, unverified in depth (per the same file's line
  140 caveat), but the underlying pi limitation it targets is confirmed present here.
- **Hardcoded UTF-8 decode.** `edit.js:199` (`buffer.toString("utf-8")`) and the `writeFile(...,
  "utf-8")` calls on both tools assume text content. A binary file or a file in a non-UTF-8
  encoding routed through `edit`/`write` will be silently mis-decoded/re-encoded (mojibake or
  outright corruption), with no guard or warning.

**Does Bobbit's worktree-per-session model already contain the blast radius? Mostly, yes.**

- Cross-session interference is already structurally prevented: `docs/dev-workflow.md` §"Worktree
  layout" — each session gets its own worktree (`session/<id8>`), each goal team-member its own
  worktree (`goal/<goalId8>/<role>-<short4>`). Two different sessions never point pi's `cwd` at
  the same working-tree files, so the in-process mutation queue's single-process scope is not a
  practical limitation: there is normally only one process with any given path resolved as
  "current," and it's the same process the queue serializes within.
- The remaining risk after worktree isolation is **within one session's own worktree**:
  crash-mid-write corrupting a single file that only that session's agent (and, transiently, that
  session's own reviewers/gate) would see. Because each worktree is a real git working tree, a
  corrupted write shows up as an ordinary dirty diff — visible to `git status`/`git diff`,
  recoverable via `git checkout -- <path>` before commit, and (per AGENTS.md's testing/gate
  discipline) subject to the existing verification-harness push-safety gates before anything
  merges. So the *detectability and recoverability* of this failure mode is already good; what
  worktree isolation does **not** provide is *prevention* — a crash mid-write can still hand the
  agent (and, if unnoticed, a human) a subtly-truncated file that looks plausible enough to slip
  past casual review before the gate catches it.
- One cross-worktree hazard is already documented and is a closer analogue to a real incident than
  anything in this inventory: `docs/dev-workflow.md` §"Worktree-stash hazard" — all worktrees of
  one repo share a single `.git` directory (index refs, stash stack), and an unscoped `git stash`
  in one worktree can drag another worktree's uncommitted changes across. That is a **git**
  behavior, not a pi behavior, and orthogonal to the edit-tool gaps above, but it's evidence that
  "worktree-per-session" is an isolation boundary with known, already-hit seams — not an absolute
  guarantee — so residual edit-safety risk should not be dismissed purely on "worktrees contain
  it."

**Verdict:** the highest-severity gap (non-atomic writes) is real but low-probability (requires a
crash landing inside a single `writeFile` syscall) and already has reasonable detection/recovery
via git + existing gates. The conflict-detection gap (no hash/mtime check) is plausible in
practice mainly for human-in-the-loop editing during an agent turn, which is already a known
workflow risk independent of pi. Neither justifies forking on its own; both are legitimate,
narrowly-scoped upstream asks.

## 3. Fork cost/benefit

**What a fork buys:**
- Fix the `isError`-swallowing bug at the root (delete the tool-result error bridge + the
  `ActivateSkillRenderer` defensive comment/workaround).
- Add real orphan-tool-result pruning inside pi's own compaction/restore path (delete the
  transcript-sanitizer's orphan-handling half and the OpenAI guard extension — though the
  sanitizer would likely still be needed for the unrelated blank-text-message repair it also does,
  see `transcript-sanitizer.ts` header comment).
- Add a supported Bedrock request-header hook (delete the vendor source-patch entirely — this is
  the single highest-value deletion since it's the only one editing pi's own file today).
- Add temp+rename(+fsync) atomic writes and content-hash conflict detection to `edit`/`write` —
  the one class of fix genuinely impossible to obtain any other way.

**What a fork costs:**
- **Upgrade treadmill.** pi ships very fast: this repo is pinned at `0.79.6`; `npm view` at spike
  time shows `0.80.3` already published, with `0.79.10`, `0.80.1`, `0.80.2`, `0.80.3` all landing in
  the ~10 days before this spike. A fork means every one of those releases (new providers, model
  metadata, TUI/perf fixes Bobbit currently gets for free via `docs/pi-0.77-opus-4.8.md`-style
  compatibility bumps) has to be manually diffed and rebased against Bobbit's four patches before
  Bobbit can take it, or Bobbit falls behind on model support — which is directly product-visible
  (new model IDs, thinking-tier support, provider fixes).
- **Divergence risk compounds with three packages, not one.** Bobbit consumes
  `@earendil-works/pi-agent-core`, `pi-ai`, and `pi-coding-agent` as a matched set; the fixes above
  touch all three (agent-loop in `pi-agent-core`, Bedrock provider in `pi-ai`, edit/write tools in
  `pi-coding-agent`). A fork is really three forks kept in lockstep.
- **The capability Bobbit actually wants may already exist as someone else's fork.** The
  overnight survey's own synthesis (`INSIGHTS.md:134`) flags "oh-my-pi" as *already* a pi fork with
  hashline edits + LSP-on-write — i.e., the two mechanisms that would motivate forking for
  edit-safety specifically. If that capability is wanted, evaluating (not necessarily adopting)
  oh-my-pi is strictly cheaper than re-deriving the same mechanism inside a from-scratch Bobbit
  fork — but that evaluation is itself unverified (READMEs only) and out of scope for this spike.

**Upstream alternative — checked, not executed:**
`earendil-works/pi` (`node_modules/@earendil-works/pi-coding-agent/package.json` →
`repository.url: git+https://github.com/earendil-works/pi.git`, MIT license) is public: 67,739
stars, 8,312 forks, 53 open issues, `has_discussions: true`,
`pull_request_creation_policy: "all"`. It merges external PRs on a normal cadence — five most
recent merges at spike time were all from outside contributors (e.g. #6176 "Apply extension tool
changes before the next provider request in the same run," merged 2026-06-30, in the same
extension/tool-result problem space as Bobbit's bridge). It is **not** a low-traffic or
effectively-abandoned project where "upstream" would be a dead end.

It does gate contributions formally: `CONTRIBUTING.md` states core PRs from new contributors are
auto-closed by default and require a maintainer `lgtm` reply on a **preceding issue** before a PR
may even be opened ("`lgtm` does not grant rights to submit PRs. Only `lgtm` grants rights to
submit PRs."); core-bloat PRs are called out as likely rejects ("If your feature does not belong
in the core, it should be an extension"). The `isError`-swallowing bug and the missing
Bedrock-header hook are both small, root-cause, core-runtime bugs/gaps (not feature asks) with a
clear repro and a one-paragraph fix description — a good fit for that gate. The atomic-write /
conflict-detection gap is more architectural (touches every `edit`/`write` call) and would need
more upfront design discussion (pi has a public RFC process at rfc.earendil.com for exactly this
kind of change) before an issue, let alone a PR, would be worth opening.

No issue, PR, or any other external artifact was opened as part of this spike, per its
instructions — this section is assessment only.

## 4. Recommendation: stay + harden

Given three small, already-isolated, well-tested workarounds and one gap that upstream is
plausibly receptive to, the fork does not pay for itself. Recommended concrete hardening,
doc-only for this PR (flagged where a follow-up implementation PR would be needed):

1. **Add a vendor-behavior compatibility test for the edit/write safety surface**, following the
   existing pattern in `tests/pi-ai-bedrock-headers-patch.test.ts` (which already asserts the
   installed Bedrock file still has the patch's anchor strings). A new test should assert that
   the installed `edit.js`/`write.js` still (a) route through `withFileMutationQueue`, and (b) call
   `writeFile(..., "utf-8")` with no third "flags" argument implying atomic-rename semantics
   Bobbit isn't aware of. This turns a silent, dangerous pi upgrade (e.g., pi quietly changes
   write semantics, or removes the mutation queue) into a loud, actionable CI failure instead of a
   field-discovered corruption bug — the same value the existing Bedrock/RPC-lifecycle
   compatibility tests already provide for their surfaces. *(Follow-up implementation PR; not
   included here.)*
2. **File a scoped upstream issue against `earendil-works/pi`** for the `isError`-swallowing bug
   in `agent-loop.js:433` (small, root-cause, clear repro: return `{isError:true}` from a
   registered tool and observe the persisted result is never marked errored) — the single
   highest-leverage ask since it benefits every pi consumer, not just Bobbit, and would let Bobbit
   delete both the server-side bridge and the client-side defensive comment on a future pi bump.
   *(Assessment only — not opened by this spike, per instructions.)*
3. **No action recommended on the Bedrock patch or orphan-tool-result handling beyond current
   state.** Both are already regression-tested, already isolated behind clear module boundaries,
   and already designed to fail loud/soft respectively (the Bedrock patch warns rather than
   crashes on anchor drift; the orphan guards are additive filters, never destructive beyond
   dropping already-invalid rows). Revisit only if pi's own compatibility-test canary (item 1,
   extended to cover these two surfaces the same way `pi-ai-bedrock-headers-patch.test.ts` already
   does for Bedrock) starts failing on a pi bump.
4. **Do not build atomic writes or content-hash conflict detection into Bobbit as a
   pi-wrapping shim.** As established in §2, there is no hook point between pi's internal read and
   write to intercept this from outside; a Bobbit-side "fix" here would necessarily mean
   reimplementing `edit`/`write` as Bobbit-owned tools and disabling pi's builtins for those names
   — a much larger surface change than this spike's edit-safety scope, and one that would
   reintroduce exactly the kind of duplicated-vs-pi maintenance burden the "buy vs. build" flag in
   `INSIGHTS.md:109` warns against ("Bobbit spawning pi agents should surface pi capabilities
   instead of duplicating them"). Track this as a live but low-priority upstream/oh-my-pi
   evaluation item, not a near-term Bobbit build.

No flag-gated prototype accompanies this doc: nothing surfaced during the investigation that was
both safely flag-gatable and worth shipping ahead of the upstream/compat-test follow-ups above.
