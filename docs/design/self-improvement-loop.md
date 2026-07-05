# Self-Improvement Loop

## Problem

Bobbit already emits enough local evidence to learn which prompts, gates, workflows, and proposals are helping or hurting a goal. What is missing is a bounded loop that turns completed-session evidence into review findings, converts high-confidence findings into reviewable feature offerings, and measures whether the offering actually improved future runs.

This design keeps self-improvement behind human-visible artifacts. It does not propose unattended source edits. The first useful loop is: observe a completed goal, write a structured session review, surface a proposal through the existing proposal machinery, and compare the next goal or workflow variant against the prior baseline.

Could not verify: the fable-refactor README references seed docs named `autoimprovement.md` and `mission-control.md`, but those files were not present under `/Users/aj/Documents/dev/bobbit-fable-refactor` in this checkout. I verified summary references in the fable-refactor README and raw JSON instead of treating the missing files as primary sources.

## Today's state

- The current goals/workflows model already separates goal proposals, workflow execution, and task state. The proposal flow is documented in `docs/goals-workflows-tasks.md:73`, workflow validation in `docs/goals-workflows-tasks.md:108`, and the workflow data model in `docs/goals-workflows-tasks.md:162`.
- The architecture assumes persistent sessions, a gateway process, and a side-panel workspace. Session list synchronization is described in `docs/architecture.md:38`, and the side panel's task/worktree/PR workspace is described in `docs/architecture.md:46`.
- Cost telemetry exists today in `src/server/agent/cost-tracker.ts`. `RawSessionCost` includes `cacheWrite1hTokens` at `src/server/agent/cost-tracker.ts:14`, `SessionCost` exposes derived cache write fields at `src/server/agent/cost-tracker.ts:71`, and provider usage accepts `cacheWrite1hTokens` at `src/server/agent/cost-tracker.ts:83`.
- Cost persistence is already suitable for a review job. The tracker writes `.bobbit/state/session-costs.json` with a debounced save path at `src/server/agent/cost-tracker.ts:192`, uses atomic writes in `saveNow()` at `src/server/agent/cost-tracker.ts:257`, records per-message usage at `src/server/agent/cost-tracker.ts:329`, and aggregates goal cost at `src/server/agent/cost-tracker.ts:374`.
- Cost snapshots are visible to clients. The WebSocket protocol includes optional `cacheWrite1hTokens` and `cacheWrite5mTokens` in `src/server/ws/protocol.ts:84`, and emits `cost_update` at `src/server/ws/protocol.ts:253`.
- Prompt-section telemetry is already persisted per session. `PromptSection` is defined in `src/server/agent/system-prompt.ts:438`, `getPromptSections()` builds labeled token sections at `src/server/agent/system-prompt.ts:598`, `persistPromptSections()` writes `<sessionId>-prompt.json` at `src/server/agent/system-prompt.ts:713`, and the REST endpoint reads those sections at `src/server/server.ts:15764`.
- Session setup persists prompt sections before assembling the prompt in `src/server/agent/session-manager.ts:2798`. This gives the review job a stable before-run prompt breakdown without scraping transcripts.
- Gate verification already emits step status and durations. The WebSocket protocol defines gate verification events at `src/server/ws/protocol.ts:262`, and the harness broadcasts `gate_verification_step_complete` with `durationMs` at `src/server/agent/verification-harness.ts:3533`.
- Gate cache decisions are available in the gate code path. `buildContentStepCache()` returns `{ cache, decisions }` at `src/server/agent/verification-logic.ts:891`, and the harness logs structured gate-cache decisions while resolving `BOBBIT_GATE_CACHE` at `src/server/agent/verification-harness.ts:3300`.
- The provider context trace store exists, but this checkout does not yet persist `TraceEntry.decisions[]`. The verified `TraceEntry` shape only has `ts`, `hook`, `sessionId`, and `providers` at `src/server/agent/context-trace-store.ts:12`; the CLF-W1a seam for future decision traces is an in-memory `decisionTrace` and TODO in `src/server/agent/lifecycle-hub.ts:169`.
- The server exposes the current context trace at `src/server/server.ts:6075`, and provider hooks refresh dynamic prompt-section telemetry before prompt/compact paths at `src/server/server.ts:5940`.
- Proposal machinery already exists. The proposal extension registers proposal tools in `defaults/tools/proposals/extension.ts:1`, implements `propose_goal` at `defaults/tools/proposals/extension.ts:113`, and implements role/tool/staff/project proposals at `defaults/tools/proposals/extension.ts:167`.
- Proposal files are already atomic, snapshotted, and broadcastable. Proposal types live in `src/server/proposals/proposal-files.ts:75`, draft paths at `src/server/proposals/proposal-files.ts:101`, snapshots at `src/server/proposals/proposal-files.ts:113`, atomic writes at `src/server/proposals/proposal-files.ts:241`, and WebSocket rehydration at `src/server/ws/handler.ts:564`.
- Goal completion already has a compact server-owned lifecycle context. `GoalCompletedCtx` includes goal/project/session, gate, task, touched-file, PR, and metadata summaries in `src/server/agent/lifecycle-hub.ts:55`. That is the narrowest hook for a post-goal review job.
- Verified A/B levers in this checkout are `BOBBIT_GATE_CACHE` and `BOBBIT_DOC_GATE_FILTER`. `BOBBIT_DOC_GATE_FILTER=off` is documented in `docs/goals-workflows-tasks.md:648` and implemented at `src/server/agent/verification-logic.ts:600`; `BOBBIT_GATE_CACHE=content` is implemented at `src/server/agent/verification-harness.ts:3312` and documented in `docs/design/gate-step-cache.md:3`.
- Could not verify `BOBBIT_PARALLEL_REVIEWS` or `BOBBIT_AGENTSMD_BUDGET` in this checkout. Treat them as intended A/B levers if the target branch has tonight's changes landed.

