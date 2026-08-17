# G11 — Claude Agent SDK operator documentation and real-model dogfood

## Decision

G11 packages the integrated G1–G10 runtime contract as durable operator/developer
instructions and expands the existing opt-in lifecycle smoke into a reproducible,
credential-safe evidence run. It is a release-readiness slice, not a new runtime,
authentication path, transcript store, permission system, or test-only provider
fallback.

**Final G11 signoff is an agent-run Playwright/API evidence run against a real
Claude subscription.** This replaces the previous user-hands-on-only blocker.
Credential-free checks establish implementation behavior; the authenticated
direct and Docker evidence runs establish the selected host, browser, and
sandbox paths without exposing their private inputs or outputs.

The published operator guide is `docs/claude-agent-sdk-sessions.md`. This design
is the implementation and evidence plan. It must not replace the slice designs it
links to.

## G1–G12 coverage and ownership audit

| Slice | Merged contract/evidence to audit | G11 action | Boundary |
| --- | --- | --- | --- |
| G1 runtime/lifecycle | `session-runtime.ts`, `ClaudeAgentSdkBridge`, UUID persistence and resume; bridge/core/integration lifecycle tests | Document selection, one-query lifetime, recovery and failure semantics; exercise direct start, prompt, steer, interrupt, restart/resume. | Implemented; G11 documents and dogfoods. |
| G2 composer slash ownership | `MessageEditor`/`ComposerSlashRegistry`, `claude-sdk-composer-slash.journey.spec.ts` | Document Bobbit skill precedence, raw unknown slash pass-through, and SDK `/compact` suppression; exercise a Bobbit-owned slash. | Implemented; G11 documents and dogfoods. |
| G3/D4 skills and helpers | `buildClaudeSdkSubagentPolicy`, tool surface, subagent rendering tests | Document bundled-skill inventory and the three constrained read-only helper projections; observe one admitted helper inside its root `Agent` card. | Implemented; G11 documents and dogfoods. |
| G4 permissions | `ClaudeSdkToolSurface.canUseTool`/`PreToolUse`, `SessionManager.requestToolGrant`, permission-card tests | Document canonical permission cards, grant scopes, cancellation, and no bypass; exercise a tool policy that presents and settles a card. | Implemented; G11 documents and dogfoods. |
| G5/G12 inventory and upgrade boundary | `claude-agent-sdk-real-init-inventory.spec.ts`, literal SDK/binary inventory and policy | Document the SDK/binary upgrade checklist and require review of the literal inventory before pin changes. | G5 implemented. G12/release ownership remains parent-owned; G11 supplies evidence requirements only. |
| G6 persistence/history | SDK session access/history adapter, `session-runtime-route-boundary.test.ts` | Document SDK UUID resume, official history authority, Continue/Fork boundaries, and opaque unavailable source response. | Implemented; G11 documents and dogfoods resume/reload. |
| G7 tool surface | `buildClaudeSdkToolSurface`, dispatcher, native policy tests | Document Bobbit MCP ownership, native suppression, canonical/raw name distinction, and settings isolation; execute one canonical Bobbit tool. | Implemented; G11 documents and dogfoods. |
| G8 transcript/cost/usage/compaction | root-result ledger, history projection, compaction checkpoint, restart E2E | Document subscription-notional semantics, official transcript projection, and SDK-managed compaction; inspect durable transcript/cost/usage before and after recovery. | Implemented; G11 documents and dogfoods observation, not manual compaction. |
| G9 Docker sandbox | sandbox launch descriptor, Docker spawn, OAuth handoff, sandbox tests | Document matching-image and OAuth-policy prerequisites, supported handoff, and fail-closed remediation; repeat the lifecycle in Docker. | Implemented; G11 documents and dogfoods. |
| G10/G10b controls and rendering | runtime model transaction, embedded subagent snapshot/card | Document live SDK capability-driven model/thinking controls and nested helper rendering; change supported model/thinking and observe a nested card. | Implemented; G11 documents and dogfoods. |
| G11 | Operator guide, manual lifecycle suite, recorded evidence matrix | Add instructions and expand opt-in direct/sandbox smoke and evidence template below. | This slice. |
| G12/parent release decision | Cross-slice integration, gate evidence, final agent-run Playwright/API signoff | Consume G11’s records; decide release only after the required agent-run evidence is present. | Parent-owned. G11 must not signal or claim this boundary passed. |

## Documentation implementation plan

Update `docs/claude-agent-sdk-sessions.md` as the single operator/developer guide;
link to the existing slice designs for implementation rationale. The guide must
contain the following durable sections.

