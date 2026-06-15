# Mid-session project proposals

> **Historical implementation plan.** This design predates the unified
> server-backed side-panel workspace. Proposal tab behavior now follows
> [docs/side-panel-workspace.md](../side-panel-workspace.md): a project proposal
> opens or updates `proposal:project` through the workspace API, shared controls
> own fullscreen/collapse/restore/popout, and closed tabs are not recreated from
> proposal state or localStorage. Hardcoded source locations and preview-specific
> wiring below are historical planning context, not current side-panel guidance.

## Goal

Let **any** agent session (regular, goal, staff, and non-project assistants) submit
`propose_project` to edit the **currently registered** project's config, and give
the user a first-class `proposal:project` tab in the side-panel workspace to
review and accept the change without leaving the session.

The existing provisional-project flow (project assistant → promote → terminate →
navigate) must continue to work unchanged.

## Current state (investigated)

### Client
- State shape: `state.activeProjectProposal: undefined | { sessionId: string; fields: Record<string,string> }`
  at `src/app/state.ts`.
- Server → client callback: `remote.onProjectProposal` is wired **for every session**
  regardless of assistantType (`src/app/session-manager.ts`) and also from
  the `proposal-open` button dispatch (`src/app/session-manager.ts`).
- Proposal parser: `src/app/proposal-parsers.ts` (`project_proposal`, required
  `name` + `root_path`).
- **Bug #1 — proposal is wiped for non-project sessions.** Around
  `src/app/session-manager.ts`:
  ```ts
  if (state.assistantType !== "project" && state.assistantType !== "project-scaffolding")
      state.activeProjectProposal = undefined;
  ```
  This clears the proposal during draft-restore on any session whose assistantType
  isn't `project`/`project-scaffolding`, so a `propose_project` from a regular
  session never survives a navigate-back.
- **Bug #2 (historical) — `projectProposalPanel()` was only mounted via the
  assistant preview router.** In the current workspace model, project proposals
  open or update the `proposal:project` tab through the side-panel workspace API;
  the shared side-panel shell, not preview-specific render wiring, decides which
  tabs are visible.
- **Bug #3 — accept is hard-coded to the provisional flow.** `acceptProjectProposal()`
  at `src/app/session-manager.ts` calls `promoteProject()` (which fails for
  non-provisional projects), writes config, then terminates the session and navigates
  to landing.

### Server
- `PUT /api/projects/:id/config` lives at `src/server/server.ts`. It is a
  **generic** string-KV writer: it validates keys (no dots) and writes every entry
  into `ctx.projectConfigStore` via `.set(key, value)`. It already accepts any
  scalar project.yaml field — `build_command`, `test_command`, `typecheck_command`,
  `test_unit_command`, `test_e2e_command`, `worktree_setup_command`, `sandbox`,
  `qa_start_command`, etc. **No extension needed for command / sandbox / qa fields.**
- `name` is **not** a project.yaml field — it lives in `.bobbit/state/projects.json`
  via `ProjectRegistry`. The rename endpoint is `PUT /api/projects/:id` at
  `src/server/server.ts` which accepts `{ name, color, rootPath, palette,
  colorLight, colorDark }` and calls `projectRegistry.update(id, updates)`
  (`src/server/agent/project-registry.ts`).
- Model preferences (`session_model`, `review_model`, `naming_model`) are **not**
  project-scoped — they live in the preferences store as `default.sessionModel` /
  `default.reviewModel` / `default.namingModel` (`src/app/settings-page.ts`,
  `src/app/render.ts`). The existing agent-side `propose_project` tool
  schema (`defaults/tools/proposals/extension.ts`) does **not** accept
  these fields. `propose_setup` is the tool for model prefs.
- `onProjectProposal` is a **client-side** callback derived from parsing
  `<project_proposal>` tool-call blocks in assistant messages
  (`src/app/proposal-parsers.ts`). It fires regardless of session assistantType —
  **no server-side fix required**.

## Design

### 1. Client state shape (`src/app/state.ts`)

Update `activeProjectProposal`:

```ts
activeProjectProposal: undefined as undefined | {
    sessionId: string;            // session that owns this proposal
    fields: Record<string, string>;
    /** Provisional = project is still in .bobbit/state/projects.json with
     *  provisional:true (existing assistant flow). Registered = any other
     *  project (regular/goal/staff session pointing at a live project). */
    mode: "provisional" | "registered";
    /** Current project.yaml snapshot + registry fields, loaded lazily after
     *  the panel mounts. `undefined` = not fetched yet (panel shows skeleton). */
    currentConfig?: {
        name: string;            // from ProjectRegistry
        rootPath: string;        // from ProjectRegistry (read-only)
        config: Record<string, string>; // from GET /api/projects/:id/config
    };
},
```

