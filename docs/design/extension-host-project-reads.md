# Extension Host project reads

**Status:** implemented in Host contract v7. `HOST_API_VERSION` remains `1`.

## Context

Extension panels often combine pack-owned data with a few Bobbit project records. The Host API
provides six granular reads so a panel can fetch only the staff, sessions, goals, tasks, gates, and
pull-request status it is showing. Bobbit remains the owner of project state and returns stable
contract summaries rather than persisted records.

This design keeps three boundaries aligned:

- pack routes own extension-specific data;
- `host.project` owns reusable Bobbit project facts;
- project notifications announce committed changes and prompt focused rereads.

The result adds no extension-side project model, persistence, or cache owner.

## Public contract

Host contract history is additive:

- v5 added canonical session and project notifications;
- v6 added the required `host.ui.createBobbitSprite` presentation API;
- v7 adds authenticated on-demand project reads.

`HOST_API_VERSION` stays at `1`. A pack should feature-detect reads through
`host.capabilities.projectReads` or `host.capabilities.has("projectReads")` rather than infer
support from member presence.

```ts
interface HostProjectApi {
  readStaff(selector?: HostProjectSelector): Promise<HostProjectRead<HostStaffSummary>>;
  readSessions(selector?: HostProjectSelector): Promise<HostProjectRead<HostSessionSummary>>;
  readGoals(selector?: HostProjectSelector): Promise<HostProjectRead<HostGoalSummary>>;
  readGoalTasks(
    goalId: string,
    selector?: HostProjectSelector,
  ): Promise<HostProjectRead<HostTaskSummary> | HostGoalReadError>;
  readGoalGates(
    goalId: string,
    selector?: HostProjectSelector,
  ): Promise<HostProjectRead<HostGateSummary> | HostGoalReadError>;
  readGoalPullRequest(
    goalId: string,
  ): Promise<HostLookupResult<HostPullRequestSummary | null>>;
}
```

Six named methods are the smallest durable composition. Each maps to one project fact family,
keeps result typing direct, and gives future redaction changes a clear owner. A page-or-IDs selector
avoids separate list and lookup methods without adding a free-form expansion point.

## Availability and scope

Project reads are automatically available to an authenticated Host API created for a validated
pack-owned browser surface: a tool renderer, panel, or entrypoint launcher. The host internally
binds that surface reference to its winning pack contribution. Server route handlers do not receive
browser project reads. Authors do not declare access in `pack.yaml`.

The browser API holds the opaque surface binding. A read accepts no project, session, pack, tool,
token, or transport identity from extension code. For every call, the host:

1. resolves one unambiguous project from the authenticated bound session;
2. validates that the surface still belongs to the same session and the active winning pack;
3. applies the normal tool authorization when the surface is tool-bound;
4. rechecks the session-to-project binding immediately before reading;
5. reads the canonical stores for that resolved project.

Missing, expired, stale, inactive, cross-session, and cross-project authority fails closed. A live
and persisted session disagreement during a project move also fails closed rather than choosing one
project. The caller cannot redirect a read by supplying an identity field.

Provider/server-only and unbound Host instances do not advertise `projectReads`. Normal feature
detection therefore covers both contract age and surface eligibility.

## Selection and result semantics

### Bounded pages

Omitting a selector starts a page at cursor `0` with limit `50`.

```ts
type HostProjectPageSelector = {
  mode?: "page";
  cursor?: number;
  limit?: number;
};
```

The cursor is a numeric offset. Limits are clamped to `1`–`200`. Results retain the canonical
source order and return:

```ts
interface HostProjectPage<T> {
  mode: "page";
  items: T[];
  page: {
    cursor: number;
    limit: number;
    total: number;
    hasMore: boolean;
    nextCursor?: number;
  };
}
```

Follow `nextCursor` only when `hasMore` is true. Mutations can shift an offset-ordered population,
so restart traversal for an affected visible page after an invalidation instead of treating old
cursors as durable bookmarks.

### Complete ID reads

Use IDs mode when the panel already knows which records it needs:

```ts
type HostProjectIdsSelector = {
  mode: "ids";
  ids: readonly string[];
};

type HostLookupResult<T> =
  | { id: string; status: "found"; value: T }
  | { id: string; status: "not-found" }
  | { id: string; status: "unauthorized" };
```

An IDs selector accepts `1`–`100` valid IDs. It preserves input order and duplicates and returns
exactly one outcome per requested ID. A valid request is never partially shortened or cut at a
serialized-byte threshold. Malformed, empty, or oversized selectors reject as a whole.

`not-found` means no record with that identity is known. `unauthorized` means the host can prove
the identity belongs outside the bound project; no foreign fields are returned. Consumers must
handle each outcome rather than assuming every result contains `value`. Archived sessions and goals
remain available by known ID so archive invalidations can refresh an existing view.

### Goal child reads

Tasks and gates authorize their parent goal before selecting children. A missing or foreign parent
returns a successful typed outcome instead of child data:

```ts
type HostGoalReadError = {
  goalId: string;
  status: "not-found" | "unauthorized";
};
```

The PR method follows `HostLookupResult`. For a known in-project goal with no cached PR status, it
returns `{ id, status: "found", value: null }`. It reads the current cache and does not trigger a
provider refresh. Invalid cached enum data fails closed rather than widening the public contract.

## Stable summary boundary

Adapters create fresh objects with allowlisted fields. They never spread persisted records and add
no extra enumerable keys. Optional fields are omitted when unavailable; the only intentional `null`
is the known goal with no cached PR.

