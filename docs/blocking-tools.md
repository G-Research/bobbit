# Blocking tools — agent pauses while another party produces a result

Some builtin workflows must pause while another subsystem produces a result. Bobbit implements these with a **harness** pattern: the server parks a Promise under a correlation key, and a later authenticated callback resolves it. The correlation key routes the result; it is not authorization.

The canonical example is:

- `verification_result` — a reviewer or QA agent submits a verdict that resolves the gate harness's pending entry for that verifier session. The extension may accept `report_html_file` as verifier-local convenience, but it reads and transforms the file before POSTing only `report_html` bytes. The internal endpoint rejects file paths. See [QA testing — Verification submission trust boundary](qa-testing.md#verification-submission-trust-boundary).

Blocking is the right shape here because **another agent is actively doing work** (running reviews, executing QA steps) while the requesting agent waits. The requesting agent genuinely cannot make progress until the verdict lands.

Contrast: `ask_user_choices` used to use this pattern but was moved to a non-blocking design. Waiting on a human is not "work in progress" — holding the turn open misleads the UI ("thinking…") and creates fragile in-memory state. See [docs/non-blocking-ask.md](non-blocking-ask.md) for the alternative pattern used there.

## Flow (`verification_result`)

```
  Gate harness              Verifier agent       Tool extension             Gateway
      │ create verifier           │                     │                       │
      │ park by sessionId         │                     │                       │
      │ (awaits)                  │                     │                       │
      │                           │ verification_result │                       │
      │                           ├────────────────────►│                       │
      │                           │                     │ read/bound report file│
      │                           │                     │ inline safe images    │
      │                           │                     │ POST report_html +    │
      │                           │                     │ session secret        │
      │                           │                     ├──────────────────────►│
      │                           │                     │                       │ resolve secret;
      │                           │                     │                       │ match session/scope;
      │◄────────────────────────────────────────────────────────────────────────┤ resolve pending result
      │                           │                     │◄──────────────────────┤ { ok: true }
      │ store step output and     │◄────────────────────┤                       │
      │ optional HTML artifact    │                     │                       │
```

The verifier's public session ID selects the pending entry but grants no authority. The gateway requires `X-Bobbit-Session-Secret` to resolve to that exact session and to belong to the sandbox scope captured when the request is admitted. Missing, unknown, or foreign secrets return the stable `403` code `VERIFIER_SESSION_SECRET_REQUIRED`; an admin bearer, browser cookie, or guessed session ID cannot substitute. Verdicts are accepted only as exact `pass` or `fail` strings.

This boundary also keeps local paths on the correct side of the API. `report_html_file` is opened only by the extension inside the verifier runtime. The gateway rejects that field and does not rewrite `file://` URLs in uploaded `report_html`. The extension rejects non-regular, oversized, or final-symlink report paths, bounds the read at 10 MiB, and performs canonical, identity-checked image containment before upload. See [QA testing — Screenshots in QA reports](qa-testing.md#screenshots-in-qa-reports) for image and final-report budgets.

## File layout

```
defaults/tools/tasks/
  verification_result.yaml             Tool manifest (name, description, input schema, docs).
  extension.ts                         Tool extension — registers the tool and POSTs to
                                       the verification submit endpoint.

src/server/agent/
  verification-harness.ts              VerificationHarness class. Tracks active gate verification
                                       and pending result resolvers keyed by verifier session ID.

src/server/server.ts
  POST /api/internal/verification-result
                                       Verifier-only callback: binds the session secret, validates
                                       verdict/report bytes, resolves the pending result, and returns
                                       { ok: true }. It never accepts a report file path.

src/ui/components/...                  Gate/task UI surfaces (not a chat widget — verdicts flow
                                       through gate signals, not inline transcript cards).
```

Exact file paths may evolve; search for `VerificationHarness` to find the live wiring.

## Harness contract

A blocking harness needs three lifecycle operations, even when their concrete names differ:

| Operation | When called | Purpose |
|---|---|---|
| Register | When work starts. Returns a Promise. | Park a pending entry and give the coordinator something to await. |
| Resolve | When the producer submits a valid result. | Resolve exactly the intended pending entry. |
| Reject/cleanup | On cancellation, timeout, or session termination. | Settle and remove outstanding work so callers do not hang. |

`VerificationHarness` specializes this pattern with `pendingResults`, keyed by the verifier session ID. It installs the resolver before dispatching the reviewer or QA prompt and retains it through termination long enough to capture a verdict racing teardown. The endpoint looks up only the identity derived from the session secret, never an unauthenticated caller-selected identity.

## Session termination and replay behavior

- **Termination.** Reviewer and QA runners own pending-result cleanup. They keep both the resolver and exact-session credential valid while terminating the verifier so an admitted result can finish without losing a genuine late verdict. Cleanup then removes the pending result and revokes the credential; later submissions cannot reuse it.
- **Server restart.** In-flight gate verifications are persisted and resumed. The resume path reinstalls a pending resolver for the same verifier session before prompting it to submit or retry. Purely transient waits need their own persistence design if they must survive a severed HTTP connection.

## Adding your own blocking tool

1. **Write the tool manifest and extension.** Put them under `defaults/tools/<group>/`. Resolve gateway connection details as other builtin extensions do. If only the spawned producer may resolve the wait, send its process-local session secret and keep local file handling in that process.
2. **Add a harness.** Keep pending entries under a correlation key that uniquely identifies the producer and attempt. Define cancellation, timeout, teardown-race, and restart behavior before wiring the endpoint.
3. **Wire the REST endpoint** in the server router. Validate the payload, derive authentic caller identity independently of caller-selected routing fields, enforce sandbox scope, then resolve exactly the matching pending entry. A bearer token alone is not sufficient for an agent-only callback.
4. **UI surface (if needed).** Most blocking tools drive gate panels or task dashboards. Reuse the existing artifact flow when the result is durable evidence rather than creating a second storage or rendering path.
5. **Tests.** Unit-test registration and cleanup. Integration-test the full callback with missing, foreign, and authentic producer credentials, plus any local-file boundary handled by the extension.

## Before choosing blocking

Ask: **"Is another agent or subsystem actively working on producing this result?"**

- **Yes** (reviewer agent running, QA session executing steps, background worker computing): blocking is correct. The requesting agent cannot proceed and the "thinking" indicator is accurate.
- **No — we're waiting on a human** (pick options, approve, answer a question): use the non-blocking pattern. The agent should end its turn and resume later when the human's input arrives as a normal transcript message. See [docs/non-blocking-ask.md](non-blocking-ask.md).

## See also

- [docs/non-blocking-ask.md](non-blocking-ask.md) — `ask_user_choices` non-blocking flow and when to use it instead.
- [docs/rest-api.md](rest-api.md) — full REST surface, including the `/api/internal/*` endpoints.
- [docs/goals-workflows-tasks.md](goals-workflows-tasks.md) — how `verification_result` plugs into gate verification.