Draft storage (`projectDraft` serialize/restore in `src/app/session-manager.ts`) keeps `activeProjectProposal` whole, so the new fields persist free.

### 2. `session-manager.ts` changes

#### 2a. Stop wiping the proposal for non-project sessions

Change `src/app/session-manager.ts` from:

```ts
if (state.assistantType !== "project" && state.assistantType !== "project-scaffolding")
    state.activeProjectProposal = undefined;
```

to:

```ts
// Project proposals are valid for ANY session — leave state.activeProjectProposal alone.
// Draft restore below handles rehydration for project-assistant sessions.
```

#### 2b. Auto-select the `project` tab on first arrival (mirror goal pattern)

In `remote.onProjectProposal`, mirror the existing goal-proposal branching:

```ts
remote.onProjectProposal = async (fields: Record<string, string>) => {
    if (activeSessionId() !== sessionId) return;

    const session = state.gatewaySessions.find(s => s.id === sessionId);
    const project = state.projects.find(p => p.id === session?.projectId);
    const mode: "provisional" | "registered" =
        project?.provisional ? "provisional" : "registered";

    const isFirstProposal = state.activeProjectProposal == null;
    state.activeProjectProposal = { sessionId, fields, mode };
    state.assistantHasProposal = true;

    if (state.assistantType === "project" || state.assistantType === "project-scaffolding") {
        // Existing assistant-tab behaviour
        if (state.assistantTab === "chat" && !isDesktop()) state.assistantTab = "preview";
    } else if (isFirstProposal) {
        // Non-assistant session: first proposal explicitly opens/focuses
        // the server-backed proposal workspace tab.
        await openSidePanelTab(buildProposalSidePanelTab(sessionId, "project"));
    }

    // Lazy-load current config snapshot for the diff view (registered mode only)
    if (mode === "registered" && session?.projectId && !state.activeProjectProposal.currentConfig) {
        void loadCurrentProjectConfig(session.projectId, sessionId);
    }

    saveProjectDraft(sessionId);
    renderApp();
};
```

New helper (module-private):

```ts
async function loadCurrentProjectConfig(projectId: string, sessionId: string) {
    const [cfgRes, projRes] = await Promise.all([
        gatewayFetch(`/api/projects/${projectId}/config`),
        gatewayFetch(`/api/projects/${projectId}`),
    ]);
    if (!cfgRes.ok || !projRes.ok) return;
    const config = await cfgRes.json();
    const proj = await projRes.json();
    if (state.activeProjectProposal?.sessionId !== sessionId) return; // stale
    state.activeProjectProposal.currentConfig = {
        name: proj.name,
        rootPath: proj.rootPath,
        config,
    };
    saveProjectDraft(sessionId);
    renderApp();
}
```

#### 2c. Split `acceptProjectProposal()`

Replace the body at `src/app/session-manager.ts` with a dispatcher:

```ts
export async function acceptProjectProposal(): Promise<void> {
    const proposal = state.activeProjectProposal;
    if (!proposal) return;
    if (proposal.mode === "provisional") {
        return acceptProvisionalProjectProposal(proposal);
    }
    return acceptRegisteredProjectProposal(proposal);
}

// Existing body, unchanged — promote + write config + terminate + navigate to landing.
async function acceptProvisionalProjectProposal(proposal: ActiveProjectProposal): Promise<void> { … }
```

New registered path:

```ts
async function acceptRegisteredProjectProposal(proposal: ActiveProjectProposal): Promise<void> {
    const { fields, sessionId: propSessionId, currentConfig } = proposal;
    const session = state.gatewaySessions.find(s => s.id === propSessionId);
    const projectId = session?.projectId;
    if (!projectId || !currentConfig) return;

    const { gatewayFetch, fetchProjects } = await import("./api.js");

    // 1. Rename via PUT /api/projects/:id if name changed.
    if (fields.name && fields.name !== currentConfig.name) {
        await gatewayFetch(`/api/projects/${projectId}`, {
            method: "PUT",
            body: JSON.stringify({ name: fields.name }),
        });
    }

    // 2. Compute config diff — only fields that differ from currentConfig.config.
    //    root_path is never sent. name is handled above, not via project.yaml.
    const diff: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
        if (k === "name" || k === "root_path") continue;
        if ((currentConfig.config[k] ?? "") !== v) diff[k] = v;
    }
    if (Object.keys(diff).length > 0) {
        await gatewayFetch(`/api/projects/${projectId}/config`, {
            method: "PUT",
            body: JSON.stringify(diff),
        });
    }

    // 3. Refresh projects list; clear proposal; stay connected.
    setProjects(await fetchProjects());
    state.activeProjectProposal = undefined;
    state.assistantHasProposal = false;
    deleteProjectDraft(propSessionId);
    // TODO(optional): surface a toast / inline confirmation. Out of scope.
    renderApp();
}
```

