# Claude runtime review workflow

## Decision

Add the three runtime-specific roles from §16 of the authoritative Claude Code
run-mode epic and a `claude-runtime` workflow. This is configuration over the
existing role, workflow, and verification systems; it does **not** add a gate
engine, session runtime branch, API, persistent state owner, or prompt transport.

The SDK runtime is already selected only by `claude-agent-sdk/<model-id>`; all
other providers, including `anthropic/*`, remain Pi-backed. That selection rule
and the current SDK contracts in [Claude Agent SDK sessions](../claude-agent-sdk-sessions.md)
are the review baseline.

### Current inventory and role-name validation

At design time, `defaults/roles/` contains no `claude-protocol-scout.yaml`,
`backend-parity-reviewer.yaml`, or `billing-safety-auditor.yaml`; the project
role override directory (`.bobbit/config/roles/`) contains only
`spec-auditor.yaml`. The three §16 names are therefore new and have no existing
role to alter or collision to resolve. Existing `architect`, `spec-auditor`,
`code-reviewer`, `security-reviewer`, `docs-writer`, and `qa-tester` roles remain
unchanged.

Roles load through the existing `PackResolver`/`RoleLoader` path
(`src/server/agent/pack-resolver.ts`) from `defaults/roles/`, then resolve through
the existing cascade (project > server > built-in/pack) and
`resolveRole` (`src/server/agent/resolve-role.ts`). The workflow is project-local
in `.bobbit/config/project.yaml::workflows`, where `InlineWorkflowStore` already
normalizes and persists it. A workflow step naming an absent role fails through
the existing verification-role resolution; the new tests make that condition
impossible for this shipped workflow rather than adding validation semantics.

## Approaches considered

| Approach | Flow and defect surface | Decision |
| --- | --- | --- |
| Add the three role YAML files and one inline workflow, using existing `llm-review`, command, content, and review-result flows | `project.yaml` is parsed by `ProjectConfigStore`, normalized by `InlineWorkflowStore`, DAG-validated by `workflow-validator.ts`, frozen onto a goal, and executed by `VerificationHarness`. Reviewers receive `buildReviewPrompt()` context and submit `verification_result`. Adds only three prompt definitions and one declarative DAG. | **Selected.** It preserves the established gate state, restart, phase scheduling, role cascade, and verification-result ownership. |
| Build Claude-specific gate types or a custom review orchestrator | A separate runner would need a second DAG/status model, prompt construction, timeout/retry/restart behavior, role lookup, result persistence, and UI rendering. It would duplicate `VerificationHarness` and can diverge from ordinary goal gates. | Rejected. It expands cross-layer state and lifecycle risk without meeting any additional acceptance criterion. |
| Put the specialist instructions into generic reviewers or `general` | No new files, but every non-Claude review pays the prompt cost and generic roles lose their bounded concern. It also makes the runtime safety checks optional or easy to omit from a workflow. | Rejected. Dedicated narrow roles are smaller in the common case and make the required checks declarative. |

The selected design composes `RoleStore` policy normalization
(`src/server/agent/role-store.ts`), `PackResolver`, `InlineWorkflowStore`,
`validateWorkflowDefinition`, `VerificationHarness::buildReviewPrompt`, and the
existing gate signal/result lifecycle. These seams are protected today by
`tests2/core/role-store.test.ts`, `tests2/core/config-cascade.test.ts`,
`tests2/core/workflow-store.test.ts`, `tests2/core/workflow-validator.test.ts`,
`tests2/core/inline-workflow-load.test.ts`, and
`tests2/core/verification-harness-command-scheduling.test.ts`.

## File plan and contracts

