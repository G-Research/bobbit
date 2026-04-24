# Mid-session project proposals

## Goal

Let **any** agent session (regular, goal, staff, and non-project assistants) submit
`propose_project` to edit the **currently registered** project's config, and give
the user a first-class "Project" tab in the preview panel to review and accept the
change without leaving the session.

The existing provisional-project flow (project assistant → promote → terminate →
navigate) must continue to work unchanged.

## Current state (investigated)

### Client
- State shape: `state.activeProjectProposal: undefined | { sessionId: string; fields: Record<string,string> }`
  at `src/app/state.ts:166`.
- Server → client callback: `remote.onProjectProposal` is wired **for every session**
  regardless of assistantType (`src/app/session-manager.ts:1186-1195`) and also from
  the `proposal-open` button dispatch (`src/app/session-manager.ts:1214`).
- Proposal parser: `src/app/proposal-parsers.ts:52-55` (`project_proposal`, required
  `name` + `root_path`).
- **Bug #1 — proposal is wiped for non-project sessions.** Around
  `src/app/session-manager.ts:1475`:
  ```ts
  if (state.assistantType !== "project" && state.assistantType !== "project-scaffolding")
      state.activeProjectProposal = undefined;
  ```
  This clears the proposal during draft-restore on any session whose assistantType
  isn't `project`/`project-scaffolding`, so a `propose_project` from a regular
  session never survives a navigate-back.
- **Bug #2 — `projectProposalPanel()` is only mounted via the assistant preview
  router.** `src/app/render.ts:1785` defines the panel; `getAssistantPreviewPanel()`
  at `src/app/render.ts:1883-1889` dispatches `case "project" | "project-scaffolding"`.
  Non-assistant sessions use `unifiedPreviewPanel()` (`src/app/render.ts:2650…`),
  whose tab header only knows about `preview`, `review`, `goal` — no `project` tab.
- **Bug #3 — accept is hard-coded to the provisional flow.** `acceptProjectProposal()`
  at `src/app/session-manager.ts:1767-1830` calls `promoteProject()` (which fails for
  non-provisional projects), writes config, then terminates the session and navigates
  to landing.

### Server
- `PUT /api/projects/:id/config` lives at `src/server/server.ts:1922-1945`. It is a
  **generic** string-KV writer: it validates keys (no dots) and writes every entry
  into `ctx.projectConfigStore` via `.set(key, value)`. It already accepts any
  scalar project.yaml field — `build_command`, `test_command`, `typecheck_command`,
  `test_unit_command`, `test_e2e_command`, `worktree_setup_command`, `sandbox`,
  `qa_start_command`, etc. **No extension needed for command / sandbox / qa fields.**
- `name` is **not** a project.yaml field — it lives in `.bobbit/state/projects.json`
  via `ProjectRegistry`. The rename endpoint is `PUT /api/projects/:id` at
  `src/server/server.ts:1807-1823` which accepts `{ name, color, rootPath, palette,
  colorLight, colorDark }` and calls `projectRegistry.update(id, updates)`
  (`src/server/agent/project-registry.ts:162`).
- Model preferences (`session_model`, `review_model`, `naming_model`) are **not**
  project-scoped — they live in the preferences store as `default.sessionModel` /
  `default.reviewModel` / `default.namingModel` (`src/app/settings-page.ts:1142-1144`,
  `src/app/render.ts:1571-1573`). The existing agent-side `propose_project` tool
  schema (`defaults/tools/proposals/extension.ts:151-165`) does **not** accept
  these fields. `propose_setup` is the tool for model prefs.
- `onProjectProposal` is a **client-side** callback derived from parsing
  `<project_proposal>` tool-call blocks in assistant messages
  (`src/app/proposal-parsers.ts`). It fires regardless of session assistantType —
  **no server-side fix required**.

## Design

### 1. Client state shape (`src/app/state.ts`)

Update `activeProjectProposal` at line 166:

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

Draft storage (`projectDraft` serialize/restore at `src/app/session-manager.ts:
328-345`) keeps `activeProjectProposal` whole, so the new fields persist free.

### 2. `session-manager.ts` changes

#### 2a. Stop wiping the proposal for non-project sessions

Change `src/app/session-manager.ts:1475` from:

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

