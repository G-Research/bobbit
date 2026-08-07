# Claude runtime review workflow

## Decision

`claude-runtime` is a project workflow for Claude Agent SDK changes that need
runtime-specific evidence without creating a parallel verifier. It composes the
existing inline-workflow schema, role resolution, command/review steps, gate
signals, and `verification_result` lifecycle. The workflow does not add a gate
engine, transport, session state owner, or runtime-selection branch.

SDK runtime selection remains independent: only
`claude-agent-sdk/<model-id>` selects the SDK; absent providers and other
providers, including `anthropic/*`, remain Pi-backed. The workflow's roles do
not set `model`, so they inherit the resolved goal model rather than pinning an
API provider. This avoids making a review configuration alter billing or runtime
routing.

## Delivered configuration

The three specialist role templates resolve from the built-in role pack through
the normal `PackResolver` and role cascade:

| Role | Accessory | Responsibility |
| --- | --- | --- |
| `claude-protocol-scout` | `flask` | Produces narrow, version-tagged and sanitized observations of the installed SDK's initialization, session, event, and tool behavior. It may request fixture/evidence edits, but is not a gate verifier. |
| `backend-parity-reviewer` | `magnifier` | Read-only review of change-caused SDK/Pi divergence: selection defaults, shared bridge/session seams, fixture drift, canonical tool-policy identities, and transcript/usage partitioning and accounting. |
| `billing-safety-auditor` | `shield` | Read-only review of subscription-only authentication, closed settings/environment construction, `apiKeySource` proof, fail-closed sandbox behavior, and billed-versus-notional cost fidelity. |

The scout has `thinkingLevel: high`; none of the three role files pins a model.
The two auditors submit ordinary `verification_result` verdicts and cannot edit,
delegate, or signal gates. The scout supplies evidence to the task owner instead
of acting as a verifier. All gate signaling remains with the team lead.

## Full workflow

The registered `claude-runtime` workflow is validated against the project's real
`bobbit` component command table. Its implementation commands reference the
configured `build`, `check`, `unit`, `browser`, and `e2e` commands rather than a
separate command registry.

```text
protocol-spike → design-doc → implementation
                                ├─ dogfood
                                └─ documentation
                                      \ /
                               ready-to-merge
```

| Gate | Existing verification contract |
| --- | --- |
| `protocol-spike` | Content gate. `architect` reviews empirical evidence; `spec-auditor` reviews the content against the goal. The scout can produce the evidence as a normal task. |
| `design-doc` | Content gate after the spike. `architect`, parity, and billing reviews check the smallest viable design, Pi compatibility, and subscription boundary. |
| `implementation` | Runs the component-table build command in phase 0; `check`, `unit`, `browser`, and `e2e` in phase 1; then parity, billing, spec, code, bug, and security reviews in phase 4. |
| `dogfood` | Content gate after implementation. `spec-auditor`, not `qa-tester`, reviews the submitted real-subscription evidence. |
| `documentation` | Content gate after implementation. `docs-writer` checks the SDK-session guidance and workflow selection documentation. |
| `ready-to-merge` | Waits for dogfood and documentation, then runs the standard branch-push, base-sync, and PR checks. |

Each verifier consumes the normal upstream gate context and returns through the
existing result lifecycle. The workflow introduces no special reviewer process
or gate state. The reviewer roles cover distinct concerns so ordinary spec,
code, bug, and security review is not replaced.

## Evidence and safety boundary

Protocol claims require captured, sanitized evidence tagged with the installed
SDK and Claude versions, the minimal setup, the observation, and unresolved
questions. A stale, malformed, or incomplete fixture is an unresolved question,
not a basis for extrapolating a contract.

The parity review protects the boundaries that are easy to regress when SDK code
shares a backend with Pi:

- SDK selection remains explicit and Pi retains the absent/other-provider path.
- SDK fixtures preserve observed initialization/session/tool behavior, including
  root/subagent partitioning, ordering, terminal events, transcript details, and
  usage information.
- Persisted policy, dispatch, and rendering use canonical Bobbit tool names,
  never raw `mcp__bobbit__*` aliases.
- Usage must not collapse subscription notional usage into billed cost or double
  count either basis.

The billing review rejects inherited or fallback API, auth, Bedrock, Vertex,
cloud, proxy, or container credentials on the subscription-only path. Changed
environment, settings, process, container, restore, or fallback boundaries need
a focused pollution test that demonstrates the allowed configuration and
fail-closed behavior.

Full-workflow dogfood is deliberately manual and real-model based. Its content
must include the opt-in command, SDK/Claude version, unprefixed model ID,
sanitized `apiKeySource`/subscription proof, readiness, prompt, steer,
interrupt, and stop outcomes, transcript and usage observations, and screenshots
for exercised browser-visible rendering. It must not include credentials, raw
environment values, or authentication files. Deterministic coverage complements
this evidence but cannot replace it.

## Selection and snapshot rules

Use the full named workflow for a user-visible SDK session, tool, persistence,
transcript/usage, billing, or rendering change. Use a goal-specific inline
snapshot for protocol-only investigation or reduced setup/selection work; record
which gates are omitted and why, and do not claim end-to-end coverage when
real-subscription dogfood is omitted. Use `general` when the work does not touch
the Claude-runtime safety contract.

A named project workflow is copied into the goal at creation. That frozen copy
keeps an active goal's verification requirements stable when the project workflow
template changes. A valid inline workflow is likewise a goal-specific snapshot.
Changing an active goal requires the explicit
workflow-replacement flow and normal validation, rather than mutating the
project template or bypassing a gate. See [Goals, Workflows, Tasks & Gates](../goals-workflows-tasks.md#workflows)
and [Claude Agent SDK sessions](../claude-agent-sdk-sessions.md#review-workflow-selection).

## Validation coverage

The workflow and role contract tests load the shipped YAML and active project
configuration rather than testing a copy. They verify:

- role schema, resolution, normalized policy ceilings, no model pin, registered
  accessory, and fixed prompt budgets;
- the `claude-runtime` DAG, existing verification step types, specialist role
  references, dogfood content-review responsibility, and evidence language;
- validation of the actual workflow against the actual project component table,
  including the `bobbit` command names and phases; and
- role plus workflow prompt-size budgets before dynamic goal, diff, and gate
  context is added.

This makes configuration drift visible while retaining the existing workflow
validator and verification harness as the single execution path.