| Section | Exact source of truth / seam | Required operator content |
| --- | --- | --- |
| Runtime selection and persistence | `src/server/agent/session-runtime.ts::{runtimeFromProvider,resolveSessionRuntime,createSessionBridge}`, `session-store.ts` | Select a built-in `claude-agent-sdk/<alias>` through normal default/role configuration. Explain that `anthropic/*` remains Pi, runtime is persisted/derived rather than a per-request switch, and crossing runtimes requires a new session. Explain opaque UUID resume and no Pi `switch_session`. |
| Subscription authentication and settings isolation | `claude-agent-sdk-bridge.ts::buildClaudeAgentSdkEnv`, query-option builder | Direct SDK sessions use Bobbit's locked OAuth resolver and a durable Bobbit-owned config/history root without copying native CLI auth/config; `settingSources: []`, strict MCP, disabled auto-memory, only the Bobbit MCP server. State that API key/cloud/unmanaged settings/plugin/MCP fallback is not supported. |
| Native tools, Bobbit tools, and permissions | `claude-agent-sdk-tool-surface.ts::{buildClaudeSdkToolSurface,normalizeClaudeSdkMcpToolName}`, `claude-sdk-tool-dispatcher.ts`, `SessionManager.requestToolGrant` | List Bobbit ownership and native suppression; distinguish canonical `read` from SDK raw `mcp__bobbit__read`. Explain allow/ask/never, visible permission cards, one-time/session/persistent grants, and that `PreToolUse` is final enforcement. Never advise bypass mode. |
| Slash and skill ownership | Composer registry and `resolveSkillExpansions()` | Exact Bobbit skills win; bundled Claude commands are not autocomplete/launchers; unknown slashes pass through. SDK `/compact` is locally consumed, retains the draft, and is unsupported; only SDK-managed automatic compaction exists. |
| Skills and subagents | `CLAUDE_BUNDLED_SKILLS_0_3_222`, `buildClaudeSdkSubagentPolicy`, `claude-sdk-subagent-work.ts` | Publish the reviewed bundled-skill list/version pin. Describe the only three foreground `bobbit-*` helper projections, one-child/depth-one limit, read/find/grep ceiling, no task/team/worktree/cost account, exact-parent rendering, and safe failure display. |
| Transcript, cost, usage, and compaction | `cost-tracker.ts::recordAuthoritativeUsage`, history adapter, SDK compaction coordinator | Explain official SDK history authority, server projection, root-result-only exactly-once accounting, subscription-notional versus billed cost, unknown versus zero, context high-water, nested child usage exclusion, and unsupported manual compact. |
| Live controls and resume | `ws/runtime-model-selection.ts`, bridge model/thinking calls, `session-manager.ts` recovery | Controls are constrained by the live Query capability; only verified tuple read-back persists/broadcasts. Unsupported requests are rejected, not clamped. Describe restart/replacement resume and reload snapshot behavior. |
| Docker prerequisites and recovery | `SessionManager.applySandboxWiring`, sandbox launch/credential helpers, `docker/Dockerfile` | Require Docker, current `bobbit-agent` image with matching SDK/binary/launcher, explicit enabled empty `ANTHROPIC_OAUTH_TOKEN` sandbox policy, and an active Bobbit Anthropic OAuth connection. Document no host auth mount/API-key workaround; map sandbox auth/image errors to re-connect/policy/image rebuild. |
| SDK upgrade inventory check | literal real-init inventory test | Every SDK or bundled Claude version change requires declaration review, image rebuild, literal expected-inventory review, native policy/bundled-skill/agent review, and successful inventory test. Never regenerate or accept the snapshot blindly. |
| Failure recovery | `claude-agent-sdk-error.ts`, REST transcript/session routes | For `SDK_SESSION_UNAVAILABLE`, retain the wrapper/queue, verify the original subscription/project context and UUID source, repair auth/image/config then retry. Do not start a replacement conversation, copy SDK files, expose paths/IDs/credentials, or fall back to Pi. |

The guide must use sanitized example output only. It must never include access or
refresh tokens, auth-file paths or contents, SDK config paths, opaque session IDs,
full provider errors, environment dumps, user prompts/responses that could be
sensitive, or instructions to add an API key to make the subscription runtime
work.

## Automated implementation plan

### Existing test extension points

Extend only `tests/manual-integration/claude-agent-sdk-lifecycle.spec.ts` for
real-model work. Keep its isolated temporary state, local gateway, built-in alias
selection, and environment capture/restore model. It already uses production
`SessionManager` and `IRpcBridge` seams rather than a second browser protocol.
Add helper functions in that file only when they keep direct and sandbox cases
readable; do not create test credentials, copy a Claude auth directory, or log
model output.