| File | Change | Contract / owner |
| --- | --- | --- |
| `defaults/roles/claude-protocol-scout.yaml` | Add the empirical protocol role. | It may run the opt-in real SDK/manual commands and write only fixtures or spike evidence. It records observed SDK version, command/setup, sanitized transcript or inventory evidence, and unresolved questions. It does not modify production code, spawn/merge goals, or signal gates. |
| `defaults/roles/backend-parity-reviewer.yaml` | Add a read-only Pi-regression reviewer. | It reviews only change-caused Pi blast radius: missing Pi default, shared seam drift, Pi snapshot/fixture changes, and undocumented SDK/Pi divergence. It reports file/line, causal path, minimal fix, and focused Pi regression. |
| `defaults/roles/billing-safety-auditor.yaml` | Add a read-only subscription-safety reviewer. | It blocks only paths that can silently select API billing or misrepresent subscription cost: inherited credentials, API/Bedrock/Vertex variables, untrusted settings, absent `apiKeySource` assertion, container fallback, or billed/notional conflation. It reports the exact leak path and test. |
| `.bobbit/config/project.yaml` | Add `workflows.claude-runtime`; do not alter `general` or existing workflows. | The workflow uses the existing inline YAML schema and gate DAG. The existing `bobbit` component commands are referenced structurally. |
| `docs/claude-agent-sdk-sessions.md` | Add a short “Review workflow selection” section. | Documents when operators/team leads choose `claude-runtime` versus `general`; it does not change runtime selection. |
| `tests2/core/claude-runtime-review-roles.test.ts` | Add real-file role schema, policy, resolver, and prompt-budget canary. | Reads the three shipped YAML roles through `RoleLoader`/`PackResolver`; asserts names, required fields, valid normalized policies, read-only policies for the two auditors, scout's limited evidence-writing policy, and bounded prompts. |
| `tests2/core/claude-runtime-review-workflow.test.ts` | Add real-file workflow schema, topology, role-reference, and review-step contract canary. | Parses the active project YAML, validates `claude-runtime` through `validateWorkflowDefinition` against the `bobbit` component, resolves every declared review role through the built-in role source, and pins gate/step ordering and required reviewer language. |
| `tests2/tests-map.json` | Register both core tests with their exact source/config reads. | Keeps affected-test selection correct. |

No production TypeScript is changed. The only new data are role templates and an
inline workflow. Goal snapshots remain owned by the existing `GoalManager`; a
workflow/role edit affects future resolution and does not rewrite an already
frozen goal.

### Role details

All roles use the normal role schema: `name`, `label`, `accessory`,
`promptTemplate`, optional `model`/`thinkingLevel`, and `toolPolicies`. Use the
existing role metadata convention and `anthropic/claude-opus-5` with `high`
thinking for the specialist work, as specified by §16. `RoleStore` accepts only
canonical thinking values and normalizes policy values to `allow`, `ask`, or
`never`.

- **`claude-protocol-scout`** — `radar`; `edit: ask` for fixture/evidence files
  and `bash: allow` for the explicitly requested empirical run. Deny
  `goal_spawn_child`, `goal_merge_child`, `team_delegate`, and `gate_signal`.
  Its prompt replaces the raw-CLI-only wording in §16 with the installed Agent
  SDK's real initialization/session/tool surface, while retaining §16's rule:
  no protocol claim without captured evidence. It must tag fixtures with the
  installed SDK/Claude Code version and never print tokens, auth files, raw
  environment, or credential-bearing paths.
- **`backend-parity-reviewer`** — `scales`; deny edits, delegation, goal
  mutations, and gate signals. Its checklist specifically covers SDK fixture
  drift under `tests2/fixtures/claude-sdk-event-translator/`, runtime selection
  (`claude-agent-sdk` only; absent/other provider is Pi), shared
  `IRpcBridge`/SessionManager behavior, Pi command snapshots, and translated
  transcript/usage events. It must not duplicate generic correctness/security
  review or report unchanged defects.
- **`billing-safety-auditor`** — `shield-check`; the same read-only policy.
  Its prompt names the subscription-only invariant and checks closed SDK env
  construction, explicit settings isolation, `apiKeySource`, forbidden API,
  auth, Bedrock, Vertex, and cloud credential inputs, unsupported-sandbox
  failure instead of API fallback, and separate notional versus billed costs.
  It requires an environment-pollution regression test for each changed env or
  spawn boundary.

Each reviewer follows the existing verifier contract: read injected context and
diff as appropriate, return only change-caused findings, and call
`verification_result`; it never produces gate content or calls `gate_signal`.
The workflow prompts keep responsibility narrow so code/security/spec reviewers
remain useful rather than duplicated.

## `claude-runtime` workflow

The new inline definition follows the existing component and phase convention.
Phase 0 builds, phase 1 runs deterministic suites, and phase 4 runs independent
reviews only after both command phases pass; arbitrary ascending phases are
already scheduled by `groupStepsByPhase` in `verification-logic.ts`.

