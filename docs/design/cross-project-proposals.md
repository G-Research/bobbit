# Cross-project proposals

## Goal

Let a proposal made from one project (typically Headquarters) target a *different*
project. Every `propose_*` tool already accepts an optional `projectId`. When
omitted it defaults to the session's project (unchanged, byte-for-byte). When
supplied, the proposal is seeded, validated, and accepted against the **target**
project. No permission gating — any session may cross-target.

## Current blockers (verified in code)

1. `POST /api/sessions/:id/proposal/:type/seed` (`src/server/server.ts` ~13190)
   rejects any goal/staff proposal whose `projectId` differs from the session's
   with `PROJECT_ID_MISMATCH` (422) and force-overwrites
   `projectId = sessionProjectId`.
2. Goal workflow validation at seed resolves workflows from the **session's**
   project (`(getSession(...)).projectId`), not the target.
3. `propose_project` has no `projectId` param.
4. `argsWithProjectId` nudge wording in `defaults/tools/proposals/extension.ts`
   is neutral; spec wants a directive "don't set unless cross-project" nudge.
5. UI panels render no indicator when the target project differs from the
   proposer's session project.

## Design

### 1. Seed endpoint — remove the block, resolve + validate the target

File: `src/server/server.ts`, seed handler at `suffix === "/seed" && req.method === "POST"`.

Current goal/staff block:
```ts
if (proposalType === "goal" || proposalType === "staff") {
  const proposalSession = sessionManager.getSession(sessionId) ?? sessionManager.getPersistedSession(sessionId);
  const sessionProjectId = proposalSession?.projectId;
  if (!sessionProjectId) { json({ ok:false, code:"PROJECT_ID_REQUIRED", ... }, 400); return; }
  const proposalProjectId = <explicit trimmed>;
  if (proposalProjectId && proposalProjectId !== sessionProjectId) {
    json({ ok:false, code:"PROJECT_ID_MISMATCH", ... }, 422); return;   // ← DELETE
  }
  enrichedArgs = { ...enrichedArgs, projectId: sessionProjectId };        // ← REPLACE
}
```

Replace with a **target resolver** used by all project-scoped types
(goal, staff, role, tool — NOT project, which is handled separately):

```ts
// Resolve target project for project-scoped proposals.
if (proposalType === "goal" || proposalType === "staff"
    || proposalType === "role" || proposalType === "tool") {
  const proposalSession = sessionManager.getSession(sessionId) ?? sessionManager.getPersistedSession(sessionId);
  const sessionProjectId = proposalSession?.projectId;   // persisted, reliable default
  const explicitProjectId = typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim().length > 0
    ? enrichedArgs.projectId.trim()
    : undefined;
  // The omitted-default path normalises system → headquarters HERE too, so a
  // DIRECT /seed call (bypassing the tool's argsWithProjectId) from a
  // server-scope session (session.projectId === "system") still lands in the
  // user-facing headquarters scope. This mirrors argsWithProjectId exactly so
  // tool-mediated and direct-seed paths are identical.
  const defaultProjectId = sessionProjectId === "system" ? "headquarters" : sessionProjectId;
  const targetProjectId = explicitProjectId ?? defaultProjectId;
  if (!targetProjectId) {
    json({ ok:false, code:"PROJECT_ID_REQUIRED", message:"projectId required for project-scoped proposals" }, 400);
    return;
  }
  // Fail fast: validate the RESOLVED target against the registry. This is safe
  // for the default path because every resolvable default (a real project, or
  // headquarters) is a registered project — so the check is a no-op there and
  // only bites a caller-supplied unknown id.
  if (!projectRegistry.get(targetProjectId)) {
    json({ ok:false, code:"UNKNOWN_PROJECT",
      message:`Unknown projectId "${targetProjectId}". It does not name a registered project.` }, 422);
    return;
  }
  enrichedArgs = { ...enrichedArgs, projectId: targetProjectId };
}
```

Notes on the explicit-vs-default boundary (source of truth):
- The server does **not** try to distinguish "user typed it" from "tool injected
  it". Instead it validates the **resolved target** uniformly against the
  registry. This is deterministic regardless of call path (tool-mediated or
  direct `/seed`), which was the ambiguity the review flagged.