The manual suite must set a bounded timeout and skip unless its explicit flag
and `MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR` are present. It defaults to the unprefixed
`haiku` alias; a supplied `MANUAL_CLAUDE_AGENT_SDK_MODEL` must be an unprefixed
alias. The auth directory is an owner-only temporary `BOBBIT_AGENT_DIR`
authenticated through a separate loopback Bobbit gateway. Playwright must receive
it before agent-directory reset or auth-sensitive server imports, which can cache
startup-derived state. The suite must never copy/paste tokens or auth files,
co-locate this subscription OAuth with enterprise Anthropic OAuth in a normal
instance, or remove the isolated directory before evidence review and final
signoff. Its temporary default model disappears with the isolated test state and
does not alter a production gateway.

| Journey action | Production seam exercised | Manual assertion/evidence |
| --- | --- | --- |
| Start SDK session | provider preference → `resolveSessionRuntime` → `createSessionBridge` → first accepted input | Idle bridge creation is bounded but SDK initialization is lazy. The first accepted input is the canonical auth/provider startup boundary and must settle with a sanitized failure or a live SDK result. |
| Bobbit tool and permission card | tool surface → `requestToolGrant` → existing UI event/card path → dispatcher | Prompt requests an allowed canonical `read`; separately configure an `ask` safe tool and record card requested/settled and canonical name/group, without raw arguments/results. |
| Workflow gate | normal Bobbit `gate_list`/`gate_status` surface under current session scope | Record the observed gate action and normal rendered result; do not signal/alter a real release gate merely to satisfy smoke coverage. Use an isolated fixture goal/gate or read-only gate query. |
| Bobbit slash | composer → `resolveSkillExpansions` → prompt queue | Create/use a scoped exact Bobbit skill in isolated state; verify it is selected/expanded before SDK delivery. Also verify SDK `/compact` is consumed locally and does not reach the SDK. |
| Constrained helper | `Agent` admission → registry → subagent work projection/card | Request one allowed projection; record root Agent parent id redacted to a test label, one nested helper phase/card, and no new Bobbit session/task/worktree/cost account. No built-in/Task/background helper is attempted in a live host run. |
| Model/thinking | WS tuple transaction → bridge capability → verified read-back | Change only an SDK-advertised configured model and thinking level; record requested/effective public tuple and rejection if capability is absent. Do not assume any model supports effort. |
| SDK compaction | provider `PreCompact` → checkpoint/history refresh | Drive enough benign bounded context only when practical; record automatic compaction if observed. The test must never call a fake/manual SDK compact or fail a host merely because automatic compaction did not occur. |
| Restart/resume and reload | persisted UUID → session restore → official history/snapshot → WS reload | Restart the isolated gateway and reload/reconnect its page/session transport; confirm same session wrapper and durable server snapshot, post-restart prompt ability, transcript row identity projection, cost/usage/basis snapshot and context high-water. |
| Provider unavailable | isolated invalid/missing SDK subscription/provider fixture | Assert bounded `SDK_SESSION_UNAVAILABLE` category from start/restore/prompt, no hang/Pi fallback/new conversation, and retained wrapper/queue. This is credential-free and must run before the live smoke. |

The direct test command defaults to `haiku`:

```bash
BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 \
MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR="$MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR" \
npm run test:manual -- --grep "Claude Agent SDK lifecycle"
```

The sandbox test command also defaults to `haiku`:

```bash
BOBBIT_RUN_CLAUDE_AGENT_SDK_SANDBOX_SMOKE=1 \
MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR="$MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR" \
npm run test:manual -- --grep "Docker sandbox lifecycle"
```

### Credential-free parent checks before opt-in runs

The parent/release owner must run and record these before a credentialed agent
run. They are executable implementation evidence, not live subscription evidence:

```bash
npm run build
npx vitest run --config vitest.config.ts --silent=passed-only \
  tests2/core/claude-agent-sdk-session-access.test.ts \
  tests2/core/claude-agent-sdk-bridge.test.ts \
  tests2/core/claude-agent-sdk-tool-surface.test.ts \
  tests2/core/claude-agent-sdk-skills-subagents.test.ts \
  tests2/core/controlled-model-fallback.test.ts \
  tests2/core/runtime-model-recovery-ownership.test.ts \
  tests2/core/claude-agent-sdk-sandbox-spawn.test.ts \
  tests2/core/anthropic-sandbox-handoff-regression.test.ts \
  tests2/integration/claude-agent-sdk-runtime-persistence.test.ts \
  tests2/integration/session-runtime-route-boundary.test.ts \
  tests2/integration/claude-agent-sdk-tool-permissions.test.ts \
  tests2/integration/claude-agent-sdk-permission-card-journey.test.ts \
  tests2/integration/claude-agent-sdk-sandbox-runtime.test.ts
npm run test:e2e:run -- tests/e2e/claude-agent-sdk-session-restart.spec.ts
npx playwright test --config playwright-e2e.config.ts \
  tests/e2e/claude-agent-sdk-real-init-inventory.spec.ts
npm run check
```

