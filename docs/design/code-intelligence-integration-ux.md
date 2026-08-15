# Code Intelligence integration UX audit

**Status:** UX audit and implementation guidance

**Scope:** existing Code Intelligence status panel, project import handoff, truthful enablement, query, reload, and cleanup

**Production code changed by this audit:** none

## 1. Executive finding

The repository has the pieces for language detection, capability derivation, graph status, pack activation, and a real structural query, but they are not one user journey.

The current built-in pack experience is **Graphify-only and server-global**:

- `market-packs/code-intelligence/pack.yaml` declares only `contents.tools: [graph]` and ships `defaultDisabled: true`.
- `market-packs/code-intelligence/src/panel.ts` renders graph status only. It does not call the language detector or capability-status adapter.
- `market-packs/code-intelligence/lib/language-detection.ts` and `market-packs/code-intelligence/lib/capability-status.ts` are used by tests/adapters, not by a production import or panel route.
- `market-packs/code-intelligence/tools/lsp/extension.ts` is inert without a platform-injected worktree adapter.
- built-in activation is fixed to `server` by `src/server/agent/builtin-packs.ts::BUILTIN_PACK_SCOPE`; the existing Marketplace master switch therefore enables the pack for the server, not one imported project.
- the Add Project flow never offers Code Intelligence. It ends in a project-assistant proposal and acceptance.

Therefore the UI must not claim that Code Intelligence is enabled per project, that import detected and configured languages, that LSP is ready, or that a current branch graph exists. A true per-project import-time enable button is blocked until a public project-scoped activation/settings decision seam exists. A private field, prompt instruction, or pack-specific project-assistant branch would recreate the subsystem the parent design forbids.

**Selected release flow:** finish import normally → navigate to Marketplace → explicitly enable the built-in pack for the Bobbit server → open a session and load language/capability status in the enabled pack panel → run a real structural query → reload → disable from the same Marketplace switch and clean up. This is post-import server setup, not per-project import-time enablement. It is the smallest flow supported by current contracts; the audit does not leave two competing release paths.

## 2. Current journey and seams

| Moment | Exact existing seam | Current behavior | UX consequence |
|---|---|---|---|
| Choose project | `src/app/dialogs.ts::showProjectDialog()` | Scans repos/workspaces and lets the user confirm a component subset. | Good component intent exists before language detection, but no language facts are shown. |
| Hand off scan | `src/app/dialogs.ts::createProjectAssistantSession()` → `src/app/project-assistant-autoprompt.ts::formatProjectAssistantAutoPrompt()` | Sends the confirmed component subset to the project assistant. | Do not add Code Intelligence claims to this prompt; it is agent context, not an activation decision. |
| Propose/register | `src/server/agent/project-assistant.ts`, `src/app/proposal-panels.ts::acceptProjectProposalFromPanel()` | Creates/promotes the project, writes config, then closes the proposal/assistant flow. | There is no post-registration extension setup step or import decision event. |
| Enable pack | `src/app/marketplace-page.ts::renderBuiltinPackCard()` and `renderPackActivationSummary()` | Reuses the Marketplace master switch and PUTs `/api/marketplace/pack-activation`. | This is a clear, accessible existing control, but it is server-wide for built-ins. It cannot truthfully say “Enable for this project.” |
| Resolve activation | `src/server/server.ts` pack-activation GET/PUT; `src/server/agent/builtin-packs.ts` | Uses an explicit `{ enabled: true }` sentinel for disabled-by-default packs. | Reload-safe, but global. Import UX must name the scope before invoking it. |
| Open status | `market-packs/code-intelligence/entrypoints/code-intelligence-route.yaml`, `src/app/pack-entrypoints.ts`, `src/app/pack-panels.ts` | `#/ext/code-intelligence` mounts the pack panel only while the contribution is enabled. | Reuse this route; do not add a core Code Intelligence page. |
| Read graph status | `market-packs/code-intelligence/src/routes.ts::routes.status`, `market-packs/code-intelligence/src/graph-runtime.ts::status()` | Reads component-labelled graph snapshots. Mounting does not build. | Correct pull-only boundary. Empty/stale/base-fallback must remain explicit. |
| Detect languages | `market-packs/code-intelligence/lib/language-detection.ts::detectComponentLanguages()` | Bounded, symlink-safe filename scan with matching root-marker evidence and `truncated` evidence. A marker alone does not produce a language. | Suitable single source for a status row after activation, but it is not exposed by a production route today. |
| Derive capabilities | `market-packs/code-intelligence/lib/capability-status.ts::deriveLanguageCapabilityStatus()` | Separates structural search, toolchain facts, explicit language enablement, and exact LSP service readiness. | Suitable single source for labels; never derive “ready” from file detection alone. |
| Run a real query | `market-packs/code-intelligence/tools/ast/extension.ts` and `tests2/browser/journeys/ast-grep.journey.spec.ts` | A real `ast_grep` call returns a source-relative structural match. | Reuse this agent-tool path for the end-to-end query; do not add a duplicate query widget to the status panel. |
| Reload panel | `src/app/side-panel-workspace.ts`, `src/app/pack-entrypoints.ts`, `src/app/pack-panels.ts` | Pack registries reconcile on reload; a pack panel still needs a selected session workspace. | Restore the session, then the preserved `#/ext/code-intelligence` route, as the current graph journey does. |
| Disable/cleanup | Marketplace master switch plus contribution reconciliation | Removes tools, panel, provider, and route; the deep link becomes “Feature unavailable.” | Existing cleanup behavior is the correct visible end state. External index/LSP cleanup must be separately proved by runtime tests. |