In `remote.onProjectProposal` (currently `src/app/session-manager.ts:1186-1195`),
mirror the `onGoalProposal` branching at lines 995-1044 exactly:

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
        // Non-assistant session: first proposal auto-selects the new tab
        state.previewPanelActiveTab = "project";
        const collapseKey = `bobbit-preview-collapsed-${sessionId}`;
        localStorage.removeItem(collapseKey);
        if (!isDesktop()) state.previewPanelTab = "project";
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

Replace the body at `src/app/session-manager.ts:1767-1830` with a dispatcher:

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

The dismiss handler in `projectProposalPanel()` (`render.ts:1814-1819`) clears
`state.activeProjectProposal` and deletes the draft. This remains identical.
No change.

### 3. Preview panel wiring (`src/app/render.ts`)

#### 3a. Tab visibility in `unifiedPreviewPanel()`

At `src/app/render.ts:2128-2136` (tab registration), alongside:

```ts
const showPreviewTab = state.isPreviewSession;
const showGoalTab = state.activeGoalProposal != null;
const showReviewTab = state.reviewPanelOpen;
```

add:

```ts
const showProjectTab = state.activeProjectProposal != null;
```

and extend `hasUnifiedPanel()` at `src/app/render.ts:2128`:

```ts
function hasUnifiedPanel(): boolean {
    return !state.assistantType && (
        state.isPreviewSession ||
        state.activeGoalProposal != null ||
        state.activeProjectProposal != null ||   // new
        state.reviewPanelOpen
    );
}
```

and `unifiedPanelTabs()` at `src/app/render.ts:2132-2139`:

```ts
function unifiedPanelTabs(): Array<"chat" | "preview" | "goal" | "review" | "project"> {
    const tabs: Array<"chat" | "preview" | "goal" | "review" | "project"> = ["chat"];
    if (state.isPreviewSession) tabs.push("preview");
    if (state.reviewPanelOpen) tabs.push("review");
    if (state.activeGoalProposal != null) tabs.push("goal");
    if (state.activeProjectProposal != null) tabs.push("project"); // new
    return tabs;
}
```

Extend the `previewPanelTab` / `previewPanelActiveTab` unions in `src/app/state.ts`
to include `"project"`.

#### 3b. Auto-correct logic (`unifiedPreviewPanel()` ~line 2697-2703)

Currently:

```ts
if (state.previewPanelActiveTab === "review" && !state.reviewPanelOpen) {
    state.previewPanelActiveTab = state.isPreviewSession ? "preview" :
        (state.activeGoalProposal != null ? "goal" : "preview");
} else if (state.previewPanelActiveTab === "preview" && !state.isPreviewSession && state.activeGoalProposal != null) {
    state.previewPanelActiveTab = "goal";
} else if (state.previewPanelActiveTab === "goal" && state.activeGoalProposal == null && state.isPreviewSession) {
    state.previewPanelActiveTab = "preview";
}
```

Add a parallel branch:

```ts
} else if (state.previewPanelActiveTab === "project" && state.activeProjectProposal == null) {
    state.previewPanelActiveTab = state.isPreviewSession ? "preview"
        : (state.activeGoalProposal != null ? "goal"
        : (state.reviewPanelOpen ? "review" : "preview"));
}
```

#### 3c. Tab pill in the unified tab-bar (lines 2706-2713 and mirror at 2736-2744)

After the `showGoalTab` button:

```ts
${showProjectTab ? html`
    <button
        class="goal-tab-pill ${state.previewPanelActiveTab === "project" ? "goal-tab-pill--active" : ""}"
        title="Project"
        @click=${() => { state.previewPanelActiveTab = "project"; renderApp(); }}
    >Project <span class="goal-tab-dot"></span></button>
` : ""}
```

#### 3d. Tab-content dispatch (lines 2748-2754)

Extend the content switcher:

```ts
${state.previewPanelActiveTab === "review" && showReviewTab ? reviewPaneContent()
    : state.previewPanelActiveTab === "preview" && showPreviewTab ? htmlPreviewContent()
    : state.previewPanelActiveTab === "goal" && showGoalTab ? goalProposalPanel()
    : state.previewPanelActiveTab === "project" && showProjectTab ? projectProposalPanel()
    : ""}
```

Also mirror in `unifiedTabBar()` (lines 2588-2613) and `mobilePaneContent()`
(lines ~2765-2776) — add a `"project"` branch rendering `projectProposalPanel()`.