**Key differences vs. provisional path:**

| Step | Provisional | Registered |
| --- | --- | --- |
| Promote project | yes (`promoteProject`) | no |
| Config write endpoint | `PUT /api/projects/:id/config` (all fields) | `PUT /api/projects/:id/config` (diffed fields only) |
| Rename | via `promoteProject(id, name)` | via `PUT /api/projects/:id { name }` |
| Terminate session | yes | **no** |
| Navigate to landing | yes | **no** |
| Delete draft | yes | yes |

#### 2d. Dismiss path — unchanged

The dismiss handler in `projectProposalPanel()` (`render.ts`) clears
`state.activeProjectProposal` and deletes the draft. This remains identical.
No change.

### 3. Side-panel workspace wiring

Current side-panel behavior is not wired through preview-specific tabs. A
project proposal is represented by the shared proposal tab id `proposal:project`
in the server-backed workspace.

Required behavior:

- First proposal arrival calls the side-panel workspace open API for
  `proposal:project` and focuses it.
- Later current revisions update the same `proposal:project` tab in place; they
  do not create duplicates or reorder unrelated preview/review/pack/inbox tabs.
- Dismiss closes the workspace tab and clears the project proposal draft. Reload
  must not recreate the tab from proposal state.
- Historical/reopened revisions, if exposed, use `proposal:project:rev:<N>` and
  are created only by explicit reopen UI.
- The shared side-panel shell supplies fullscreen, collapse, restore, reorder,
  close, keyboard shortcuts, and popout. Project proposal code should keep only
  proposal-specific actions such as Apply Changes and Dismiss.

#### 3a. Proposal panel content

`projectProposalPanel()` still owns the proposal-specific diff UI. It must render
inside the shared proposal panel slot instead of depending on assistant-only
preview routing.

Field set (editable):

```ts
const EDITABLE_FIELDS = [
    { key: "name",                   label: "Project Name",         source: "registry" },
    { key: "build_command",          label: "Build Command",        source: "config" },
    { key: "test_command",           label: "Test Command",         source: "config" },
    { key: "typecheck_command",      label: "Type Check Command",   source: "config" },
    { key: "test_unit_command",      label: "Unit Test Command",    source: "config" },
    { key: "test_e2e_command",       label: "E2E Test Command",     source: "config" },
    { key: "worktree_setup_command", label: "Worktree Setup",       source: "config" },
    { key: "qa_start_command",       label: "QA Start Command",     source: "config" },
    { key: "sandbox",                label: "Sandbox",              source: "config" },
    { key: "session_model",          label: "Session Model",        source: "pref" },
    { key: "review_model",           label: "Review Model",         source: "pref" },
    { key: "naming_model",           label: "Naming Model",         source: "pref" },
];
```

> Note: `session_model` / `review_model` / `naming_model` are **preference-scoped**
> not project-scoped today. They render as editable, but accepting them writes via
> `PUT /api/preferences` (not `/projects/:id/config`). The `propose_project`
> schema also needs the three optional fields added (see §4). If we decide to keep
> these preference-scoped, the accept handler routes them separately. If the team
> prefers to punt, drop them from `EDITABLE_FIELDS` and from the schema.

Unknown-keys pass-through: iterate over `Object.keys(proposal.fields)`, and for any
key not in `EDITABLE_FIELDS` and not `root_path`, render a generic
`label="<key>"` input under a "Custom fields" group.

Diff UX:
- Compute `currentValue` from `currentConfig.config[key]` (or `currentConfig.name`
  for `name`).
- A row shows: label, muted current value underneath the input, the input itself
  (controlled, driven by `proposal.fields[key]`), and a yellow/blue "Changed" pill
  when `proposal.fields[key] !== (currentValue ?? "")`.
- `root_path` is always shown read-only (same code block as today).
- Rows whose proposed value equals the current value collapse into a
  `<details>No changes (N fields)</details>` group.
- While `currentConfig === undefined` (still loading for registered mode), show a
  "Loading current config…" placeholder and no diff — inputs stay editable against
  the proposed values only.
- **Provisional mode** (mode === "provisional"): `currentConfig` may be absent;
  render exactly the old UI (no diff, no muted current-value row).

Accept button label:
- Provisional: "Accept Project" (existing).
- Registered: "Apply Changes" with a badge showing diff count
  (`N fields changed`).

Dismiss button: closes the `proposal:project` workspace tab, clears
`state.activeProjectProposal`, and deletes the draft.

### 4. Server

