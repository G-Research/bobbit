# Design: Support Assistant

## Goal

A built-in **Support** agent users launch from Headquarters to ask "how do I…" questions
about Bobbit. It grounds answers in Bobbit's own docs + source, and — after explicit
confirmation — can apply server-side changes via the `bobbit` gateway tool suite.

This design consolidates the (already highly prescriptive) goal spec into concrete file
paths, signatures, and a partition plan.

## Architecture overview

Three layers, all pre-existing machinery reused:

1. **Assistant type** (`support`) — a new entry in the assistant registry + a dedicated
   prompt module. Reuses the goal/project/tool/staff-assistant session machinery.
2. **Role** (`support`) — a new `defaults/roles/support.yaml` granting the higher `bobbit`
   tiers. The support *assistant type* resolves the support *role* (today all assistant
   types resolve the `assistant` role).
3. **Launcher UI** — a sidebar/header icon (HQ-only) that POSTs a `support` assistant
   session and connects to it.

Plus **offline packaging** so docs + source ship in the npm tarball and the agent is told
their absolute paths.

## 1. Support assistant type

**`src/server/agent/support-assistant.ts`** (new) — export `SUPPORT_ASSISTANT_PROMPT`,
mirroring `goal-assistant.ts` / `project-assistant.ts`. Content requirements:

- Explain the support agent's job: answer Bobbit "how do I…" questions, ground answers in
  docs + source, and *offer* to apply server-side changes.
- **Confirmation-first (hard requirement, verified by a unit test):** the agent MUST NEVER
  call a mutating `bobbit` tool without first explaining exactly what it will do and getting
  an explicit go-ahead. Include a clearly-identifiable sentence such as:
  *"Never take an action on the user's behalf without first explaining what you will do and
  getting an explicit go-ahead."* This applies to every action, not just destructive ones.
- Tell the agent where docs + source live using two placeholders that `resolvePrompt`
  substitutes: `{{BOBBIT_DOCS_DIR}}` and `{{BOBBIT_SRC_DIR}}`. Instruct it to read/grep
  those absolute paths (NOT cwd). `AGENTS.md` + `docs/` are primary; `src/` is deeper detail.
- Describe the `bobbit` tool tiers: `bobbit_read` (free), `bobbit_orchestrate` (allowed),
  `bobbit_admin` (behind `ask` — destructive: restart/shutdown/provider-keys/marketplace).
- Note that some appearance/state is client-only — for those, guide the user rather than
  offering to apply.
- Keep it within prompt budgets (`tests2/core/tool-description-budget.test.ts` is
  tool-description-only, but keep the prompt lean regardless).

**`src/server/agent/assistant-registry.ts`** — add to `FALLBACK_DEFAULTS`:

```ts
import { SUPPORT_ASSISTANT_PROMPT } from "./support-assistant.js";
// ...
support: {
    type: "support",
    title: "Support",
    promptTitle: "Bobbit Support Assistant",
    prompt: SUPPORT_ASSISTANT_PROMPT,
},
```

`getAssistantDef("support")` / `isAssistantType("support")` then resolve automatically.

## 2. Support role

**`defaults/roles/support.yaml`** (new):

```yaml
name: support
label: Support
accessory: headset
toolPolicies:
  bobbit_orchestrate: allow
  bobbit_admin: ask
createdAt: 0
updatedAt: <ts>
promptTemplate: |
  You are the **Bobbit Support** agent (id: {{AGENT_ID}}).
  # read-only-source constraints; allowed to mutate a running Bobbit via bobbit tools
```

Key differences from the advisor `assistant` role:
- The support role IS allowed to change a running Bobbit instance via `bobbit_*` tools.
- It MUST NOT edit or commit Bobbit source code (no `write`/`edit` on source; no
  `git commit`). It reads docs + source freely from the resolved bundled paths.
- `accessory: headset` — already registered in `staff-store.ts` (`STAFF_ACCESSORIES`) and
  `bobbit-sprite-data.ts` (`ACCESSORY_HEADSET`). No accessory work needed.