## Design

### Session-review pipeline

Add a post-goal analysis job that runs after a goal reaches a terminal state. The job should be deterministic and cheap in its first version, with an optional LLM reviewer only after the evidence bundle is bounded.

The input bundle should include:

- Goal completion context from `GoalCompletedCtx`.
- Goal and session cost from `CostTracker`, including `cacheWrite1hTokens`, `cacheWrite5mTokens`, cache reads, input/output tokens, and total cost.
- Per-section prompt breakdowns from `<sessionId>-prompt.json`.
- Gate verification events, step durations, gate cache decisions, and final gate status.
- Context trace provider rows, plus `TraceEntry.decisions[]` once CLF-W1a is persisted in the target branch.
- Proposal activity for the goal: proposals written, edited, restored, accepted, rejected, or abandoned.
- Compact transcript excerpts only where needed for evidence. The review record should prefer file/state references over raw conversation text.

The output should be a structured review artifact, for example:

```ts
type SessionReviewFinding = {
  id: string;
  goalId: string;
  sessionIds: string[];
  category:
    | "prompt-bloat"
    | "tool-budget"
    | "gate-latency"
    | "gate-flake"
    | "cache-policy"
    | "workflow-variant"
    | "proposal-opportunity"
    | "successful-pattern"
    | "missing-telemetry";
  severity: "info" | "low" | "medium" | "high";
  confidence: number;
  evidence: Array<{
    kind: "cost" | "prompt-section" | "gate-step" | "trace" | "proposal" | "task" | "transcript";
    ref: string;
    summary: string;
  }>;
  recommendation: string;
  proposedChange?: {
    proposalType: "goal" | "project" | "role" | "tool" | "staff" | "workflow";
    title: string;
    body: string;
  };
  abHypothesis?: {
    lever: string;
    variantA: string;
    variantB: string;
    metric: string;
  };
};
```

Store reviews under project state, not source control, for example `<stateDir>/session-reviews/<goalId>.json`. A review can later be promoted into a proposal file, but the raw review is operational telemetry.

### Auto-feature offerings

Auto-feature-offerings should be proposal-first. The loop should never silently edit `AGENTS.md`, workflow packs, tool descriptions, skills, or source code.

The offering layer should map findings onto existing proposal types:

- New or revised follow-up goals -> `propose_goal`.
- Project configuration, workflow notes, or repository guidance -> `propose_project`.
- Role changes -> `propose_role`.
- Tool changes -> `propose_tool`.
- Staff/mission-control style responsibilities -> `propose_staff`.

A later `propose_improvement` tool may be useful, but it should be a thin wrapper over registered proposals rather than a parallel artifact system. The existing proposal files already provide atomic writes, snapshots, restore, edit, and WebSocket updates.

Auto-generated offerings should include:

- The finding ids that caused the offering.
- Confidence and severity.
- The proposed diff or workflow change in human-readable form.
- An A/B hypothesis when the change is measurable.
- A clear "why now" summary from evidence, not from model intuition alone.

### A/B mechanics

Use workflow variants and goal metadata as the assignment unit. A goal run should record:

- Experiment id.
- Variant id.
- Enabled `BOBBIT_*` flags.
- Workflow id and version.
- Goal/session ids.
- Start and terminal timestamps.
- Review artifact id.

The initial A/B levers are:

- `BOBBIT_GATE_CACHE`: default `sha` versus `content`.
- `BOBBIT_DOC_GATE_FILTER`: default enabled versus explicit `off`.
- `BOBBIT_PARALLEL_REVIEWS`: intended lever for serial versus parallel reviews; could not verify in this checkout.
- `BOBBIT_AGENTSMD_BUDGET`: intended lever for AGENTS.md prompt-budget behavior; could not verify in this checkout.