## 3. Audit findings

### P0 — no import-time enablement path exists

No production caller consumes `detectComponentLanguages()` during Add Project, project proposal, or proposal acceptance. The older design correctly records that the public import decision/settings contracts are absent. The UI cannot satisfy a per-project import-time choice by silently writing `host.store`, editing `project.yaml`, posting an assistant message, or calling the server-global pack switch without disclosure.

**Release decision:** use the existing server-global Marketplace activation and call the experience **post-import server setup**, not per-project enablement. The control label must be **Enable Code Intelligence for this Bobbit server** and its description must say it affects every project. Detection happens after activation because a disabled built-in contributes no routes through `activeBuiltinFirstPartyPackEntries()`.

A future per-project import-time choice remains blocked on a generic project-scoped activation/settings decision seam. It is not part of this release flow. Do not add a private Code Intelligence import API.

### P0 — the integrated built-in pack does not expose the real structural query

The built-in manifest declares graph tools only. The real AST journey installs a temporary wrapper around canonical Code Intelligence source. Enabling the built-in pack currently does not prove the integrated `ast_grep` path.

The integrated browser journey must inspect `/api/tools`, find the real `ast_grep`, invoke it against the imported fixture, and assert the source-relative match. A status load or mocked response is not an actual query.

### P1 — capability facts are stranded outside the panel

The panel says “Host-side, component-scoped Graphify indexes.” It does not show:

- detected language and evidence;
- whether detection was truncated;
- structural search support independently of LSP;
- named LSP server/actions;
- the current declared LSP states: disabled, requires-toolchain, ready, unavailable, or unsupported;
- host-versus-sandbox requirements.

`LspServiceReadinessSnapshot` can report `starting`, `failed`, or `stopped`, but `deriveLanguageCapabilityStatus()` truthfully collapses those to `unavailable` with a sanitized reason. The UI must not invent finer state fields. Raw JSON from **Configuration** is not a capability UX.

Implementation must extend the existing enabled-pack `routes.status` response—not add an endpoint—to include bounded detection and derived capability rows. The route resolves component/worktree roots only from its verified context; callers cannot submit paths. Render those declared rows and keep the JSON configuration route for diagnostics only.

### P1 — summary freshness can be false

`market-packs/code-intelligence/src/panel.ts` derives the top summary from `statuses[0]`. `market-packs/code-intelligence/src/graph-runtime.ts::status()` also derives the envelope state from the first component. In a mixed multi-component response, a fresh first component can mask a stale or base-fallback second component.

The summary must aggregate conservatively:

1. `failed` or `stale` → **Not current**;
2. `base-fallback` → **Limited**;
3. `building` → **Updating**;
4. all usable components `fresh` → **Current**;
5. no component → **No graph published**.

Every component card still shows its own state, revision, and reason.

### P1 — base fallback needs consequence wording

“BASE FALLBACK” is visible but unexplained. Use:

> **Base fallback** — this branch has no current graph. Queries use the accepted base graph at `<revision>` and may omit branch-only changes.

Use stale wording tied to the declared reason:

> **Stale** — the parent changed. Showing the last accepted graph at `<revision>` until this branch is rebuilt.

Never use a green/current treatment for base fallback. State text, not color, is authoritative.

### P1 — the Rebuild control promises more than the route can do

The current primary button says **Rebuild**, then **Checking…**, while the route always reports `GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8`. Static text below the button continues to say route-only rather than announcing the returned reason.