```text
protocol-spike (content, inject downstream)
  └─ design-doc (content, inject downstream)
       └─ implementation
            └─ dogfood (content)
            └─ documentation (content)
                 └─ ready-to-merge
```

`dogfood` and `documentation` both depend on `implementation`, matching §16;
`ready-to-merge` depends on both of them. It retains the ordinary branch-push,
base-sync, and PR checks at Ready to Merge. It does not invent a publication
mechanism.

| Gate | Existing step types / required verification |
| --- | --- |
| `protocol-spike` | Content/injected. `architect` verifies claims are empirical and fixtures are version tagged; `spec-auditor` compares open questions with the goal. The scout produces this evidence as a normal assigned task, not a new gate executor. |
| `design-doc` | Depends on spike; content/injected. `architect` checks SDK event/bridge/transcript design against evidence. New parity and billing reviewers check named Pi guards and structural subscription safety before implementation. |
| `implementation` | Depends on design. Structural `bobbit` commands: `build` at phase 0; `check`, `unit`, `browser`, and `e2e` at phase 1 (the existing project commands). Phase 4 runs parity, billing, spec, code, verifiable-bug, and security reviews. The parity prompt owns fixture/tool-policy/transcript/usage fidelity; billing owns API-fallback safety. |
| `dogfood` | Depends on implementation; content. `qa-tester` reviews a submitted manual matrix, not an invented automated test. It must contain the real-model command, SDK/model version, sanitized result, and screenshots where UI rendering was exercised. |
| `documentation` | Depends on implementation; content. `docs-writer` verifies `docs/claude-agent-sdk-sessions.md` describes subscription-only behavior, accepted runtime gaps, and workflow selection; AGENTS.md remains unchanged unless a separate change has a one-line pointer. |
| `ready-to-merge` | Depends on dogfood and documentation. Reuses standard push/base/PR command steps. |

### Evidence and failure handling

The workflow fails loudly rather than accepting inferred safety:

- A missing, stale-version, malformed, or unsanitized protocol fixture fails
  `protocol-spike`; implementation cannot begin because the DAG blocks it.
- A missing reviewer role, malformed workflow YAML, unknown component command,
  unknown dependency, or invalid step shape is rejected by existing role/workflow
  loading/validation before a meaningful verification run.
- A changed shared Pi seam with no named regression guard is a parity finding;
  an absent runtime value that does not resolve to Pi is a blocker.
- Raw `mcp__bobbit__*` names used as persisted policy/rendering/dispatch names,
  fixture drift that loses root/child partitioning, or usage values that collapse
  subscription notional cost into billed cost are parity findings. Canonical
  identity must remain the normalized Bobbit name.
- Any child environment/settings path that can admit API, auth-token, Bedrock,
  Vertex, cloud, or `apiKeyHelper` fallback is a billing blocker. “Run it in a
  container with an API key” is not a mitigation; unsupported sandbox is the
  safe outcome.
- A missing real-model run is a dogfood failure, not a reason to silently mark
  the matrix N/A. It may be intentionally deferred only for workflow selection
  rows that explicitly omit dogfood before end-to-end SDK behavior exists.

## Test plan

### Declarative schema and resolution

`claude-runtime-review-workflow.test.ts` will parse
`.bobbit/config/project.yaml`, select `workflows.claude-runtime`, and pass its
raw object to `validateWorkflowDefinition` with the declared `bobbit` component
commands. It asserts the exact gate IDs/dependencies above, `content` and
`inject_downstream` only where required, structural command names/phases,
non-empty prompts, and no bespoke step type. It also asserts all review-step
roles resolve through a real `PackResolver` with `RoleLoader` against
`defaults/roles`; this catches a typo or a renamed default role before a gate
spawns a reviewer.

`claude-runtime-review-roles.test.ts` loads all three files through the same
loader and `resolveRole`, asserting exact names (preventing accidental role
renames), model/thinking validity, canonical normalized policies, and policy
ceilings. It verifies the auditors cannot edit/delegate/signal and the scout
cannot alter production/orchestration surfaces. It also asserts each specialty
prompt contains the required concern vocabulary: SDK fixture/version evidence;
Pi default/fixture/transcript/usage/tool-name normalization; and
subscription-only/API-key/settings/`apiKeySource`/notional-cost safety.