#### 4a. `PUT /api/projects/:id/config`
Already accepts arbitrary string KV pairs (`src/server/server.ts`). Keys
in scope that are already supported:
`build_command`, `test_command`, `typecheck_command`, `test_unit_command`,
`test_e2e_command`, `worktree_setup_command`, `qa_start_command`, `sandbox`,
plus any unknown passthrough. **No extension required.** The existing validation
(`key.includes(".")` reject) is correct and kept.

#### 4b. Name changes
Use the existing `PUT /api/projects/:id` (`src/server/server.ts`) which
already accepts `{ name }`. **No extension required.**

#### 4c. Model fields
`session_model` / `review_model` / `naming_model` live in preferences, not
project.yaml. Options:

1. **Accept as-is**: the registered accept path maps these three keys to
   `PUT /api/preferences` with
   `{ "default.sessionModel": …, "default.reviewModel": …, "default.namingModel": … }`.
   Agents pass them verbatim via `propose_project`.
2. **Punt**: drop these three keys from both the tool schema and `EDITABLE_FIELDS`;
   tell agents to use `propose_setup` for model prefs.

Recommendation: **option 1**, so the panel gives one coherent surface. Server-side
`/api/preferences` already exists and accepts the three keys.

#### 4d. Tool schema extension

`defaults/tools/proposals/extension.ts` — add optional
`qa_start_command`, `sandbox`, `session_model`, `review_model`, `naming_model`
to the `propose_project` `Type.Object`. Mirror in
`src/app/proposal-parsers.ts` (`fields` array) so the client parser surfaces
them.

#### 4e. `onProjectProposal` — no server fix

Client-side only. Already fires for any assistantType (proof:
`src/app/session-manager.ts` has no assistantType guard). **No change.**

### 5. Testing plan

| Type | File | Scope |
| --- | --- | --- |
| Unit (Playwright `file://`) | `tests/ui/project-proposal-panel.spec.ts` | `projectProposalPanel()` renders diff: changed rows show "Changed" pill; unchanged rows collapse into a `<details>` group; `root_path` is read-only; unknown keys render in "Custom fields"; provisional mode (no `currentConfig`) still renders legacy UI. |
| API E2E (in-process harness) | `tests/e2e/project-config-api.spec.ts` | `PUT /api/projects/:id/config` accepts every field in §3e (config-sourced ones); `PUT /api/projects/:id` accepts `name`; `PUT /api/preferences` accepts the three model keys. |
| Browser E2E (REQUIRED) | `tests/e2e/ui/mid-session-project-proposal.spec.ts` | Spawned gateway + mock agent. Flow: create regular session in a registered project; mock agent emits `<project_proposal>` with diffed fields; assert (1) `proposal:project` appears in the shared side-panel workspace, (2) diff rows rendered with "Changed" pills, (3) Apply Changes calls `PUT /api/projects/:id/config` + (if name changed) `PUT /api/projects/:id`, (4) session stays connected (no landing nav), (5) reload — proposal cleared, config persisted (GET returns new values), (6) Dismiss path: emit proposal, click Dismiss, tab disappears, reload → still gone, config untouched. Pattern: `tests/e2e/ui/settings.spec.ts`. |
| Regression | `tests/e2e/ui/project-assistant.spec.ts` | Must stay green: provisional promote + terminate + navigate-to-landing flow unchanged. |

### 6. Non-goals (per spec)

- Changing `root_path` / moving a project.
- Bulk or multi-project proposals.
- Explicit undo history (git already has `project.yaml`).
- A dedicated "propose project" button for non-project assistants.
- Server-side auto-nudging the session after a successful apply.

## File-by-file summary

| File | Change |
| --- | --- |
| `src/app/state.ts` | Add `mode` + `currentConfig` to `activeProjectProposal`; workspace tab state remains in `sidePanelWorkspace`. |
| `src/app/session-manager.ts` | Drop the project-proposal wipe; expand `onProjectProposal` (mode inference, explicit workspace tab open, lazy config load); split `acceptProjectProposal` into provisional (existing body) + registered (new). |
| `src/app/render.ts` | Render `projectProposalPanel()` as a diff view inside the shared proposal panel slot. Do not add preview-specific tab/chrome state. |
| `src/app/proposal-parsers.ts` | Add `qa_start_command`, `sandbox`, `session_model`, `review_model`, `naming_model` to `fields`. |
| `defaults/tools/proposals/extension.ts` | Add the five optional fields to `propose_project` schema. |
| `src/server/server.ts` | No change — existing `PUT /api/projects/:id/config` + `PUT /api/projects/:id` cover all registered-mode writes. |
| `src/server/agent/project-registry.ts` | No change. |
| `tests/ui/project-proposal-panel.spec.ts` | New — unit test for diff rendering. |
| `tests/e2e/project-config-api.spec.ts` | New — API coverage for all fields. |
| `tests/e2e/ui/mid-session-project-proposal.spec.ts` | New — browser E2E happy + dismiss + persistence. |