- Uniform validation is safe for the default path because every resolvable
  default is a registered project: a real session project, or `headquarters`
  (always registered — `projectRegistry.ensureHeadquartersProject`). The hidden
  `system` id is never persisted as a target — it is normalised to
  `headquarters` before validation, matching `argsWithProjectId`.
- Explicit `projectId: "system"` is treated as any other id and validated
  against the registry; since `system` is an internal, non-user-facing scope it
  will not match a user-facing registered project and is rejected — callers must
  target `headquarters`, not `system`. (Documented contract, not a silent
  clobber.)
- **Default path is byte-for-byte unchanged:** when `projectId` is omitted the
  stamped value equals what `argsWithProjectId` already produced (session scope,
  or `headquarters` for a `system` session).
- `role`/`tool` are added to the resolver so an explicit unknown project is
  rejected for them too (acceptance criterion (c)).

### 2. Goal workflow validation against the TARGET

Same handler, the block:
```ts
if (proposalType === "goal") {
  const projectId = (getSession ?? getPersistedSession)?.projectId;   // ← session's
  ... resolveWorkflows(projectId) ...
  const wfErr = validateGoalProposalWorkflow(enrichedArgs, workflows);
}
```
Change to resolve from `enrichedArgs.projectId` (the already-resolved target),
falling back to the session only if somehow absent:
```ts
if (proposalType === "goal") {
  const targetProjectId = typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim()
    ? enrichedArgs.projectId.trim()
    : (getSession ?? getPersistedSession)?.projectId;
  let workflows = [];
  if (targetProjectId) {
    workflows = configCascade.resolveWorkflows(targetProjectId).map(r => r.item);
    if (workflows.length === 0) {
      const ctx = projectContextManager.getOrCreate(targetProjectId);
      if (ctx) workflows = ctx.workflowStore.getAll();
    }
  }
  const wfErr = validateGoalProposalWorkflow(enrichedArgs, workflows);
  if (wfErr) { json(wfErr, 400); return; }
}
```
`validateGoalProposalWorkflow` itself is unchanged — only the workflow list
passed in changes. `parentGoalId` auto-injection and the inline-workflow
contract stay exactly as-is (that block runs before this and is untouched).

### 3. `propose_project` gets an optional `projectId`

File: `defaults/tools/proposals/extension.ts`, `propose_project` parameters:
add
```ts
projectId: Type.Optional(Type.String({ description: <nudge, see §5> })),
```
`argsWithProjectId` must continue to **skip** injection for `type === "project"`
(brand-new project proposals must not be auto-stamped). Leave that early return
in place. So `propose_project` only carries `projectId` when the agent supplies
it explicitly.

Seed handler: `propose_project` is deliberately **excluded** from the target
resolver in §1 (it is allowed to name a brand-new, not-yet-registered project).
No registry rejection for `project` at seed (acceptance criterion (d)).

**`propose_project` acceptance contract (exact):**
- `fields.projectId` present AND names a **registered** project ⇒ this is an
  *edit* of that existing project. Acceptance applies the proposed config to
  that project id (via the existing project-config update path,
  `projectIdForProjectProposal` returning `fields.projectId`). `name` /
  `root_path` in the draft describe the existing project and are not used to
  register a new one.
- `fields.projectId` **absent** ⇒ brand-new project, registered from
  `name` + `root_path` exactly as today (unchanged path).
- `fields.projectId` present but **not registered** ⇒ **rejected with a clear
  error** (edit-vs-create intent must be unambiguous; new projects omit
  `projectId`).
- Because `propose_project` is skipped by the tool's `argsWithProjectId`
  injection, an omitted `projectId` never gets auto-stamped, so the new-project
  path is preserved byte-for-byte.

