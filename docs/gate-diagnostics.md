# Retained gate diagnostics

Retained gate diagnostics preserve the evidence from automated gate verification after a command step fails. They sit between the compact gate status surfaces and a full manual rerun: team leads can inspect persisted logs and artifacts first, then decide whether a rerun is necessary.

## Where this fits

Gate verification stores a compact step result in the gate history so `gate_status`, notifications, and default `gate_inspect` calls stay small enough for agent context. Command steps can also emit much larger stdout/stderr streams and Playwright artifacts. Those diagnostics are retained in Bobbit state, outside the goal worktree. Verification inspection reads logs with bounded selection and exposes artifacts as a compact index; artifact file content is fetched only when a caller explicitly targets one artifact.

This split keeps routine status checks cheap while making failed E2E and browser-test gates diagnosable after worktree cleanup or a gateway restart. During restart recovery, the same files let `gate_status` and `gate_inspect` show bounded output from before and after the gateway restart.

## What is retained

For command verification steps, Bobbit writes retained diagnostics under the gateway state directory, keyed by goal, gate, signal, and step:

```text
<stateDir>/gate-diagnostics/<goalId>/<gateId>/<signalId>/<step>/
  stdout.log
  stderr.log
  artifacts/
    test-results/...
    playwright-report/...
```

While a restart-recoverable command is running, the verification harness also persists process recovery files under the verification state tree: a pid/nonce identity file, heartbeat file, and atomic exit-code file. Those files are operational state, not user artifacts, but they point at the same retained stdout/stderr logs used for inspection.

The gate store persists references to the retained diagnostics on the verification step. Completed gate inspection can therefore read the state copy even if:

- the original goal worktree was cleaned up;
- the gateway restarted while or after the command ran;
- the compact `GateSignalStep.output` only contains a short failure tail.

The compact step output is still the source for default status views. The retained files are the source for explicit diagnostic inspection.

## Pinned-verification operational evidence

Pinned verification keeps server-only operational evidence for its signal-owned frozen checkout. The durable checkout lease records its lifecycle state, project/signal ownership, materialized inventory, and any cleanup attempt/error classification. A D-3 v1 lease records one validated commit/digest; a D-4 v2 lease records the aggregate witness plus ordered per-repository commit/digest identities and layout ownership. The active verification record separately retains the pinned attestation, sandbox-sidecar identity when applicable, and terminal-cleanup-pending status.

This evidence exists so restart recovery can resume or clean up the *same* bytes and so operators can distinguish a real test failure from an unavailable, changed, substituted, or still-releasing checkout. Gate history and detail expose the signal `contentDigest`, its versioned `pinnedCheckout` attestation, and, when source attestation fails, only a fixed `PINNED_CHECKOUT_*` code/message. Checkout paths, private Git worktree locations, Docker IDs, and raw Git/OS errors remain server-private; normal `gate_status` and `gate_inspect` output remain compact.

| Code | Operator-facing message | Meaning and next action |
|---|---|---|
| `PINNED_CHECKOUT_ACQUIRE_FAILED` | Frozen verification checkout could not be prepared. | Inspect server verification logs and correct the source/layout condition before re-signalling. |
| `PINNED_CHECKOUT_MUTATED` | Frozen verification source changed during execution. | Treat the result as invalid; identify the writer and re-signal after it stops. |
| `PINNED_CHECKOUT_UNREADABLE` | Frozen verification requires Docker and a prepared Bobbit sandbox image. | Start Docker and build the configured Bobbit sandbox image, then re-signal. Signalling never builds it automatically. |
| `PINNED_CHECKOUT_UNSUPPORTED_LAYOUT` | Frozen verification does not support this project layout. | Correct the persisted component/repository layout; do not expect a live-worktree fallback. |

These are the complete durable messages, including when an internal Docker, Git, path, or OS operation has a more detailed cause. See [Pinned multi-repo verification (D-4)](design/pinned-multi-repo-verification.md) for component-layout boundaries and the [D-5 end-to-end verification plan](design/pinned-gate-verification-e2e.md) for the real-process diagnostic lifecycle coverage.