Add or retain a credential-free provider-unavailable case in the relevant fake
SDK seam (`tests2/core/claude-agent-sdk-bridge.test.ts` and the runtime
persistence integration suite). It must verify bounded readiness/prompt
settlement, sanitized `SDK_SESSION_UNAVAILABLE`, retained durable recovery work,
and no Pi bridge/query/transcript fallback. This check is required even if a
local subscription is unavailable.

## Evidence matrix and acceptance rules

| Evidence class | Can prove | Cannot prove | Required record |
| --- | --- | --- | --- |
| Deterministic unit/integration/E2E | Runtime boundaries, isolation branches, renderer/projection, durable recovery, unavailable-provider behavior, policy and inventory pins without credentials | Live subscription behavior, host OAuth discovery, actual Docker credential handoff, or rendered browser workflow | Commands, commit SHA, pass/fail, SDK/binary versions, sanitized fixture category. |
| Authenticated direct Playwright/API smoke | Local OAuth discovery plus one real SDK lifecycle through the rendered browser/API: tool, slash, helper, controls, restart, resume, and reload | Docker handoff or broad provider/model compatibility | Command, public model label, SDK/binary version, sanitized auth category, matrix outcomes, transcript/cost/usage observation, and sanitized UI artifacts. |
| Actual Docker sandbox gate | Matching-image launch, explicit policy-gated OAuth handoff, container cwd, and replacement/restart resume on one host | Other host images or architectures | Command, Docker/image version, policy presence without token value, sanitized auth category, lifecycle outcomes, and sanitized UI artifacts. |
| Final agent-run Playwright/API signoff | The implemented direct and supported sandbox workflows were exercised and observed by an agent in the intended environment | Universal compatibility or a substitute for deterministic regression tests | Agent/date/environment confirmation, direct and supported-sandbox outcomes, sanitized artifacts, and unresolved limitations. |

A run is **pass** only if every requested action that is applicable to the
selected model/capabilities settles within its bounded timeout, produces its
expected server/UI observation, preserves runtime boundaries, and records no
secret. An unsupported advertised control or an unobserved automatic compaction
is **not** a product failure when the suite reports it accurately; fabricating a
successful control/compaction is a failure. An expected
`SDK_SESSION_UNAVAILABLE` in the credential-free provider-unavailable fixture is
a passing recovery observation. Any unexpected unavailable result in a
credentialed scenario, image mismatch, permission/card mismatch, transcript/cost
regression, raw child content leakage, or fallback to Pi is a failed scenario
until remediated and rerun.

No G11/G12 readiness statement may be made while any required entry is pending,
failed, missing its sanitized record, or lacks the final agent-run Playwright/API
signoff record. Credential-free checks alone are insufficient.

## Host and sandbox prerequisites

### Direct host run

- Explicit `BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1` and
  `MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR`. The default alias is `haiku`; any
  `MANUAL_CLAUDE_AGENT_SDK_MODEL` override is an unprefixed alias.
- The auth directory is a fresh owner-only temporary `BOBBIT_AGENT_DIR` whose
  OAuth was completed through a separate loopback Bobbit gateway. Export it to
  Playwright before directory reset or auth-sensitive imports; do not copy/paste
  tokens/auth files or mix it with enterprise Anthropic OAuth in a normal
  instance.
- Built server/test artifacts and isolated temporary Bobbit state. A native
  Claude CLI login alone is insufficient.
- No `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` workaround, environment dump,
  credential logging, or cleanup before evidence review and final signoff.

### Docker sandbox run

All direct prerequisites, plus:

- Docker available and a rebuilt `bobbit-agent` image with Agent SDK `0.3.222`,
  bundled Claude `2.1.222`, Pi `0.84.1`, runtime schema `2`, the image-owned SDK
  dependency, and executable `/usr/local/bin/bobbit-claude-agent-sdk` wrapper
  under the `bobbit-sdk` identity. It must pass Bobbit's workspace-root ownership
  and container-reachable callback-translation checks; host binaries, dependency
  mounts, or manually rewritten callbacks are not substitutes.
- A project Docker sandbox with an explicit enabled empty
  `ANTHROPIC_OAUTH_TOKEN` sandbox-token policy entry.