```ts
type HostStaffState = "active" | "paused" | "retired";
interface HostStaffSummary {
  id: string;
  name: string;
  state: HostStaffState;
  accessory: string;
  createdAt: number;
  updatedAt: number;
  roleId?: string;
  currentSessionId?: string;
  lastWakeAt?: number;
}

type HostSessionStatus =
  | "starting" | "preparing" | "idle" | "streaming"
  | "aborting" | "terminated" | "archived";
interface HostSessionSummary {
  id: string;
  title: string;
  status: HostSessionStatus;
  createdAt: number;
  lastActivity: number;
  archived: boolean;
  archivedAt?: number;
  goalId?: string;
  teamGoalId?: string;
  taskId?: string;
  staffId?: string;
  delegateOf?: string;
  parentSessionId?: string;
  childKind?: string;
  teamLeadSessionId?: string;
  role?: string;
  readOnly?: boolean;
  hasUnansweredQuestion?: boolean;
}

type HostGoalState = "todo" | "in-progress" | "complete" | "shelved" | "blocked";
type HostGoalSetupStatus = "ready" | "preparing" | "retrying" | "error";
interface HostGoalSummary {
  id: string;
  title: string;
  state: HostGoalState;
  createdAt: number;
  updatedAt: number;
  team: boolean;
  archived: boolean;
  archivedAt?: number;
  workflowId?: string;
  parentGoalId?: string;
  rootGoalId?: string;
  teamLeadSessionId?: string;
  setupStatus?: HostGoalSetupStatus;
  paused?: boolean;
  mergeConflict?: boolean;
}

type HostTaskState = "todo" | "in-progress" | "blocked" | "complete" | "skipped";
interface HostTaskSummary {
  id: string;
  goalId: string;
  title: string;
  type: string;
  state: HostTaskState;
  createdAt: number;
  updatedAt: number;
  dependsOn: string[];
  parentTaskId?: string;
  assignedSessionId?: string;
  completedAt?: number;
  workflowGateId?: string;
}

type HostGateStatus = "pending" | "passed" | "failed" | "bypassed";
type HostGateEffectiveStatus = HostGateStatus | "running";
interface HostGateSummary {
  gateId: string;
  status: HostGateStatus;
  effectiveStatus: HostGateEffectiveStatus;
  running: boolean;
  awaitingSignoffCount: number;
  dependsOn: string[];
  signalCount: number;
  name?: string;
  updatedAt?: number;
}

type HostPullRequestState = "OPEN" | "CLOSED" | "MERGED";
type HostPullRequestReviewDecision =
  | "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
type HostPullRequestMergeability = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
interface HostPullRequestSummary {
  goalId: string;
  state: HostPullRequestState;
  number?: number;
  title?: string;
  url?: string;
  updatedAt?: string;
  reviewDecision?: HostPullRequestReviewDecision;
  mergeability?: HostPullRequestMergeability;
}
```

`accessory` is a normalized scalar identity, not an internal staff object. `team` and `archived`
are normalized booleans. Dependency arrays are copied. Most timestamps are epoch milliseconds. PR
`updatedAt`, when present, is a validated ISO-8601 UTC string because it comes from the PR status
contract. PR URLs are included only after safety sanitization; a missing internal review decision is
omitted rather than returned as `null`.

The summaries exclude:

- filesystem, repository, worktree, and container paths;
- prompts, specs, instructions, context, transcripts, and messages;
- workflow bodies, signal content, verification output, diagnostics, artifacts, failed-step evidence,
  task results, and gate evidence;
- secrets, credentials, provider records, tool/model/sandbox configuration;
- branches, commit SHAs, Git handoffs, arbitrary metadata and tags, and administrative flags.

A panel that needs extension-owned detail should obtain that detail from its own declared pack route
and use returned IDs to read only the related Host summaries.

## Notifications and lifecycle

Contract-v5 notifications and contract-v7 reads are complementary. Notification payloads are
bounded committed facts, not replacement records. On a specific event, reread only its identified
record or the affected visible page:

- staff events → the named staff ID;
- session events → the named session ID;
- goal events → the named goal ID, or the visible goal page when membership may change;
- task and gate events → the named child under its goal;
- PR events → that goal's cached PR status.

`onRefreshRequired` covers initial subscription, reload/rebind, reconnect, epoch changes, sequence
gaps, overflow, and project moves. Repeat only the reads currently represented by the panel. Do not
apply a discontinuous event or reconstruct records from event history. Coalesce overlapping refreshes
and rerun once if another invalidation arrives while reads are in flight.

Unsubscribe functions are idempotent. Call them on panel teardown and fence late async results with
a mount generation or cancellation state. The Host owns no consumer cache, so cleanup leaves no
project-read state behind.

## Canonical data flow

```text
pack browser surface
  → typed host.project method
  → authenticated surface/session validation
  → server-resolved project and project-move recheck
  → canonical project store or selector
  → fresh allowlisted adapter
  → bounded page or complete ID result
```

The same project contexts, stores, safe gate/PR projections, and offset paging semantics power
first-party Bobbit views. Reusing those owners prevents extension results from drifting into a
parallel interpretation of project state.

## Verification

Focused coverage pins:

- contract v7 and exactly six read methods;
- automatic pack-surface availability and ordinary capability detection;
- page continuation, ordered duplicate IDs, complete outcomes, and malformed-selector rejection;
- exact DTO keys and redaction of sensitive persisted fields;
- parent-goal errors and a known goal with no cached PR;
- archived records, reload, canonical rereads, and active gate verification state;
- missing/stale tokens, inactive packs, cross-session/project attempts, and project-move fencing;
- targeted invalidation, reconnect/gap refresh, idempotent unsubscribe, and uninstall cleanup.

See [Extension Host authoring](../extension-host-authoring.md#hostproject--on-demand-project-reads),
[Unified Host hooks](../host-hooks.md#browser-host-api), and
[Marketplace](../marketplace.md#extension-contributions-tool-renderers--server-actions).