If a terminal result remains associated with active cleanup, do not delete its checkout directory manually. The manager owns retries and validates that a path is the exact lease root before removal. A failed cleanup remains durable with bounded backoff, including across gateway restart. For a source-attestation failure, inspect the named gate step and server verification logs, then re-signal only after the previous generation has drained. See [Pinned source verification](goals-workflows-tasks.md#pinned-source-verification) for cache and lifecycle semantics.

## Inspecting retained logs

Use `gate_status` first to identify the failing gate and step. Then inspect that step with an explicit `gate_inspect` mode before rerunning tests:

```text
gate_inspect(gate_id="implementation", section="verification", step="E2E tests", mode="grep", pattern="error|failed|Error", context=3)
gate_inspect(gate_id="implementation", section="verification", step="E2E tests", mode="tail", lines=200)
gate_inspect(gate_id="implementation", section="verification", step="E2E tests", mode="slice", from=120, to=220)
```

Any explicit mode (`grep`, `tail`, `head`, `slice`, or `full`) allows verification inspection to use retained stdout/stderr when they exist. If `mode` is omitted, Bobbit keeps the implicit default compact: the last 20 lines per step, with no retained file paths or artifact file lists.

Typical flow:

1. `gate_status` — find the failed step name from compact status.
2. `gate_inspect(..., section="verification", mode="grep")` — search retained logs for the failure marker or stack trace.
3. `gate_inspect(..., section="verification", mode="tail"|"slice")` — read surrounding log context.
4. If `diagnostics.artifacts.files[]` lists a relevant retained file, fetch that one file with `section="artifact"`.
5. Rerun the suite only if the retained diagnostics are insufficient or the fix needs fresh verification.

## Compact surfaces stay compact

The following surfaces intentionally do not expose retained logs or artifact lists by default:

- `gate_status`;
- failure notifications sent to team leads;
- `gate_inspect(section="verification")` when `mode` is omitted;
- summary gate endpoints used by counters and dashboard cards.

This prevents large Playwright logs, traces, screenshots, or report metadata from flooding an agent context during routine progress checks. Explicit verification inspection adds diagnostic metadata such as `diagnostics.outputSource`, `diagnostics.logs`, `diagnostics.artifacts`, and inspect hints. The artifact index is metadata-only: it does not include file `content`.

## Log caps and truncation metadata

Each retained stream is capped at 20 MiB by default:

- `stdout.log` has its own cap;
- `stderr.log` has its own cap;
- when a stream hits the cap, newer bytes beyond the cap are not appended.

Explicit inspection exposes cap and truncation metadata in the verification snapshot:

- `steps[].diagnostics.logs.stdout.bytes` / `stderr.bytes`;
- `steps[].diagnostics.logs.*.truncated`;
- `steps[].diagnostics.logs.*.truncationReason`;
- `steps[].selection.truncated` and `steps[].selection.truncationReason` when selection or response budgets also apply.

`mode="full"` still passes through normal line, byte, and tool-result budgets. If those budgets apply, use `grep`, `slice`, or a larger targeted `tail` instead of assuming the selected output contains every retained byte.

## Playwright-style artifacts

When available, Bobbit copies Playwright-style artifacts from the command working directory into the retained diagnostics tree:

- `test-results/**/error-context.md`;
- traces such as `trace.zip`;
- screenshots and videos;
- selected files under Playwright `data/` and `trace/` folders;
- `playwright-report/**`.

Explicit `gate_inspect(section="verification", mode=...)` returns a compact artifact index under `steps[].diagnostics.artifacts`. Each row is metadata only: `id`, `relativePath`, retained `path`, byte size, kind, optional `testName`, and optional retry metadata. Artifact rows never include file `content`, including for small `error-context.md` files.

Use the index to fetch one artifact at a time:

```text
gate_inspect(gate_id="implementation", section="artifact", step="E2E tests", artifact="pr-walkthrough-host-agents-078cd-child-self-recover--api", mode="grep", pattern="Error|locator|failed", context=3)
gate_inspect(gate_id="implementation", section="artifact", step="E2E tests", artifact="pr-walkthrough-host-agents-078cd-child-self-recover--api", retry=1, mode="tail", lines=120)
gate_inspect(gate_id="implementation", section="artifact", artifact="test-results/pr-walkthrough-host-agents-078cd-child-self-recover--api/error-context.md", mode="slice", from=40, to=120)
```

The `artifact` selector accepts either the stable artifact `id` from the index or an exact `relativePath`. Playwright retry directories are collapsed in the verification index under the base id with `retries: N`; pass `retry=N` to fetch a specific retry, or pass the exact `relativePath` for any retained file. If the same id exists in multiple verification steps, include `step` to disambiguate.

Artifact fetches use the same bounded selection controls as verification output (`grep`, `head`, `tail`, `slice`, and `full`). When `mode` is omitted, `section="artifact"` defaults to a bounded tail rather than a full dump. Explicit `mode="full"` remains capped by normal line, byte, and tool-result budgets.

The retained `path` remains in metadata so agents can still call `read(path)` as a fallback when direct file access is appropriate. Prefer `section="artifact"` for bounded, sandbox-checked inspection.

Artifact capture is best effort. Missing reports do not change the verification result, but available reports are retained before worktree cleanup can remove them.

## Symlink hardening

Artifact copying treats verification output as untrusted filesystem content:

- symlinked artifact roots are rejected;
- symlinked descendants are skipped;
- source realpaths must stay within the artifact root;
- destination realpaths must stay within Bobbit's diagnostics directory;
- Docker-copied artifact trees are staged and then checked with the same destination bounds.

This prevents a malicious or accidental symlink in `test-results` or `playwright-report` from causing Bobbit to copy unrelated host files into retained diagnostics.

## Cleanup lifecycle

Retained diagnostics are goal-owned state. Bobbit removes the diagnostics directory when the owning goal is archived or hard-deleted. Cascade archiving cleans diagnostics for child/subgoals too, while unrelated goals' diagnostics are preserved.

Gate reset does not delete historical diagnostics; reset changes approval state and cache eligibility, but the failed signal remains part of the gate audit history until the goal itself is archived or deleted.

## Related references

- [Goals, workflows, and tasks — Verification](goals-workflows-tasks.md#verification)
- [Restart-safe command gate verification](verification-restart.md)
- [REST API — Gate inspect endpoint](rest-api.md#gate-inspect-endpoint)
- [Debugging — Failed gate has missing or compact logs](debugging.md#failed-gate-has-missing-or-compact-logs)