`bobbit_read` needs no entry (its `grantPolicy: allow` default applies). The per-tool role
policies beat the tool YAML `grantPolicy: never` defaults (resolveGrantPolicy step 1 > 5),
mirroring `defaults/roles/general.yaml`.

## 3. Assistant-type → role mapping

Today every assistant session resolves the `assistant` role. Three hardcoded sites plus one
already-parametrized helper:

- **`session-manager.ts:2752` `resolveSessionRole(roleName, assistantType, projectId)`** —
  currently `const name = roleName || (assistantType ? "assistant" : "general");`. Change to
  map support: `roleName || assistantRoleForType(assistantType)`, where
  `assistantRoleForType(t)` returns `"support"` for `t === "support"`, `"assistant"` for any
  other assistant type, and (caller-guarded) `"general"` when there is no assistant type.
  Keep the `general` fallback: `const name = roleName || (assistantType ? assistantRoleForType(assistantType) : "general");`
- **`session-setup.ts` `_resolvePrompt` (~line 742)** — `lookupRole("assistant", …)` →
  `lookupRole(assistantRoleForType(plan.assistantType), …)`.
- **`session-manager.ts` recreate (~2998) + restore (~5393)** —
  `resolveRolePromptTemplate("assistant", …)` → `resolveRolePromptTemplate(assistantRoleForType(ps.assistantType|session.assistantType), …)`.

Define `assistantRoleForType` once (exported) — suggested home:
`src/server/agent/assistant-registry.ts` (it already owns assistant-type concerns) or a tiny
shared module. Signature:

```ts
export function assistantRoleForType(assistantType: string | undefined): string {
    return assistantType === "support" ? "support" : "assistant";
}
```

Both the tool-restriction computation (`computeEffectiveAllowedTools(…, assistantRole, …)`)
and the prompt template then pick up the `support` role's `toolPolicies`, so the support
session gets `bobbit_orchestrate`/`bobbit_admin` grants.

## 4. Offline docs + source packaging

**`package.json` `files`** — add `docs/` and `src/`:

```json
"files": ["dist/", "data/", "docker/", "docs/", "src/", "README.md"]
```

Tests live in `tests/` + `tests2/` (already excluded). This grows the tarball ~4.4 MB.
There is currently **no** npm-pack size budget test (bundle-size.test.ts is UI-dist only), so
none needs updating — but we ADD a packaging test (below) that asserts `docs/` + `src/` ship.

**Runtime path resolution** — new `src/server/agent/bundled-paths.ts`:

```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
// built: dist/server/agent/bundled-paths.js -> package root ../../..
// dev:   src/server/agent/bundled-paths.ts  -> repo root    ../../..
function resolveDir(name: string): string {
    const candidates = [
        join(here, "..", "..", "..", name),   // both layouts: <root>/<name>
        join(here, "..", "..", name),         // defensive fallback
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return candidates[0];
}
export function resolveBundledDocsDir(): string { /* cached */ }
export function resolveBundledSrcDir(): string { /* cached */ }
```

Both `dist/server/agent/*.js` and `src/server/agent/*.ts` are three levels below the package
root, so `../../../docs` and `../../../src` resolve in both layouts. Cache the results.

**Placeholder injection** — in `session-setup.ts` `_resolvePrompt`, after assembling
`assistantGoalSpec` for the `support` type (mirroring the `goal` type's
`{{AVAILABLE_WORKFLOWS}}` substitution):

```ts
if (plan.assistantType === "support") {
    assistantGoalSpec = assistantGoalSpec
        .replaceAll("{{BOBBIT_DOCS_DIR}}", resolveBundledDocsDir())
        .replaceAll("{{BOBBIT_SRC_DIR}}", resolveBundledSrcDir());
}
```

Apply the SAME substitution on the session-manager restore/recreate paths so restored
support sessions keep valid paths. (Both paths already branch on `assistantType === "goal"`.)

## 5. Launcher UI