When `config.manualRebuild.available === false`, render a disabled secondary control **Rebuild unavailable** with the reason adjacent. Only render an enabled primary **Rebuild index** when the declared capability says it can execute. Never say queued unless a platform-owned job was accepted.

### P2 — global limitation and reviewer guidance need stronger hierarchy

The panel always shows “v1 has no cross-repo edges,” but as a neutral bordered paragraph. Keep it persistent and explain the consequence:

> **Repository boundary:** v1 does not create edges between component repositories. A result in `web` cannot prove a call into `api`.

Add one concise guidance note shared by panel/query output:

> Graph relationships are breadth-first leads; LSP locations are precise within the active worktree. Open and read every cited source before changing or approving code.

This preserves the existing `GraphQueryResponse.leadNotice` contract and makes the human-review behavior explicit.

### P2 — panel accessibility is incomplete

Current buttons have no explicit `type`, no `aria-busy`, no live status region, and no explicit `focus-visible` treatment. The warning has no semantic role. Header actions can also crowd on narrow panels.

Apply the assertions in §7; do not rely on color, ellipsis, or a transient spinner as the only status.

## 4. Smallest truthful flow

This selected flow adds no new page, modal, import hook, query system, graph store, or process owner.

### 4.1 Finish import normally

1. The user completes the existing Add Project component checklist and accepts the project proposal.
2. Project registration and configuration finish exactly as they do today. Code Intelligence does not block, roll back, or amend the assistant prompt.
3. The user navigates to Marketplace → Installed. The Code Intelligence card remains unchecked by default.

This is the audited import boundary. There is no production import-time decision or language detection before activation, and the UI must not claim otherwise.

### 4.2 Enable for the server

1. The built-in card explains: **This enables Code Intelligence tools and panels for every project on this server.**
2. Its existing native master checkbox is named **Enable Code Intelligence for this Bobbit server**.
3. The user explicitly checks it. The existing server-scope PUT persists `{ enabled: true }` and contribution reconciliation makes the tools, panel, and route available.
4. Do not present per-language LSP switches. The current platform cannot persist/enforce them, and detection is neither consent nor runtime readiness.

### 4.3 Detect and show capabilities

After activation, select/create a session for the imported project and open the existing `#/ext/code-intelligence` panel. **Load status** calls the existing allowlisted `status` route. That route must add bounded language/capability data using only its verified session component/worktree context; the client sends no filesystem root.

While the request is pending, show **Checking language support…** with `aria-busy="true"`. Detection failure does not disable the pack or fabricate an empty project. If `evidence.truncated === true`, show **Scan incomplete — the 10,000-entry limit was reached; some languages may be missing.** A marker-only project produces no detected language.

Keep three visual groups in this order:

1. **Capabilities** — one row per detected language.
2. **Graph index** — aggregate state, component cards, revisions, build facts, and rebuild availability.
3. **Boundaries and review guidance** — no-cross-repo note and source-verification note.

Per-language row content:

```text
TypeScript
Detected from 84 files · tsconfig.json
Structural search  Supported — syntax-aware, not type-aware
LSP                Needs TypeScript Language Server
                   Definitions, references, hover, symbols, and diagnostics are unavailable.
```

Allowed LSP labels map directly from the states currently returned by `deriveLanguageCapabilityStatus()`:

| Declared state | Visible label | Required supporting text |
|---|---|---|
| `disabled` | Disabled | Name the server and say explicit enablement is required. |
| `requires-toolchain` | Needs runtime | Name every missing requirement and whether it belongs to host or sandbox. |
| `ready` | Ready | List only matrix-declared actions. |
| `unavailable` | Unavailable | Preserve the sanitized reason, including whether the exact service is starting, failed, stopped, absent, or mismatched. Do not promote that reason into an undeclared state. |
| `unsupported` | Structural search only | Explicitly state that no LSP server is declared. |

The matrix and filename evidence justify **Structural search supported**, not runtime availability. Say **Available in this session** only if the status schema also carries an authoritative successful AST binary/tool activation fact. Otherwise the real query in §4.4 is the availability proof.

### 4.4 Actual query

Do not add a query form to the status panel. Reuse the established agent tool surface:

1. Open/create a session for the imported project.
2. Ask for a syntax-aware search, for example `console.log($$$ARGS)` in TypeScript.
3. Invoke the real `ast_grep` tool.
4. Show its normal tool card and a CWD-relative match such as `src/app.ts`.
5. Use `read` on that match for source verification.

Graph/LSP results follow the same rule: their state and component precede evidence, and the user/agent reads cited source before relying on it. A stale or base-fallback graph may still be queried, but the result must retain the state banner and consequence text.