**Enforcement point is the server mutation boundary, not the UI.** The edit-vs-
create invariant for project proposals is owned by the API, so direct/non-UI
callers get identical semantics:
- The relevant mutation endpoints are `PUT /api/projects/:id/config`,
  `PUT /api/projects/:id` (rename), and `POST /api/projects/:id/promote`
  (`src/server/server.ts`, project routes ~4517-5250). These already resolve the
  target via `projectRegistry.get(:id)` and return an error for an unknown id —
  so an unknown `fields.projectId` naturally fails there.
- Make that explicit and clean: when a project proposal is accepted against an
  **explicit** `fields.projectId`, the accept path targets *that* id. If the id
  is not registered the server returns a clear `UNKNOWN_PROJECT` error (not a
  generic 404), so the caller sees "you asked to edit an unregistered project".
  New-project creation must go through the provisional/promote path with **no**
  `projectId`.
- The UI (`acceptRegisteredProjectProposalFromPanel` /
  `acceptProvisionalProjectProposalFromPanel`) may preflight for a nicer message,
  but correctness does not depend on it — the server is authoritative.

### 4. Tool-wording nudge (advisory, ≤80 chars per budget test)

`tests2/core/tool-description-budget.test.ts` caps every parameter description at
**80 chars**. Use this exact string on the `projectId` param of all five tools
(74 chars):
```
Defaults to this session. Set only for an explicit cross-project proposal.
```
Apply to: `propose_goal`, `propose_role`, `propose_tool`, `propose_staff`,
`propose_project`. (Replaces the existing "Project id; defaults to this
session…" strings.) Keeps `cwd never selects project` / `Headquarters is server
scope` notes only if still under budget — prefer dropping them for the single
consistent nudge.

### 5. Acceptance routes to the target (UI read side)

Already mostly wired — confirm and leave intact:
- `resolveGoalProposalProjectId` / `proposalProjectId` (`src/app/proposal-panels.ts`
  ~103-126) prefer `slot.fields.projectId` then fall back to session. Goal accept
  (`createGoal`, ~1680-1790) sends the resolved `projectId`.
- Role accept (~2022): `proposalProjectId("role", sid)` — prefers explicit.
- Staff accept (~2417, ~2516): `state.activeProposals.staff?.fields?.projectId`
  then session — prefers explicit.
- Tool accept: verify the tool submit path also prefers `fields.projectId`; if
  it currently only reads session, patch it to prefer the draft field.
- Project accept: `projectIdForProjectProposal` (~2848) currently reads
  `session.projectId` only. Patch to prefer `state.activeProposals.project?.fields?.projectId`
  when present AND registered (editing an existing project); else keep the
  new-project registration flow (session-scoped provisional id). The
  authoritative edit-vs-create enforcement lives on the server (see §3).

Server-side acceptance keys off the proposal's `projectId` (goal creation under
target worktree/branch/workflow; config writes to target config store; project
config edit vs create). The goal/role/tool/staff accept endpoints already honour
the body/proposal `projectId`; the project accept path adds the explicit
`UNKNOWN_PROJECT` guard described in §3. Implementer must verify each accept
endpoint honours the resolved `projectId`.

### 6. Headquarters scope

`argsWithProjectId` maps `system` → `headquarters` for the **omitted** case only
(unchanged). An explicit target must never be clobbered — the tool-side guard
`if (record.projectId?.trim()) return args;` already short-circuits before the
`system`→`headquarters` mapping, so an explicit target passes through untouched.
Confirm no server code re-applies the mapping over an explicit value.

### 7. UI: "Proposing into <Target Project>" banner

File: `src/app/proposal-panels.ts`.

Add a shared helper:
```ts
// Returns the target project record ONLY when it differs from the proposer's
// own session project (normalising system→headquarters). Otherwise undefined.
function crossProjectTarget(type: ProposalType, sid: string | null | undefined):
  { id: string; name: string; color?: string } | undefined {
  let target: string | undefined;
  if (type === "goal") {
    target = resolveGoalProposalProjectId(sid, state.activeProposals.goal?.fields);
  } else if (type === "project") {
    // Project proposals: banner ONLY for an explicit edit of an existing
    // (registered) project. Brand-new project proposals (no fields.projectId,
    // or an id that is not yet registered) get NO banner — they are not
    // "cross-project" in the target-registry sense.
    const explicit = state.activeProposals.project?.fields?.projectId;
    const id = typeof explicit === "string" && explicit.trim() ? explicit.trim() : undefined;
    target = id && state.projects.some(p => p.id === id) ? id : undefined;
  } else {
    target = proposalProjectId(type, sid);   // role / tool / staff
  }
  if (!target) return undefined;
  const session = sid ? (state.gatewaySessions.find(s => s.id === sid)
    || state.archivedSessions.find(s => s.id === sid)) : undefined;
  let proposer = session?.projectId;
  if (proposer === "system") proposer = "headquarters";
  const normTarget = target === "system" ? "headquarters" : target;
  if (!proposer || proposer === normTarget) return undefined;   // same project → no chrome
  const proj = state.projects.find(p => p.id === normTarget);
  if (!proj) return undefined;
  return { id: proj.id, name: proj.name, color: (proj as any).color };
}
```

Add a banner renderer:
```ts
function crossProjectBanner(type: ProposalType, sid: string | null | undefined): TemplateResult | typeof nothing {
  const t = crossProjectTarget(type, sid);
  if (!t) return nothing;
  const accent = t.color || "var(--primary)";
  return html`<div class="cross-project-banner" role="status"
      data-testid="cross-project-banner"
      style=${`border-left:3px solid ${accent};background:color-mix(in oklch, ${accent} 12%, transparent);`}>
    ${icon(FolderOpen, "sm")}
    <span>Proposing into <strong>${t.name}</strong></span>
  </div>`;
}
```
Insert `${crossProjectBanner(type, sid)}` at the top of the scrollable body of
**all five** panels (goal ~1875, role ~2085, tool ~2295, staff ~2559, project
~3036/3183), immediately after the panel wrapper / `${proposalToast()}`. Resolve
`sid` per panel (the proposal slot's `sessionId` or `activeSessionId()`). Add
minimal `.cross-project-banner` styling (flex, gap, padding, rounded, text-sm)
using theme tokens only.

When target === proposer (the common case) the helper returns `undefined`/`nothing`
and the panel renders exactly as today (no extra chrome).

## Data flow

```
propose_X(projectId?) ──argsWithProjectId──▶ POST /seed { args:{ projectId? } }
  omitted  → tool stamps session (system→headquarters)
  explicit → passes through untouched
                                   │
                       seed handler (§1,§2,§3)
                       • resolve target = explicit ?? session
                       • explicit unknown → 422 UNKNOWN_PROJECT (except project)
                       • goal workflow validated vs TARGET workflows
                       • write proposal file with fields.projectId = target
                                   │
              proposal_update WS ─▶ UI activeProposals[type].fields.projectId
                                   │
        panel render: crossProjectBanner if target ≠ proposer (§7)
                                   │
        accept: createGoal/Role/Staff/Tool/Project with fields.projectId (§5)
                                   │
        server acceptance creates/writes in TARGET project
```

## Testing

- **Unit/integration** (`tests2/integration`, seed endpoint): (a) omitted →
  session incl. `system`→`headquarters`; (b) explicit valid cross-project
  accepted for goal/role/tool/staff/project; (c) explicit unknown rejected 422
  for goal/role/tool/staff; (d) unknown allowed for brand-new `propose_project`;
  (e) goal workflow validated against TARGET project's workflows (target with a
  workflow the session's project lacks → passes; session's workflow unknown to
  target → rejected).
- **Budget test** stays green (nudge ≤80 chars).
- **Browser** (`tests2/browser`): cross-project proposal from project A into
  project B — (i) banner shown when target≠proposer, (ii) no banner same-project,
  (iii) entity lands in target on accept.
- `npm run check` clean; existing proposal tests green.

## File ownership (parallel implementation)

- **Server + tools + server tests:** `src/server/server.ts` (seed handler),
  `defaults/tools/proposals/extension.ts`, `tests2/integration/*` seed tests.
- **UI + browser test:** `src/app/proposal-panels.ts` (+ any small CSS),
  `tests2/browser/*` cross-project journey.

These touch disjoint files; the only shared contract is
`proposal.fields.projectId = resolved target`, defined above.