### Prompt budget

The role test enforces UTF-8, not JavaScript character, budgets:

- each new role `promptTemplate` is at most **8 KiB**;
- each `claude-runtime` `llm-review` prompt is at most **4 KiB**; and
- a role template plus its workflow step prompt is at most **12 KiB** before
  `buildReviewPrompt()` adds shared, goal, and gate context.

The test should construct a representative `buildReviewPrompt()` for one
specialist step and assert its fixed author-controlled prefix stays within the
same combined allowance. Dynamic goal/diff/gate content is deliberately outside
this cap because it is owned by the existing context assembly and has different
size controls. These limits prevent the safety checklists from becoming a
per-review prompt regression without imposing a new runtime prompt subsystem.

### Deterministic and manual coverage

The implementation gate retains `npm run build`, `npm run check`,
`npm run test:unit`, `npm run test:browser`, and `npm run test:e2e`. Focused
runtime test evidence reviewed by the new roles must include existing contracts
where applicable:

- `tests2/core/claude-sdk-event-translator.test.ts` plus
  `tests2/fixtures/claude-sdk-event-translator/` for ordering, child partition,
  tool-result, and terminal/usage fixture fidelity;
- `tests2/core/claude-agent-sdk-tool-surface.test.ts` and
  `tests2/integration/claude-agent-sdk-tool-permissions.test.ts` for canonical
  `mcp__bobbit__<name>` normalization and policy/grant enforcement;
- `tests2/integration/claude-agent-sdk-runtime-persistence.test.ts` and
  `tests/e2e/claude-agent-sdk-session-restart.spec.ts` for co-resident Pi
  behavior, SDK persistence/resume, and no Pi `switch_session` on SDK restore.

Dogfood requires the opt-in, gate-exempt subscription smoke already provided by
`tests/manual-integration/claude-agent-sdk-lifecycle.spec.ts`:

```bash
BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 \
MANUAL_CLAUDE_AGENT_SDK_MODEL=<unprefixed-sdk-model-id> \
npm run test:manual -- --grep "Claude Agent SDK lifecycle"
```

Run it only with a local subscription. The submitted content records command,
installed SDK/Claude version, model id, readiness/prompt/steer/interrupt/stop
outcomes, sanitized `apiKeySource`/subscription evidence, transcript and usage
rendering observations, and screenshots for any browser-visible rendering case.
It must not persist or expose credentials. This manual run complements rather
than replaces deterministic tests.

## Selection documentation and acceptance criteria

Add the following selection guidance to `docs/claude-agent-sdk-sessions.md`:

| Work scope | Workflow |
| --- | --- |
| Empirical SDK/protocol fixture investigation (G0) | `claude-runtime`, `protocol-spike` only |
| Isolated setup/selection work with no user-visible SDK session yet (G1–G2) | `claude-runtime` with dogfood explicitly omitted |
| First end-to-end SDK session and runtime/tool/persistence work (G3–G8), including tool normalization or transcript/usage changes | Full `claude-runtime` |
| A billing/auth spike | Start with `protocol-spike`; stop rather than fallback if subscription-only cannot be demonstrated |
| Nested transcript rendering (G10b) | Full `claude-runtime` because dogfood is required |
| Work unrelated to Claude runtime safety (for example generic docs/G11) | Existing `general` workflow |

The implementation is accepted when:

1. The three exact new role names load from the default role pack, normalize
   their policies, and resolve for every workflow review step.
2. `claude-runtime` validates as an inline workflow and has the specified DAG,
   existing command steps, and no new verification engine/type.
3. The specialist prompts cover SDK fixture drift, Pi default parity,
   canonical/raw tool-name boundaries, transcript/usage fidelity, and
   subscription-only safety without duplicating generic reviewers.
4. Schema, real-role resolution, and fixed prompt-budget tests are registered
   in `tests2/tests-map.json` and pass with the existing core suite.
5. Selection guidance is present in the SDK session documentation.
6. Full-workflow dogfood accepts only recorded, sanitized real-model manual
   evidence; deterministic test success alone cannot satisfy that gate.