### 4.5 Reload

1. Reload while on `#/ext/code-intelligence`.
2. Wait for contribution reconciliation.
3. Restore the owning session workspace, then re-enter the preserved extension route, matching `graph-extension-runtime.journey.spec.ts`.
4. Assert that activation scope, detected languages, capability labels, graph state/revision, and limitation notes are unchanged.
5. Reload must not start Graphify, install a runtime, or turn an unavailable LSP into ready.

### 4.6 Cleanup

1. Disable through the same server-scope Marketplace master switch used to enable.
2. Assert the toggle returns off and announces completion.
3. Assert `ast_grep`, all `graph_*`, and all actually integrated `lsp_*` tools disappear from `/api/tools`.
4. Assert the panel/entrypoint contribution disappears and `#/ext/code-intelligence` renders `ext-route-unavailable`.
5. Assert any managed LSP instance for the imported worktree stops and external branch-index records become cleanup candidates. These runtime facts belong in integration/E2E assertions, not inferred from the missing panel.
6. Delete the fixture session/project and restore the activation sentinel in `finally`, so a failed browser test cannot leak a server-wide enabled pack.

## 5. Exact implementation ownership boundaries

| Concern | Source of truth / seam | UX requirement |
|---|---|---|
| Language catalogue | `market-packs/code-intelligence/lib/language-matrix.ts` | Labels/actions/requirements come from records, never UI switches. |
| Detection | `market-packs/code-intelligence/lib/language-detection.ts` | Component-scoped filename evidence, matching markers, and truncation only; no runtime inference. `tests2/core/language-lsp-detection.test.ts` must pin that marker-only fixtures produce no language. |
| Capability labels | `market-packs/code-intelligence/lib/capability-status.ts` | Combine explicit enablement, runtime-specific probe facts, and exact service identity. Preserve its declared state union; starting/failed/stopped service reasons remain `unavailable`. |
| Status panel source | `market-packs/code-intelligence/src/panel.ts` | Production edit source; rebuild `market-packs/code-intelligence/lib/panel.js` with the existing pack build. Do not hand-edit both. |
| Panel data | `market-packs/code-intelligence/src/routes.ts` and `market-packs/code-intelligence/src/graph-runtime.ts` | Extend declared status/config data rather than raw gateway fetches. No graph paths. |
| Pack declaration | `market-packs/code-intelligence/pack.yaml` | Integrated manifest must list each shipped capability group it truly exposes. |
| Activation UI | `src/app/marketplace-page.ts`, `src/app/marketplace.css` | Reuse the existing master switch and busy/error behavior; disclose server scope. |
| Activation authority | `src/server/server.ts` pack-activation routes; `src/server/agent/builtin-packs.ts` | Do not claim per-project scope while built-ins resolve as server scope. |
| Import UI | `src/app/dialogs.ts`, `src/app/project-assistant-autoprompt.ts`, `src/app/proposal-panels.ts` | No change in the selected release flow. Do not add a pack-specific prompt, config branch, or pretend import decision. |
| Panel host | `src/app/pack-entrypoints.ts`, `src/app/pack-panels.ts`, `src/app/side-panel-workspace.ts` | Keep route and reload behavior pack-scoped and session-owned. |
| Actual query | `market-packs/code-intelligence/tools/ast/extension.ts` | Real read-only execution with source-relative output; no panel duplicate. |
| Graph honesty | `market-packs/code-intelligence/src/graph-query.ts`, `market-packs/code-intelligence/src/graph-tools.ts` | Preserve component, revision, state, no-cross-repo, and lead notice. |
| LSP honesty | `market-packs/code-intelligence/tools/lsp/extension.ts`, `market-packs/code-intelligence/lib/lsp-request-adapter.ts` | No default registration/readiness without a platform-owned exact worktree service. |

## 6. Consistency rationale

- **Marketplace master enablement:** reuse `market-pack-activation-toggle`, `market-toggle-switch market-toggle-switch--master`, its native checkbox, label text, disabled state, and focus ring from `src/app/marketplace.css`. Do not invent a second switch style.
- **Import surface:** add no Code Intelligence control to the project proposal in this release. Import finishes normally; enablement stays with its Marketplace peer controls.
- **Pack panel controls:** keep the existing border/background/text tokens, but match standard interactive behavior: explicit button type, visible `focus-visible` ring, disabled cursor/opacity, and `aria-busy`. Configuration remains secondary; rebuild is primary only when available.
- **Containers:** keep the existing panel `section`, header, bordered notices, and component `article` cards. Language rows belong above graph cards in the same scroll surface; do not create a new top-level route or side-panel tab.
- **State affordances:** every state has text plus optional semantic icon. Color may reinforce but never replace `Current`, `Stale`, `Base fallback`, `Unavailable`, or `Failed`.