#### 3e. Generalise `projectProposalPanel()` (line 1785)

Rewrite to render a **diff view**. The panel must work outside
`getAssistantPreviewPanel` — it already does structurally (it imports nothing from
the assistant router). No changes to the import graph are required; just replace
the body.

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

Dismiss button: unchanged.

### 4. Server

#### 4a. `PUT /api/projects/:id/config`
Already accepts arbitrary string KV pairs (`src/server/server.ts:1922-1945`). Keys
in scope that are already supported:
`build_command`, `test_command`, `typecheck_command`, `test_unit_command`,
`test_e2e_command`, `worktree_setup_command`, `qa_start_command`, `sandbox`,
plus any unknown passthrough. **No extension required.** The existing validation
(`key.includes(".")` reject) is correct and kept.

#### 4b. Name changes
Use the existing `PUT /api/projects/:id` (`src/server/server.ts:1807-1823`) which
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

`defaults/tools/proposals/extension.ts:151-165` — add optional
`qa_start_command`, `sandbox`, `session_model`, `review_model`, `naming_model`
to the `propose_project` `Type.Object`. Mirror in
`src/app/proposal-parsers.ts:52-55` (`fields` array) so the client parser surfaces
them.

#### 4e. `onProjectProposal` — no server fix

Client-side only. Already fires for any assistantType (proof:
`src/app/session-manager.ts:1186` has no assistantType guard). **No change.**

### 5. Testing plan

| Type | File | Scope |
| --- | --- | --- |
| Unit (Playwright `file://`) | `tests/ui/project-proposal-panel.spec.ts` | `projectProposalPanel()` renders diff: changed rows show "Changed" pill; unchanged rows collapse into a `<details>` group; `root_path` is read-only; unknown keys render in "Custom fields"; provisional mode (no `currentConfig`) still renders legacy UI. |
| API E2E (in-process harness) | `tests/e2e/project-config-api.spec.ts` | `PUT /api/projects/:id/config` accepts every field in §3e (config-sourced ones); `PUT /api/projects/:id` accepts `name`; `PUT /api/preferences` accepts the three model keys. |
| Browser E2E (REQUIRED) | `tests/e2e/ui/mid-session-project-proposal.spec.ts` | Spawned gateway + mock agent. Flow: create regular session in a registered project; mock agent emits `<project_proposal>` with diffed fields; assert (1) Project tab appears in the unified preview panel, (2) diff rows rendered with "Changed" pills, (3) Apply Changes calls `PUT /api/projects/:id/config` + (if name changed) `PUT /api/projects/:id`, (4) session stays connected (no landing nav), (5) reload — proposal cleared, config persisted (GET returns new values), (6) Dismiss path: emit proposal, click Dismiss, tab disappears, reload → still gone, config untouched. Pattern: `tests/e2e/ui/settings.spec.ts`. |
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
| `src/app/state.ts` | Add `mode` + `currentConfig` to `activeProjectProposal`; add `"project"` to `previewPanelTab` / `previewPanelActiveTab` unions. |
| `src/app/session-manager.ts` | L1475: drop the project-proposal wipe. L1186: expand `onProjectProposal` (mode inference, first-proposal tab auto-select, lazy config load). L1767: split `acceptProjectProposal` into provisional (existing body) + registered (new). |
| `src/app/render.ts` | L1785: rewrite `projectProposalPanel()` as a diff view. L2128/2132/2697/2706/2748/2765: extend `hasUnifiedPanel` / `unifiedPanelTabs` / auto-correct / tab pill / content dispatch / mobile pane to include `"project"`. |
| `src/app/proposal-parsers.ts` | L52-55: add `qa_start_command`, `sandbox`, `session_model`, `review_model`, `naming_model` to `fields`. |
| `defaults/tools/proposals/extension.ts` | L151-165: add the five optional fields to `propose_project` schema. |
| `src/server/server.ts` | No change — existing `PUT /api/projects/:id/config` + `PUT /api/projects/:id` cover all registered-mode writes. |
| `src/server/agent/project-registry.ts` | No change. |
| `tests/ui/project-proposal-panel.spec.ts` | New — unit test for diff rendering. |
| `tests/e2e/project-config-api.spec.ts` | New — API coverage for all fields. |
| `tests/e2e/ui/mid-session-project-proposal.spec.ts` | New — browser E2E happy + dismiss + persistence. |