**`src/app/render.ts`** — add a `Support` icon button immediately to the LEFT of the QR
button, gated on `isHeadquartersProject(state.activeProjectId)`, in BOTH:

- Desktop sidebar header (~line 3131, the `bobbitIcon` + "Bobbit" block, `QrCode` at xs).
- Mobile header `headerRight()` (~line 2313, `QrCode` at sm).

Use Lucide `LifeBuoy` (clearest "support" affordance). Import it in the existing `lucide`
import (line 11). Button props: `title: "Support"`, a stable
`data-testid="support-launcher"`, `onClick: () => showSupportDialog()` (lazy import via
`dialogs-lazy.js`). Only render when
`isHeadquartersProject(state.activeProjectId)` is true — hidden for normal projects.

**`src/app/dialogs.ts`** — add `showSupportDialog()` mirroring `createGoalAssistantSession`:

```ts
export async function showSupportDialog(): Promise<void> {
    if (state.creatingSession) return;
    state.creatingSession = true; renderApp();
    try {
        const res = await gatewayFetch("/api/sessions", {
            method: "POST",
            body: JSON.stringify({ assistantType: "support", projectId: HEADQUARTERS_PROJECT_ID }),
        });
        if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
        const { id } = await res.json();
        await connectToSession(id, false, { assistantType: "support" });
    } catch (err) { /* showConnectionError */ }
    finally { state.creatingSession = false; renderApp(); }
}
```

Export it through `dialogs-lazy.js` (same barrel as `showGoalDialog`/`showQrCodeDialog`).
Import `HEADQUARTERS_PROJECT_ID` in dialogs.ts (from `./headquarters.js`).

## 6. Tests

- **`tests2/core/role-bobbit-tools-policy.test.ts`** — extend (do NOT weaken): the
  orchestrate-granting set becomes `["general", "support", "team-lead"]`; the admin-granting
  set becomes `["general", "support"]`; assert `support` resolves `bobbit_orchestrate=allow`
  and `bobbit_admin=ask`. Update the leading comment block to reflect the widened surface.
- **New unit test** (e.g. `tests2/core/support-assistant.test.ts`): `getAssistantDef("support")`
  present with title "Support" / promptTitle "Bobbit Support Assistant"; `support.yaml` loads
  with `accessory: headset` + the two toolPolicies; `SUPPORT_ASSISTANT_PROMPT` contains the
  confirmation-first sentence; `assistantRoleForType("support") === "support"` and
  `assistantRoleForType("goal") === "assistant"`.
- **New packaging test** (e.g. `tests2/core/package-files.test.ts`): `package.json` `files`
  includes `docs/` and `src/`; run `npm pack --dry-run --json` and assert the file list
  contains at least one `docs/` and one `src/` entry. Also assert `resolveBundledDocsDir()`
  / `resolveBundledSrcDir()` return existing directories in this repo layout.
- **Browser journey** (`tests2/browser`): `support-launcher` hidden when a normal project is
  active, visible only under Headquarters; sits left of the QR button in desktop + mobile;
  clicking creates + opens a Support session in HQ; reload keeps the session. Register in
  `tests2/tests-map.json`.

## 7. Partition (parallel work)

Disjoint file sets → two parallel coders + reused verification gates:

- **Backend (coder A)** — `support-assistant.ts`, `assistant-registry.ts`, `support.yaml`,
  `bundled-paths.ts`, `session-setup.ts`, `session-manager.ts`, `package.json`; plus the
  backend unit tests (registry/role/prompt, role-bobbit-tools-policy extension, packaging).
- **Frontend (coder B)** — `render.ts`, `dialogs.ts`, `dialogs-lazy.ts`; plus the
  `tests2/browser` launcher journey + `tests-map.json`.

No shared files between A and B. Team lead merges both, runs `npm run check` + targeted
unit/browser checks, then signals implementation.

## Constraints

- No `main` branch; primary is `master`.
- Support role may mutate a running Bobbit via `bobbit` tools but MUST NOT edit/commit source.
- Keep prompts lean.