The core metrics are wall time, gate pass rate, gate re-run count, cache hit rate, token cost, `cacheWrite1hTokens`, prompt-section token share, user intervention count, proposal acceptance rate, and follow-up defect rate when it can be observed.

## Phased implementation plan

### Phase 1 - S: read-only review artifacts

Implement a `SessionReviewStore` and a goal-completion lifecycle provider. The provider should collect bounded evidence and write a review JSON file without surfacing proposals yet.

File seams:

- Add `src/server/agent/session-review-store.ts`.
- Register from the lifecycle path around `GoalCompletedCtx` in `src/server/agent/lifecycle-hub.ts:55`.
- Reuse `CostTracker.getGoalCost()` from `src/server/agent/cost-tracker.ts:374`.
- Reuse `loadPersistedPromptSections()` from `src/server/agent/system-prompt.ts:733`.
- Read context traces through `ContextTraceStore` in `src/server/agent/context-trace-store.ts:21`.
- Expose a read route near the existing prompt/context routes, for example beside `src/server/server.ts:6075` or `src/server/server.ts:15764`.

### Phase 2 - M: deterministic finding generator

Add rule-based findings before adding LLM judging. Start with rules that are directly explainable:

- Prompt section exceeds a configured token share.
- AGENTS/project/tool sections dominate total prompt tokens.
- Gate step duration dominates the verification run.
- Gate cache misses or bypasses repeat across similar content.
- `cacheWrite1hTokens` or cache writes exceed a configurable share of input tokens.
- Provider context refresh repeatedly returns errors or no-op sections.
- A successful manual proposal pattern recurs across multiple goals.

File seams:

- Add finding rules beside the review store, or under `src/server/agent/session-review-rules.ts`.
- Use gate verification event shapes from `src/server/ws/protocol.ts:262`.
- Use gate cache decision data from `src/server/agent/verification-logic.ts:891`.

### Phase 3 - M: proposal surfacing

Convert selected findings into registered proposal drafts. This should be opt-in per finding category until the signal quality is known.

File seams:

- Reuse proposal type registration in `src/server/proposals/proposal-types.ts:1`.
- Reuse proposal writes and snapshots in `src/server/proposals/proposal-files.ts:241`.
- Reuse WebSocket proposal rehydration in `src/server/ws/handler.ts:564`.
- Add a small server-side adapter that maps `SessionReviewFinding.proposedChange` to existing proposal frontmatter.

### Phase 4 - L: experiment assignment and reporting

Add a first-class experiment assignment record to goal metadata and carry it into the session review. The first implementation can use explicit workflow variants and environment flags; later it can assign automatically based on project policy.

File seams:

- Workflow metadata from `docs/goals-workflows-tasks.md:162`.
- Gate flags in `src/server/agent/verification-harness.ts:3312` and `src/server/agent/verification-logic.ts:600`.
- Goal metadata in `GoalCompletedCtx` at `src/server/agent/lifecycle-hub.ts:55`.

### Phase 5 - L: graduated autonomy

After reviews and proposals have proved useful, add policy levels:

- `off`: collect reviews only.
- `suggest`: create human-visible proposals.
- `draft`: prepare exact edits but do not apply.
- `apply-low-risk`: apply only whitelisted pack/config/prompt changes after explicit project policy allows it.

This phase should wait for a Mission Control or flight-recorder surface so users can audit what the improver saw, decided, offered, and changed.

## Risks

- False attribution: a gate failure may be caused by source changes, environment, or flaky tests rather than workflow design.
- Self-reinforcement: the improver may optimize for local metrics while making the product worse.
- Proposal noise: low-confidence findings can flood the existing proposal surface.
- Privacy and retention: transcripts and prompt sections may include sensitive project data.
- Cost overhead: an LLM reviewer can erase the savings it recommends unless the evidence bundle is capped.
- Flag drift: A/B reports are invalid if flag states are not recorded with the goal/session.
- Incomplete telemetry: this checkout does not yet persist `TraceEntry.decisions[]`; the design must degrade gracefully to provider traces and gate decisions.

## A-B-testability

The self-improvement loop is itself testable. Run a control group that writes reviews only and a treatment group that also surfaces proposal drafts. Compare proposal acceptance, user dismissals, follow-up fixes, gate pass rate, and token cost.

For infrastructure changes, use the existing and intended `BOBBIT_*` flags as levers. For workflow changes, use workflow variants with explicit assignment metadata. A review artifact should always name the experiment and variant that generated it; otherwise it is evidence, not an A/B result.