- The Bobbit Anthropic OAuth connection is refreshable; only the current
  short-lived access token may be passed to the one `docker exec` process.
- No project API key/conflicting Anthropic credential, host auth/config mount,
  generic sandbox credential reuse, host SDK fallback, or persistent token.

If the prerequisites fail, record the sanitized error and remediation:
`CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE` means enable the policy or reconnect
Bobbit OAuth; `CLAUDE_AGENT_SDK_SANDBOX_UNAVAILABLE` means rebuild/repair the
image, container CWD, or scoped authority. Do not weaken isolation to make a
smoke pass.

## Completed sanitized agent-run record

This completed agent-run Playwright/API record is evidence for G11 only. It does
not make or imply a parent release-readiness decision. It contains no credentials,
opaque identifiers, private paths, prompts, tool inputs/results, model output,
provider bodies, or callback, container, or correlation identifiers.

| Field | Sanitized completed record |
| --- | --- |
| Date and implementation commit | 2026-08-17; `47cf34c1e`. |
| Runtime versions | Agent SDK `0.3.222`; Claude `2.1.222`; runtime schema `2`; host-current Pi `0.84`. |
| Model and controls | Started with alias `haiku`; supported live switch to `sonnet` and thinking control passed. |
| Credential-free and direct coverage | Credential-free provider-unavailable recovery passed with no fallback; direct OAuth Playwright/API lifecycle and permission-card flow passed. |
| Docker coverage | The actual Docker sandbox gate passed without a warm-up request. |
| Browser and lifecycle | Targeted browser coverage, restart, resume, reload, transcript projection, and canonical `read` passed. |
| Bobbit-owned interactions | Read-only gate action, Bobbit slash ownership, and constrained helper rendering within its card passed. |
| Usage and cost | Transcript, token totals, and current/high-water context fields were present. Cost basis was `subscription-notional`; billed total was `null`; the notional value was nullable. |
| Compaction | Automatic compaction was not observed and remains observation-only. |
| Sanitized repository artifacts | `tests/manual-integration/claude-agent-sdk-lifecycle.spec.ts`, `tests/e2e/claude-agent-sdk-session-restart.spec.ts`, and `tests/e2e/claude-agent-sdk-real-init-inventory.spec.ts`. |

The required agent-run Playwright/API evidence is recorded. The parent release
owner separately decides whether all parent requirements are satisfied.

## Recorded final signoff matrix template

The agent running the evidence records the following sanitized table in the G11
workflow evidence or release record. Never record credentials, IDs, paths, raw
provider errors, full prompts, or private model output.

| Field | Direct | Docker sandbox |
| --- | --- | --- |
| Date, operator confirmation, Bobbit commit | | |
| Command and unprefixed model ID | | |
| SDK package / Claude binary / image version | | |
| Local OAuth category (no token) and sandbox policy/image prerequisites | | |
| Start + Bobbit tool + permission-card result | | |
| Read-only workflow-gate action and Bobbit slash ownership result | | |
| Constrained helper nested-card result | | |
| Model/thinking request and verified effective tuple (or accurate unsupported result) | | |
| Automatic compaction observation, if triggered | | |
| Restart/resume + browser reload result | | |
| Transcript stable projection; cost basis/notional/billed value; usage/context observation | | |
| Provider-unavailable deterministic check reference | | |
| Screenshots/artifact locations, sanitized | | |
| Failures, remediation, rerun result | | |
| Agent confirmation that final Playwright/API evidence ran | | |

## Security constraints

- The official SDK is the transcript authority; do not copy SDK storage, create a
  Pi JSONL fallback, start a fresh conversation for an unavailable UUID, or
  expose the opaque UUID.
- Do not log, persist, snapshot, assert, screenshot, or redact-after-the-fact an
  access token, refresh token, API key, auth file, gateway secret, environment
  dump, provider error body, SDK config/session path, child prompt, or child
  response.
- Preserve `settingSources: []`, strict MCP config, closed per-query environment,
  disabled auto-memory, the literal bundled-skill inventory, native suppression,
  `permissionMode: "default"`, and the registration/permission/`PreToolUse`
  ceilings. A smoke must never use bypass permissions.
- The Docker handoff is one short-lived OAuth access token for one SDK subprocess;
  it is neither a host mount nor a container-wide/persisted credential. API-key
  fallback is prohibited.
- SDK child work remains nested beneath its exact root `Agent` tool use. It must
  not create a Bobbit session, task, worktree, separate cost record, or root
  transcript prose.
- Preserve Pi as a co-resident control runtime. No failure/recovery/manual test
  may silently route an SDK-selected session to Pi.
