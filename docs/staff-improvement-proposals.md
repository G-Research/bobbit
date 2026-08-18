# Staff-improvement proposal fixture

Bobbit has a deliberately narrow, **test-only** example of a scheduled staff-improvement decision. It demonstrates how an active, granted extension can ask to seed an existing editable proposal. It is not a production transcript-analysis feature and does not add a staff-specific proposal API or UI.

The fixture lives in `market-packs/_fixtures/staff-proposal-advisor/`. It is default-uninstalled; tests install an isolated copy explicitly. Production ships no transcript classifier and does not supply fixture signals.

This boundary matters because an extension may identify a possible improvement, but it must never turn that observation into a configuration or workflow change without two separate human decisions: consent to create a draft, then normal acceptance of that draft.

## Authoring the scheduled decision

A scheduled decision is a schema-2 `afterTurn` decision hook with a persisted every-N cadence and `kind: decision`:

```yaml
# pack.yaml
schema: 2
contents:
  roles: []
  tools: []
  skills: []
  hooks: [staff-improvement]
```

```yaml
# hooks/staff-improvement.yaml
id: staff-improvement
module: ../lib/staff-improvement.mjs
events: [afterTurn]
mode: decide
capabilities: []
schedule: { everyNTurns: 3, kind: decision }
budget: { maxTokens: 64, timeoutMs: 1000 }
```

The project operator must grant the exact tuple `(packId, hookId, "decide")`; enabling a pack or declaring `mode: decide` is not a grant. The dispatcher checks that the pack and hook are still active and that this exact grant exists immediately before `decide()`, then repeats the check after the worker returns and immediately before it creates a decision request. A disable, removal, shadowing, or grant revocation that races the worker therefore drops its late result. `onDecision()`, when present, is also rechecked before delivery.

The turn counter is server-owned. It increments and persists at each completed agent turn **before** detached lifecycle dispatch, so a restore, respawn, compaction, or process crash cannot replay a due turn. A hook with `everyNTurns: 3` is due at persisted cadence turns 3, 6, 9, and so on. Scheduled dispatch does not delay session idle, queue draining, or later turns.

`wallClockMs` remains inert metadata: it starts no timer, deadline, catch-up job, or wall-clock invocation. A declaration with `kind: decision` but no `everyNTurns` likewise remains an ordinary `decide` hook; it preserves ordinary decision-dispatch compatibility rather than acquiring scheduling semantics. A hook with an every-N schedule but no `kind: decision` belongs only to the existing advisor path, not this decision path.

## Fixture-only signal seam

The fixture's module receives `staffImprovementSignals` only through a test seam. The production dispatcher does not read transcripts, messages, prompts, or tool results to build it.

When a test provides signals, their shape is deliberately fixed and bounded:

```ts
{
  windowTurns: 3, // integer 1..20
  patterns: [{ kind: "repeated-user-correction", count: 1 }]
}
```

The only accepted pattern labels are `repeated-user-correction`, `repeated-tool-failure`, and `repeated-goal-blocker`; each label appears once and each count is an integer from 1 through 20. Malformed data is discarded. This is a seam for exercising the consent and proposal routes, not a classifier design or a promise that Bobbit will retain/analyse transcript text in production.

The shipped fixture returns no result unless it sees a positive `repeated-user-correction` signal. Its bounded sample request is:

```js
export async function decide(ctx) {
  if (!ctx.staffImprovementSignals?.patterns.some(
    ({ kind, count }) => kind === "repeated-user-correction" && count > 0,
  )) return undefined;

  return {
    kind: "request",
    request: {
      version: 1,
      key: "staff-improvement-v1",
      title: "Suggested workflow improvement",
      question: "Recent session patterns suggest an improvement. Create an editable draft?",
      options: [
        { value: "create", label: "Create draft" },
        { value: "decline", label: "Not now" },
      ],
      other: { maxLength: 280 },
      scope: "session",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      requestedClass: "consent-required",
      intent: "staff-improvement",
      effect: {
        kind: "proposal",
        proposals: {
          create: { proposalType: "goal", args: { title: "Improve staff workflow guidance", spec: "Investigate the observed correction pattern and propose an explicit workflow or AGENTS.md guidance improvement." } },
        },
        noEffectValues: ["decline", "other"],
      },
    },
  };
}
```

## Consent and proposal boundary

For a **scheduled** proposal effect, core admits only one precise shape:

- exactly one seed, keyed by option value `create` with label `Create draft`;
- every other declared option and `other` appears in `noEffectValues`;
- no seed exists for any value except `create`.

Core removes any extension-provided default and forces `requestedClass: "consent-required"` before persistence. Thus consent can never default into a draft. A malformed, inverted, or broader effect is dropped before a durable request is created.

Only an explicit user answer choosing `create` calls `ProposalSeedService`. It uses the originating session and the ordinary proposal validation/write/panel route, creating only the standard editable draft. It has no proposal-acceptance or configuration-mutation capability.

`decline`, `Other`, expiry, headless handling, failed/revoked authorization, and every non-create settlement create nothing. The decision store remains the authoritative durable record of resolution, including bounded validated `Other` text when the user supplies it. The Context trace records only a fixed, bounded decision outcome and never retains Other text or proposal body.

A created draft still needs ordinary proposal review, editing, and acceptance. Dismissing it deletes the draft; accepting it is the second, normal approval. There is no automatic goal, workflow, staff, skill, or AGENTS.md change and no bespoke “staff proposal” panel.

The normal decision-request REST projection and proposal-draft endpoints are unchanged; see [Extension decision requests](extension-decision-requests.md), [Proposal drafts](rest-api.md#proposal-drafts), and [Extension capability grants](extension-capability-grants.md).

## Testing the fixture

The focused integration test verifies that the fixture is default-uninstalled, becomes due only at its third persisted turn, and emits the constrained consent/goal seed:

```bash
npm run test:unit -- tests2/integration/staff-proposal-fixture.test.ts
```

The browser journey explicitly installs an isolated fixture copy, supplies the bounded test signal, grants `decide`, and verifies both outcomes: decline stays draft-free after reload; `Create draft` opens the normal goal proposal, which can be edited and dismissed without applying a goal.

```bash
npx playwright test tests2/browser/e2e/staff-proposal-fixture.spec.ts --config playwright-v2.config.ts --project browser-v2-e2e --retries=0
```

These tests are intentionally the only place that installs the fixture or injects staff-improvement signals. Do not promote either mechanism into production wiring without a separate, transcript-safe data-owner and privacy design.