## 7. Accessibility assertions

Browser and DOM coverage must assert:

1. The enable control is a labeled native checkbox with the accessible name **Enable Code Intelligence for this Bobbit server**.
2. Space toggles the focused switch; focus remains visible through the existing `.market-toggle-switch input:focus-visible + .market-toggle-slider` rule.
3. Every panel button has `type="button"`; loading controls expose `aria-busy="true"` and remain disabled until their request settles.
4. The status summary uses `role="status" aria-live="polite" aria-atomic="true"`; a completed load/rebuild/enablement change is announced once.
5. Errors retain `role="alert"`. The cross-repo boundary uses `role="note"` or an equivalently named region and includes visible text, not color alone.
6. Language rows are navigable by headings/labels and expose language, structural state, LSP state, and reason in accessible text.
7. `Stale` and `Base fallback` remain distinguishable with forced colors/high contrast because the literal state and consequence remain visible.
8. At narrow side-panel width, header controls wrap below the title without horizontal page overflow; each interactive target is at least 24×24 CSS px.
9. Keyboard order is title/summary → load or refresh → configuration → available rebuild → capability rows; unavailable actions are disabled, not focusable fake buttons.
10. Detection truncation and missing-runtime explanations are not title-only tooltips; they are persistent visible text.
11. Reload restores the same accessible names and state text; it does not move focus into the panel unexpectedly.

## 8. Browser journey contract

Add one integrated journey under `tests2/browser/journeys/` and register it in `tests2/tests-map.json`. Compose the existing helpers and journeys instead of adding another harness:

- import/component confirmation: `project-onboarding-dialog.journey.spec.ts`;
- server pack activation/panel/reload/cleanup: `graph-extension-runtime.journey.spec.ts`;
- real structural execution and tool card: `ast-grep.journey.spec.ts`.

Required journey assertions, in order:

1. Start from the disabled golden path: no Code Intelligence contribution or tools; deep link unavailable.
2. Import a fixture with at least TypeScript and Go in declared components. Assert import finishes without a Code Intelligence decision or claim.
3. Navigate to Marketplace. Assert the server enablement checkbox is unchecked and its accessible name discloses server scope; opt in with keyboard input.
4. Assert the integrated tool catalogue contains the expected structural and graph tools; LSP tools appear only if the real managed adapter is integrated.
5. Create/select a session, open `#/ext/code-intelligence`, and load status. Assert detection lists TypeScript and Go with file evidence/matching markers and does not call either LSP ready.
6. Assert language capability rows, no-cross-repo boundary, review/read guidance, and either a component state card or the honest no-graph state.
7. Invoke the real `ast_grep` query against the TypeScript fixture. Assert a non-error result names the fixture-relative source path, then read that source.
8. Seed or naturally expose two component states and prove aggregate honesty: any stale component prevents a **Current** summary; base fallback includes its consequence sentence.
9. Reload, restore the session, revisit the deep link, and assert detection/capability/state text persists without an automatic build or LSP readiness change.
10. Disable through the same server-scope Marketplace switch. Assert tools/contributions disappear and the deep link becomes unavailable.
11. In `finally`, remove session/project fixtures and clear the server activation sentinel.

Focused core coverage in `tests2/core/language-lsp-detection.test.ts` separately asserts that root markers without a matching source file do not detect a language and that a bounded scan exposes `truncated: true`.

Do not satisfy the query step with a mocked tool result, a status GET, a raw route call, or a test-only UI hook. Do not satisfy capability display by dumping JSON.

## 9. Acceptance checklist

- [ ] The UI calls this release experience post-import and makes no import-time decision claim.
- [ ] Enablement names server scope exactly; no server-global action masquerades as project-local.
- [ ] Detected language, structural search, LSP, and graph index are separate facts.
- [ ] The built-in manifest exposes the real query tool used in the browser journey.
- [ ] Mixed component state aggregates conservatively.
- [ ] Stale and base fallback explain what data is being shown and what may be missing.
- [ ] The v1 no-cross-repo limitation and source-verification guidance are persistent.
- [ ] Reload restores facts without starting work.
- [ ] Disablement removes the visible/tool surfaces and runtime cleanup is independently proved.
- [ ] Keyboard, live-region, focus, narrow-width, and non-color assertions pass.
