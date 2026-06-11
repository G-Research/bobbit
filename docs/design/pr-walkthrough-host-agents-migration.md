# PR Walkthrough → `host.agents` migration

**Status:** design — implementation-ready
**Goal:** Restore the PR walkthrough to a real, isolated, **read-only child reviewer principal** launched via `host.agents`, replacing today's downgrade that hijacks the user's current agent via `host.session.postMessage`. Delete the legacy `src/server/pr-walkthrough` launcher, the `childKind:"pr-walkthrough"` session-manager special-cases, and the submit-proof secret — preserving every security-critical and production-faithful piece (the read-only policy, the bundle/publish/card synthesis, idempotency, model inheritance, right-job routing).

This doc finalizes the **HOW**. The **WHAT** is locked by the goal spec; do not relitigate it.

---

## 1. Overview

Today the "Run PR walkthrough" gesture in the pack panel calls `host.session.postMessage({role:"user", text: RUN_PROMPT, resumeTurn:true})` (`market-packs/pr-walkthrough/src/panel.js:64,353-371`, `RUN_PROMPT` at `:42-49`). This drives the **user's current agent**: it pollutes the user's session, cannot run while the user works, and is not an isolated principal. The real launcher (`src/server/pr-walkthrough/walkthrough-agent-manager.ts`) still exists and still mints a first-class reviewer, but the pack UI no longer triggers it.

The migration replaces the panel's `postMessage` launch with a **pack route** (`run`) that calls **`host.agents.spawn(...)`** (`src/server/extension-host/server-host-api.ts:84-118,266-291`), minting a **real, visible, read-only reviewer child** owned by the user's session. The reviewer runs the **unchanged** walkthrough toolchain and produces the production YAML; the panel polls a new `status` route and runs the **unchanged** `publish`→`bundle` synthesis to render the same cards.

The reviewer's toolset is granted by a **pack-shipped `pr-reviewer` role** (not by an env-gated secret). Job routing uses a **pack-store `{ childSessionId → jobId }` binding** authorized against the server-verified caller session id. The submit-proof secret is deleted in its entirety.

---

## 2. Current state (verified in code)

### 2.1 The downgrade (to delete)
- `market-packs/pr-walkthrough/src/panel.js`
  - `RUN_PROMPT` constant (`:42-49`).
  - `onRun()` gesture (`:340-410`): `host.session.postMessage({role:"user", text:RUN_PROMPT, resumeTurn:true})` then polls **its own** transcript (`host.session.readTranscript`/`readToolCall`, own-session only) for a new `submit_pr_walkthrough_yaml` tool call, then `publishAndLoad`.
  - `postErrorMessage()` (`:78-85`) maps `postMessage` failures.
  - `byJob` state machine statuses `posting | waiting` (`:108-110`) belong to the postMessage flow.
- Built copy `market-packs/pr-walkthrough/lib/panel.js` is generated from `src/panel.js` by `build:packs` (see §3.5) — never hand-edit it.

### 2.2 The legacy launcher (to delete)
- `src/server/pr-walkthrough/walkthrough-agent-manager.ts`
  - `WalkthroughAgentManager.launch()` / `launchNew()` (≈`:230-330`): mints the reviewer via `createSession({ rolePrompt: buildRolePrompt(target), roleName:"pr-walkthrough", role:"pr-walkthrough", accessory:"review", allowedTools: WALKTHROUGH_ALLOWED_TOOLS, parentSessionId, childKind:"pr-walkthrough", readOnly:true, walkthroughJobId, walkthroughChangesetId, walkthroughTargetKey, initialModel, env:{ BOBBIT_WALKTHROUGH_JOB_ID, BOBBIT_WALKTHROUGH_SUBMIT_PROOF, …targetEnv } })`.
  - `findByParentAndTarget` + `launchInFlight`/`launchKey` idempotency (`:296-318`).
  - `resolveParentInitialModel()` model inheritance (`:560-564`).
  - `submitYaml()` (`:430-520`): proof check `verifySubmissionProof`, terminal-job (`ready`) 409, validate+map+`saveWalkthrough`, then `terminateChild`.
  - `readBundle()` (`:402-415`): reads `WalkthroughAnalysisBundleStore`, gated by `job.childSessionId === input.sessionId`.
  - `WALKTHROUGH_ALLOWED_TOOLS = ["readonly_bash","read_pr_walkthrough_bundle","submit_pr_walkthrough_yaml"]` (`:198-202`).
  - `buildRolePrompt()` + `REQUIRED_YAML_SCHEMA_PROMPT` (`:600-760`), `buildKickoffPrompt()` (`:762-775`).
- `src/server/pr-walkthrough/walkthrough-agent-store.ts`
  - Submit-proof machinery: `createSubmissionProof`, `hashSubmissionProof`, `verifySubmissionProof`, `rotateSubmissionProofForRestoredJob`, `walkthroughTargetEnvForJob`, the `BOBBIT_WALKTHROUGH_SUBMIT_PROOF` env, `submissionProofHash` field (`:84-140`). **All proof functions deleted; the job record + `WalkthroughAgentStore` survive only if still needed — see §6.**
- `src/server/pr-walkthrough/walkthrough-reap.ts` — `shouldReapWalkthroughChildOnBoot` (whole file deleted; subsumed by `OrchestrationCore.shouldReapChildOnBoot`).
- `src/server/server.ts`
  - import + instantiation `WalkthroughAgentManager` (`:242`, `:1595`), threaded as `prWalkthroughAgentManager` into `handleApiRoute` (`:1345`, signature `:2388`, used `:2461-2466`) and `prWalkthroughAgentManager.restore()` (`:1934`).
- `src/server/agent/session-manager.ts`
  - boot-reap `pr-walkthrough` branch (`:3362-3374`) reading `WalkthroughAgentStore`.
  - `restoreWalkthroughSubmitEnv()` + `rotateSubmissionProofForRestoredJob` (`:3491-3499`, called `:3513`).
  - sandbox-worktree skip `session.childKind !== "pr-walkthrough"` (`:5620`).
  - persisted metadata fields `walkthroughJobId/walkthroughChangesetId/walkthroughTargetKey` threaded throughout (`:218-220` and ≈20 sites).

### 2.3 What stays (production-faithful — do NOT regress)
- `src/server/pr-walkthrough/walkthrough-readonly-policy.ts` — the `readonly_bash` allowlist. Pinned by `tests/pr-walkthrough-readonly-policy.test.ts`.
- Synthesis pipeline: `src/shared/pr-walkthrough/yaml-to-cards.ts` (`mapYamlToWalkthroughPayload`, `validatePrWalkthroughYaml`), `src/shared/pr-walkthrough/ids.ts` (`changesetIdForGithub`), and the server modules `walkthrough-yaml-schema.ts`, `card-synthesis.ts`, `export-mapper.ts`, `diff-parser.ts`, `git-changeset.ts`, `github-adapter.ts`, `walkthrough-analysis-bundle.ts`.
- The pack routes `bundle` + `publish` (`market-packs/pr-walkthrough/lib/routes.mjs`) — **byte-stable**. The panel synthesis source (`yaml-to-cards.mjs`) is built from `src/shared/pr-walkthrough/yaml-to-cards.ts` (`market-packs/pr-walkthrough/src/yaml-to-cards.js`), the SAME module the agent toolchain uses — so cards are byte-stable as long as `publish` is unchanged.
- The agent tools `defaults/tools/pr-walkthrough/{readonly_bash,read_pr_walkthrough_bundle,submit}.yaml` + `extension.ts` — kept, with the env-gate + proof header removed (§ Decision C).

### 2.4 What `host.agents` already gives us
`server-host-api.ts` exposes the poll-based `spawn/prompt/dismiss/list/read/status`, owner-scoped + `childKind:"host-agents"` source-filtered. `spawn` opts: `instructions, role?, model?, thinkingLevel?, readOnly?, context?, lifecycle?` — **no `allowedTools`, no `env`**. `spawn` throws for child sessions (no grandchildren). `OrchestrationCore.spawn` (`orchestration-core.ts:300-380`) currently forces `readOnly ⇒ lifecycle:"bare"` (`:330`) → `createDelegateSession`, which does NOT thread `role`/`roleName` and derives the child's `allowedTools` from the **owner** (`childAllowedTools`, `:255-285`). `host.agents.spawn` is **not frozen** and may be amended for this migration (pre-agreed by Orchestration Core).

---

## 3. Target architecture

### 3.1 Components
- **Panel** (`src/panel.js`): replaces the `postMessage` launch with `host.callRoute("run", …)`; polls `host.callRoute("status", …)`; on submit, keeps the existing `publishAndLoad` → `host.callRoute("publish")` → `host.callRoute("bundle")` seam.
- **`run` route** (new, `lib/routes.mjs`, confined worker, has `ctx.host.agents` + `ctx.host.store`): idempotency check (re-issues a deterministic kickoff to a live bound-but-not-started child; clears a stale terminated reviewer index) → resolve changeset/SHAs + canonical target → `ctx.host.agents.spawn({role:"pr-reviewer", readOnly:true, lifecycle:"full", deferInitialPrompt:true, context})` (child visible but NOT started) → **in one try/catch:** write store bindings with `kickedOff:false` (the binding carries the target) → `ctx.host.agents.prompt(childSessionId, kickoffPrompt)` (start the reviewer AFTER the binding exists) → flip `kickedOff:true`. On ANY post-spawn failure it COMPENSATES (dismiss child + delete the `binding/`+`reviewer/` keys) and returns `{ ok:false, retryable:true, error, code }`; on success returns `{ jobId, childSessionId, changesetId, baseSha, headSha, status }`. It does **not** build a launch bundle; the analysis bundle is resolved server-side, lazily, by the `bundle` endpoint (Finding 4 / §6).
- **`status` route** (new, `lib/routes.mjs`): input `{ childSessionId, jobId }` → **binding-authoritative:** loads `binding/${childSessionId}` FIRST and verifies `binding.jobId === jobId` AND `binding.parentSessionId === ctx.sessionId` (structured error on missing/mismatch), THEN reads the pack-store submitted-YAML marker (keyed by `binding.jobId`) + `ctx.host.agents.status(childSessionId)` → returns `{ phase:"running"|"submitted"|"error", agentStatus, yaml?, baseSha?, headSha?, error? }`. On the error path it marks `binding.status:"error"` and `ctx.host.agents.dismiss(childSessionId)`s the child (which stamps the generic `childTerminal` marker server-side, Finding 3/4); the dismiss on `submitted` is a redundant safety net (submit already server-dismisses, Decision E).
- **`pr-reviewer` role** (new, `market-packs/pr-walkthrough/roles/pr-reviewer.yaml`): `promptTemplate` = ported `buildRolePrompt` + `REQUIRED_YAML_SCHEMA_PROMPT`; `accessory: review`; `toolPolicies` grant exactly the three walkthrough tools.
- **Agent tools** (`defaults/tools/pr-walkthrough/extension.ts`): env-gate + proof header removed; `read_pr_walkthrough_bundle` and `submit_pr_walkthrough_yaml` send only `sessionId` (+ session secret), the server resolves `jobId` from the binding.
- **`submit-yaml` + `bundle` server routes** (`src/server/pr-walkthrough/routes.ts`, kept but rewired): no proof; resolve `jobId`+`target` from the pack-store binding keyed by the verified caller `sessionId`. `bundle` lazily resolves the analysis bundle from the target via the EXISTING server pipeline and caches it in `WalkthroughAnalysisBundleStore` keyed by `jobId` (kept); `submit-yaml` stores the raw YAML into the pack store, marks the binding terminal, and server-dismisses the reviewer (`orchestrationCore.dismiss`).
- **`OrchestrationCore`** (`orchestration-core.ts`): two backward-compatible amendments (Decision A).

### 3.2 Data flow (happy path)
```
Panel "Run" click
  └─ host.callRoute("run", {prUrl|baseSha+headSha})           [client → POST /api/ext/route/run]
       run route (worker):
         1. canonicalKey, changesetId ← deriveTarget(args)
         1b. CONCURRENCY GUARD: launchKey = `${parent}\0${canonicalKey}`. A MODULE-SCOPED
             in-flight Map<launchKey, Promise> (the analogue of the deleted launchInFlight):
             if an entry exists, await it and return its result (created:false) — this
             serializes near-simultaneous same-target run calls so only ONE reviewer is
             ever spawned. Register the promise covering steps 2–5; delete it in finally.
         2. idempotency: store.get(reviewerKey(parent, canonicalKey))
              ├─ resolves a LIVE child (host.agents.status ≠ terminated):
              │     binding ← store.get(bindingKey(childSessionId))
              │     ├─ binding.kickedOff === false → host.agents.prompt(childSessionId, kickoffPrompt)
              │     │      (DETERMINISTIC kickoff retry; then store.put(binding, {…, kickedOff:true}))
              │     │      — never return a never-started child the panel would poll forever
              │     └─ return its {jobId, childSessionId, status} (created:false)
              ├─ resolves a TERMINATED child → stale index: store.delete(reviewerKey(parent, canonicalKey));
              │     continue (launch fresh)
              └─ no entry → continue
         3. {childSessionId} ← host.agents.spawn({role:"pr-reviewer", readOnly:true,
                                  lifecycle:"full", deferInitialPrompt:true, context})  // visible, NOT started
              (spawn throws → return {ok:false, retryable:true, error, code}; no binding written)
         4. ALL post-spawn steps in ONE try/catch — on ANY failure COMPENSATE, then
            return {ok:false, retryable:true, error, code} so a retry starts clean:
              a. store.put(bindingKey(childSessionId), {jobId, changesetId, baseSha, headSha,
                          parentSessionId, canonicalKey, target, status:"running", kickedOff:false})
              b. store.put(reviewerKey(parent, canonicalKey), {childSessionId, jobId})
              c. host.agents.prompt(childSessionId, kickoffPrompt)   // start reviewer AFTER binding exists
              d. store.put(bindingKey(childSessionId), {…, kickedOff:true})  // set ONLY after (c) succeeds
            COMPENSATE := host.agents.dismiss(childSessionId)        // no orphaned visible child
                          store.delete(bindingKey(childSessionId))  // no stale binding
                          store.delete(reviewerKey(parent, canonicalKey))  // no stale reviewer index
         5. return {jobId, childSessionId, changesetId, baseSha, headSha, status:"running"}

Reviewer child (separate visible session, "review" accessory, read-only):
  - read_pr_walkthrough_bundle  → POST /api/internal/pr-walkthrough/bundle {sessionId}
        server resolves jobId+target ← store.get(bindingKey(sessionId));
        lazily resolves the analysis bundle from the target via the EXISTING server
        pipeline (github-adapter for GitHub PRs, git-changeset for local), caches it in
        WalkthroughAnalysisBundleStore keyed by jobId; returns the SAME shape as today
  - readonly_bash (git/gh, gated by walkthrough-readonly-policy.ts)
  - submit_pr_walkthrough_yaml  → POST /api/internal/pr-walkthrough/submit-yaml {sessionId, yaml}
        server verifies session secret; jobId ← store.get(bindingKey(sessionId));
        409 if submittedKey(jobId) exists OR binding.status ∈ TERMINAL;
        else store.put(submittedKey(jobId), {yaml, baseSha, headSha});
        store.put(bindingKey(sessionId), {…, status:"submitted"});
        orchestrationCore.dismiss(binding.parentSessionId, sessionId)   // terminal-synchronous reap

Panel poll loop:
  └─ host.callRoute("status", {childSessionId, jobId})
       status route (worker):
         binding ← store.get(bindingKey(childSessionId))                 // BINDING-AUTHORITATIVE: load FIRST
         if !binding OR binding.jobId !== jobId
              OR binding.parentSessionId !== ctx.sessionId               // verify caller owns the bound job
            → {phase:"error", error:"unknown or mismatched binding"}     // structured error; read nothing else
         submitted   ← store.get(submittedKey(binding.jobId))            // ONLY THEN, keyed by the BOUND jobId
         agentStatus ← host.agents.status(childSessionId)
         if submitted → {phase:"submitted", yaml, baseSha, headSha}; host.agents.dismiss(child)
         elif agentStatus==="terminated" →                              // errored, no submission
              store.put(bindingKey(childSessionId), {…binding, status:"error"});
              host.agents.dismiss(childSessionId)   // stamps the generic childTerminal marker server-side (F3/F4)
              → {phase:"error", …}
         else → {phase:"running", agentStatus}
  └─ on "submitted": publishAndLoad(yaml)   (UNCHANGED seam)
       host.callRoute("publish", {jobId, yaml, baseSha, headSha})  → cards persisted
       host.callRoute("bundle",  {jobId, baseSha, headSha})        → cards rendered
```

### 3.3 Why the panel cannot read the reviewer's transcript
`host.session.readTranscript/readToolCall` are **own-session only** (`ServerHostSessionApi`, no foreign-session param). The reviewer is a *different* session, so the panel cannot read its submit tool call. The submitted YAML therefore travels through the **pack store** (`submittedKey(jobId)`), surfaced by the `status` route. This is the single structural change to the panel's data source; the downstream `publish`→`bundle` seam is unchanged.

### 3.4 Visibility
The reviewer uses `lifecycle:"full"` → `OrchestrationCore.spawn`'s `createSession` branch (`orchestration-core.ts:333-378`), which threads `parentSessionId`, `childKind`, `roleName`, `readOnly`, and inherits the owner's sandbox + model — exactly the legacy `createSession` shape, so the reviewer is a first-class **visible** child session with the role's `review` accessory (pre-downgrade parity), now with `childKind:"host-agents"`.

**Deliberate `full` vs the spec's `bare` example.** The goal spec sketch showed `lifecycle:"bare"`; this design uses `lifecycle:"full"` deliberately. A visible, role-carrying reviewer session REQUIRES the full lifecycle — `bare`/`createDelegateSession` neither threads `role`/`accessory` nor surfaces a sidebar-visible session. Implementers must NOT treat `bare` as still required; this is an intentional interpretation/amendment of the spec example (Decision A.1).

### 3.5 Build pipeline (source of truth)
- `market-packs/pr-walkthrough/src/panel.js` is the SOURCE; `build:packs` (`scripts/build-market-packs.mjs`, `PACKS["pr-walkthrough"]`) bundles it via esbuild to `lib/panel.js`. **Edit `src/panel.js`, then run `npm run build:packs`, and commit BOTH.**
- `lib/routes.mjs` and `lib/yaml-to-cards.mjs`: `routes.mjs` is **hand-authored** and served as-is (NOT bundled — see the build script comment); `yaml-to-cards.mjs` is bundled from `src/yaml-to-cards.js`. So `run`/`status` are added by hand-editing `lib/routes.mjs` directly. There is no `src/routes.mjs`.
- `pack.yaml`: add `roles: [pr-reviewer]` under `contents` and add `run`, `status` to `routes.names`.
- `scripts/copy-builtin-packs.mjs` copies `market-packs/` into `dist/server/builtin-packs/` on `build:server`; no change needed beyond shipping the new role file (it lives under the pack root and is copied wholesale).

---

## 4. Decisions

### Decision A — role-based tool granting on a read-only spawn

**Problem.** `host.agents.spawn({role:"pr-reviewer", readOnly:true})` must grant the child **exactly** `[readonly_bash, read_pr_walkthrough_bundle, submit_pr_walkthrough_yaml]` from the `pr-reviewer` role — NOT the owner's tools — and the child must be a **visible** session. Today `readOnly ⇒ lifecycle:"bare"` → `createDelegateSession`, which ignores `role` and derives tools from the owner (`orchestration-core.ts:255-285,330`).

**Options evaluated.**
- *(i) Thread `role` through the bare/delegate path* (`createDelegateSession`): would need `createDelegateSession` to resolve a role promptTemplate, accessory, and role-sourced tools — a path it does not currently support, and bare delegates are not the pre-downgrade visible-session shape.
- *(ii) A role-resolves-allowedTools hook in `OrchestrationCore.spawn`* + reuse the **full** lifecycle (`createSession`) which ALREADY threads `roleName`/`role`/`accessory`/`allowedTools`/`parentSessionId`/`childKind`/`readOnly` and is exactly what the legacy launcher used.

**Chosen: (ii).** Reuse the full lifecycle for a role-carrying read-only spawn, and source the child's `allowedTools` from the role. Two backward-compatible amendments to `orchestration-core.ts`:

1. **Honor explicit `lifecycle:"full"` under `readOnly`.** Change the lifecycle selection so `readOnly` defaults to `"bare"` but does not *override* an explicit `"full"`:
   ```ts
   // before: const lifecycle = opts.readOnly ? "bare" : (opts.lifecycle ?? "bare");
   const lifecycle: SpawnLifecycle = opts.lifecycle ?? (opts.readOnly ? "bare" : "bare");
   ```
   (i.e. `opts.lifecycle` wins when set; otherwise default `"bare"`.) A read-only child with no explicit lifecycle still goes bare — existing `host.agents`/delegate behavior unchanged. The `run` route passes `lifecycle:"full"`. **Deliberate amendment vs the goal-spec example:** the spec sketch showed `lifecycle:"bare"`, but a visible, role-carrying reviewer requires the **full** lifecycle (`createSession`); `bare`/`createDelegateSession` neither threads `role`/`accessory` nor produces a sidebar-visible session. Implementers must NOT treat `bare` as still required (see §3.4).

2. **Role-sourced child tools (FAIL CLOSED).** Add an optional dep and use it in `childAllowedTools`. A role-carrying spawn is granted the ROLE's tools and **never** falls back to the owner's tools — if the role's grants cannot be resolved, the spawn throws:
   ```ts
   export interface OrchestrationCoreDeps {
     // …
     /** Resolve a ROLE's effective tool grants (the explicit allow-list a role
      *  session would receive), for role-carrying spawns. Production wires it to
      *  computeEffectiveAllowedTools(toolManager, role, groupPolicyStore, mcpManager). */
     resolveRoleAllowedTools?: (roleName: string, projectId?: string) => string[] | undefined;
   }

   private childAllowedTools(ownerId: string, readOnly?: boolean, role?: string): string[] | undefined {
     const deny = (t: string) =>
       SPAWN_VERBS.includes(t) || (readOnly === true && READ_ONLY_DENY_TOOLS.includes(t));
     // FAIL CLOSED: a role-carrying spawn is granted the ROLE's tools, NEVER the owner's.
     if (role) {
       const roleTools = this.deps.resolveRoleAllowedTools?.(role);
       if (!roleTools || roleTools.length === 0) {
         throw new OrchestrationCoreError(
           `Cannot resolve tool grants for role ${role}`, "ROLE_TOOLS_UNRESOLVED");
       }
       return roleTools.filter(t => !deny(t));
     }
     // …unchanged owner-derived path — reached ONLY for role-LESS delegate/team spawns…
   }
   ```
   Call site in `spawn`: `const childAllowed = this.childAllowedTools(opts.ownerSessionId, opts.readOnly, opts.role);`.

   For `pr-reviewer`, `resolveRoleAllowedTools("pr-reviewer")` returns the three tools (the role's `toolPolicies` grant only those, and the "PR Walkthrough" group is default-deny — see Decision C); none are spawn verbs or in `READ_ONLY_DENY_TOOLS`, so the child gets exactly the three. **No regression / no isolation hole:** the owner-derived fallback path remains ONLY for role-LESS delegate/team spawns (unchanged) — it is reached exclusively when no `role` is set. A role spawn whose resolver is unavailable or returns empty does **not** silently inherit the owner's broader tools; it throws `ROLE_TOOLS_UNRESOLVED`. Tests exercising role spawns MUST wire `resolveRoleAllowedTools`; the `run` route surfaces `ROLE_TOOLS_UNRESOLVED` as a **retryable** launch error (Decision E).

3. **Production wiring** (`server.ts` `new OrchestrationCore({…})` at `:1175`): add `resolveRoleAllowedTools: (roleName, projectId) => { const role = roleManager.getRole(roleName) ?? configCascade?.resolveRoles(projectId).find(r => r.item.name===roleName)?.item; return role && toolManager ? computeEffectiveAllowedTools(toolManager, role, groupPolicyStore, mcpManager).map(e=>e.name) : undefined; }`. This mirrors the existing `resolveEffectiveTools` dep already wired there (`server.ts:1197`) and `session-setup.ts:430`.

4. **Accessory.** `createSession` resolves `roleName` → role and applies `role.accessory` (the same path team `reviewer` sessions use to show their accessory). Confirm in implementation that `session-setup` applies `role.accessory`; if not, thread `accessory` from the resolved role there. The `run` route does not pass an accessory; it comes from the role.

5. **`deferInitialPrompt` (atomic launch, race-free binding).** Add an optional `deferInitialPrompt?: boolean` to both `OrchestrationCore.spawn` opts and `host.agents.spawn` opts (allowed — `host.agents` is **not** frozen; this is the one optional field it gains). When `true`, the full-lifecycle path creates the visible child but does **not** enqueue `opts.instructions`/auto-kickoff — the caller starts the reviewer explicitly via a follow-up `host.agents.prompt`. This lets the `run` route write the `{childSessionId→jobId}` binding BEFORE the reviewer's first tool call, closing the spawn/binding race: a full-lifecycle spawn otherwise enqueues the kickoff internally, so the reviewer's first `read_pr_walkthrough_bundle` could race ahead of the binding and 403. Sequence (§3.2 / Decision E): spawn(deferInitialPrompt:true) → write `binding/${childSessionId}` + `reviewer/…` → `host.agents.prompt(childSessionId, kickoffPrompt)` → return.

`host.agents.spawn` gains exactly one optional field (`deferInitialPrompt`); it otherwise already forwards `role`, `readOnly`, `lifecycle`, `context`, `instructions` (`server-host-api.ts:267-289`).

**Spec reconciliation (deliberate, pre-agreed amendment — NOT scope creep).** The goal spec contains two sentences in tension: the no-secret rationale says "`host.agents.spawn` is not amended" while the current-state section says "`agents:true` is **not** frozen — this migration **may amend it**." These reconcile cleanly: the "not amended" sentence is specifically about NOT needing to push a *submit-proof secret* through `host.agents` (true — the secret is deleted, nothing secret travels with the child). The `deferInitialPrompt` field is an orthogonal, minimal launch-atomicity amendment explicitly permitted by the "not frozen" clause. Implementers/reviewers should treat the single new optional `deferInitialPrompt` field + the `lifecycle:"full"` choice (§3.4) as the agreed, bounded amendment surface for this migration — no other `host.agents` signature change is in scope.

### Decision B — how the pack ships the `pr-reviewer` role

Roles are first-class pack contributions. `RoleLoader` (`pack-resolver.ts:79-90`) reads `<packRoot>/roles/*.yaml` via `parseRolesDir` (`builtin-config.ts:56-74`); `marketplace-install.ts:234-248` reads `contents.roles[]` basenames. The `Role` shape (`role-store.ts:73-101`): `{ name, label, promptTemplate, accessory, toolPolicies?, model?, thinkingLevel? }`, `toolPolicies` = `Record<toolNameOrGroupPrefix, GrantPolicy>`.

**Contribution:**
- `pack.yaml`: `contents.roles: [pr-reviewer]`.
- New file `market-packs/pr-walkthrough/roles/pr-reviewer.yaml`:
  ```yaml
  name: pr-reviewer
  label: PR Walkthrough Reviewer
  accessory: review
  toolPolicies:
    # Group-level grant for the "PR Walkthrough" group (the three tools' group).
    # The same group is default-DENY for all other roles (Decision C), so submit
    # is reachable ONLY from this role.
    "PR Walkthrough": allow
  promptTemplate: |
    You are a read-only PR walkthrough agent.
    Investigate the PR using only read-only tools and report rough percentage progress in chat.
    Start from read_pr_walkthrough_bundle; it is the authoritative launch-time PR metadata and diff bundle for this job. Use readonly_bash only for additional read-only investigation.
    Do not edit files, run tests/builds, install dependencies, push, commit, or submit GitHub reviews/comments.
    When complete, call submit_pr_walkthrough_yaml with exactly one YAML document matching the schema below. The panel will remain empty until that tool succeeds.
    <<REQUIRED_YAML_SCHEMA_PROMPT verbatim from walkthrough-agent-manager.ts:600-758>>
  ```
  Port `REQUIRED_YAML_SCHEMA_PROMPT` (`walkthrough-agent-manager.ts:600-758`) **verbatim** into the template. The per-target lines (`Target: <canonicalKey>`, PR URL, range) are NOT in the role prompt; they go into the `run` route's `instructions` (the kickoff), mirroring the legacy `buildRolePrompt` (static) vs `buildKickoffPrompt` (per-target) split.

**Boundary confirmation:** because `submit_pr_walkthrough_yaml` is granted only through the `PR Walkthrough` group and that group is default-deny (Decision C), no normal session can call it — the "only the reviewer submits" property falls out of tool-granting, with no secret. Pinned by a new unit test (§7).

### Decision C — the `{ childSessionId → jobId }` pack-store binding + submit authorization

**Tool-granting boundary (no env-gate, no proof).**
- `defaults/tools/pr-walkthrough/extension.ts`: delete the top guard `if (!sessionId || !jobId || !submissionProof) return;` and register the tools whenever `BOBBIT_SESSION_ID` is present. Remove `BOBBIT_WALKTHROUGH_JOB_ID`/`BOBBIT_WALKTHROUGH_SUBMIT_PROOF` reads and the `X-Bobbit-Walkthrough-Submit-Proof` header. Registration ≠ activation: the actual boundary is the role grant + `allowedTools`.
- **Default-deny the group.** Add a default group policy for the `PR Walkthrough` group = `deny` (so even an *unrestricted* session, whose `allowedTools` is `undefined` = "all tools", does not get these tools). The `pr-reviewer` role's `toolPolicies` override it to `allow`. Wire the default in the same place other built-in group policies are seeded (`groupPolicyStore` / `defaults` tool-group policy); add a unit assertion that `general` does not resolve `submit_pr_walkthrough_yaml`.

**Binding shape (pack store, packId `pr-walkthrough`).** Keys:
```
bindingKey(childSessionId)        = `binding/${childSessionId}`
   → { jobId, changesetId, baseSha, headSha, parentSessionId, canonicalKey, target, status, kickedOff }
        status   ∈ "running" | "submitted" | "ready" | "error"   // TERMINAL = {submitted, ready, error}
        kickedOff: boolean  // false until host.agents.prompt(kickoff) succeeds; gates deterministic
                            // kickoff retry of a bound-but-not-started child (Finding 1 / Decision E)
reviewerKey(parentSessionId, key) = `reviewer/${parentSessionId}/${b64url(canonicalKey)}`
   → { childSessionId, jobId }                 // idempotency index (Decision E)
submittedKey(jobId)               = `submitted/${jobId}`
   → { yaml, baseSha, headSha, submittedAt }   // raw YAML for the panel poll
// NO launch-bundle key — the analysis bundle is resolved server-side (§6, Finding 4).
```
The `run` route writes `bindingKey` (with `kickedOff:false`) + `reviewerKey` AFTER a successful `deferInitialPrompt` spawn and BEFORE the kickoff `host.agents.prompt`, then flips `kickedOff:true` only AFTER the kickoff succeeds; all post-spawn steps are wrapped in one try/catch that COMPENSATES (dismiss child + delete both keys) on any failure (race-free + failure-atomic, Decision A.5 / E). The pack store holds only `binding/`, `reviewer/`, and `submitted/` keys — there is **no** `launch-bundle/` key (the analysis bundle is resolved server-side, §6). The store is pack-scoped server-side by the SERVER-derived packId (`server-host-api.ts:170-182`); the pack route never names a packId.

**The submit-yaml / bundle endpoints reach the pack store (the integration seam).** The submit tool runs in the **reviewer agent process** and calls the gateway over HTTP (`extension.ts` `fetch`), so it cannot use `host.callRoute` (client-only) — submit/bundle **stay server routes** (`src/server/pr-walkthrough/routes.ts`). They reach the pack-scoped store with the **constant builtin packId `"pr-walkthrough"`** via the process-singleton `getPackStore()` (the same store `ctx.host.store` delegates to). Concretely, in `routes.ts`:
```ts
import { getPackStore } from "../extension-host/pack-store.js";
const PRW_PACK_ID = "pr-walkthrough";
// submit-yaml handler:
const TERMINAL = ["submitted", "ready", "error"];        // single source for submit/status/publish/tests
const sessionId = body.sessionId;                       // child's BOBBIT_SESSION_ID
verifyCallerSession(req, sessionId);                    // session-secret check, below
const binding = await getPackStore().get(PRW_PACK_ID, `binding/${sessionId}`);
if (!binding) fail(403, "caller is not a bound PR-walkthrough reviewer");
const already = await getPackStore().get(PRW_PACK_ID, `submitted/${binding.jobId}`);
if (already || TERMINAL.includes(binding.status))
  fail(409, "this walkthrough already accepted a submission");      // idempotency (no duplicate submits)
// validate the YAML shape only (full synthesis stays in the pack publish route):
const validation = validatePrWalkthroughYaml(yaml);
if (!validation.ok) { /* return structured schema error; persist nothing */ }
await getPackStore().put(PRW_PACK_ID, `submitted/${binding.jobId}`,
    { yaml, baseSha: binding.baseSha, headSha: binding.headSha, submittedAt: Date.now() });
await getPackStore().put(PRW_PACK_ID, `binding/${sessionId}`, { ...binding, status: "submitted" });
// Finding 3/4: stamp the GENERIC persisted terminal marker on the child session BEFORE dismiss, so a
// restart between here and the dismiss still lets the generic boot-reap remove the reviewer.
await updateSessionMeta(sessionId, { childTerminal: true, terminalAt: Date.now() });
// Finding 5: terminal-synchronous reap — close the orphan window server-side, don't wait for the panel poll.
await orchestrationCore.dismiss(binding.parentSessionId, sessionId);  // also stamps childTerminal (idempotent)
json({ ok: true, status: "submitted", jobId: binding.jobId });
```
The `bundle` server endpoint (`read_pr_walkthrough_bundle`) similarly resolves `jobId`+`target ← binding/${sessionId}`, then lazily resolves the analysis bundle from the target via the EXISTING server pipeline (github-adapter for GitHub PRs, git-changeset → `createAnalysisBundleFromParsedDiff` for local) and caches it in `WalkthroughAnalysisBundleStore` keyed by `jobId` — returning the SAME shape as today. `read_pr_walkthrough_bundle` behavior is byte-unchanged; only the env-jobId resolution becomes binding-driven. Trusted-host/credential logic (`preferencesStore` githubTrustedHosts, `GITHUB_TOKEN`) stays SERVER-SIDE here — which is why bundle resolution cannot move into the confined pack worker.

**Caller-session verification (`verifyCallerSession`).** This is *routing/correctness, not a security boundary* (single-user trust domain — goal spec). The child session has `BOBBIT_SESSION_SECRET` in its env (set by `session-manager` for every session). The tool sends `X-Bobbit-Session-Secret: <BOBBIT_SESSION_SECRET>` and the server validates it via `sessionSecretStore.getOrCreateSecret(sessionId)`. This proves the caller IS `sessionId` (the child can't forge another session's id), so the YAML routes to the job bound to that session. **The session-secret check is REQUIRED for the new binding-routed `submit-yaml`/`bundle` paths — it does NOT degrade to a weaker check.** Every reviewer child always has `BOBBIT_SESSION_SECRET` in its env (set by `session-manager` for every session), so requiring it never locks out a legitimate reviewer; a request that lacks/mismatches the secret is rejected (403). The existing `sandboxScope.sessionIds` check (`routes.ts:170-176,205-211`) remains as an ADDITIONAL floor (not a fallback). The submit tool already runs under that env; this is a 1-line header add in `extension.ts` + a verification helper in `routes.ts`.

**Why this is right-job routing + idempotent:** the YAML lands on exactly `binding[sessionId].jobId`; a second submit (or a submit to an already-`ready`/`error` job) is rejected by the status check; cross-job submission is impossible because the child can only resolve its OWN binding (keyed by its verified session id).

### Decision D — where polling lives and how completion is detected

- **Polling lives in the panel → `status` pack route → `host.agents.status` + pack-store read.** The panel never touches `host.agents` (that's the server host); it only calls pack routes via `host.callRoute`.
- **The `status` route is binding-authoritative (right-job routing).** It loads `binding/${childSessionId}` FIRST and verifies `binding.jobId === jobId` AND `binding.parentSessionId === ctx.sessionId` (the bound owner). On a missing or mismatched binding it returns a structured error (`phase:"error"`, `error:"unknown or mismatched binding"`) and reads nothing else — it does **not** read `submitted/${jobId}` for an unverified jobId. ONLY after the binding verifies does it read `submitted/${binding.jobId}`. This prevents a caller from probing an arbitrary `jobId`'s submitted marker and keeps the submitted-YAML read keyed to the verified bound job.
- **Completion signal = the submitted-YAML marker in the pack store** (`submittedKey(jobId)`), NOT the agent's idle status. Rationale: a read-only reviewer can go idle for reasons other than submission; the authoritative "done" signal is the YAML the submit endpoint persisted. The `status` route returns `phase:"submitted"` only when `submittedKey(jobId)` exists.
- **Dismissal is server-driven, not poll-driven — on the happy path.** On submit, the reviewer is dismissed server-synchronously by the submit endpoint (Decision E / §3.2), so the `status` route's dismiss on observing `phase:"submitted"` is only a redundant safety net for the rare case where the submit-side dismiss didn't run (e.g. restart between submit and dismiss — covered by the generic terminal boot-reap, Decision E). On the **error** path (reviewer terminated WITHOUT submitting) there is no submit endpoint to drive cleanup, so the `status` route's dismiss IS the primary cleanup driver (it also stamps the generic `childTerminal` marker so a pre-poll restart is still covered — next bullet).
- **Error detection + persisted error cleanup.** `phase:"error"` when `host.agents.status(childSessionId) === "terminated"` AND no `submitted/${binding.jobId}`. The error path is NOT poll-only/best-effort: it marks `binding.status = "error"` in the pack store AND, by calling `host.agents.dismiss(childSessionId)`, stamps the generic persisted `childTerminal` session marker server-side (Finding 3 / Decision E). So even if the gateway restarts before the next poll, the reviewer is reaped by the generic terminal boot-reap rather than leaking as a `running` orphan. A timeout in the panel loop (reuse `RUN_TIMEOUT_MS`) surfaces "the reviewer didn't produce a walkthrough — try again."
- **The read→publish→render seam is kept verbatim:** the panel's existing `publishAndLoad(yamlText)` (`src/panel.js:200-240`) is reused; the only change is that `yamlText` comes from the `status` route response rather than `host.session.readToolCall`.

**Panel state machine** (`byJob` statuses): replace `posting | waiting` with `running` (after `run` returns) and `submitted` (transient, drives `publishAndLoad`); keep `idle | loading | publishing | rendered | error`. `onRun()` becomes:
```js
const onRun = async () => {
  if (!host || busy) return;
  byJob.set(key, { status: "running" }); host.requestRender?.();
  let started;
  try { started = await host.callRoute("run", { method:"POST", body: runBody }); }
  catch (e) { byJob.set(key, { status:"error", error: runErrorMessage(e) }); host.requestRender?.(); return; }
  const { childSessionId, jobId, baseSha, headSha } = started;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (byJob.get(key)?.status !== "running") return;           // user acted
    const st = await host.callRoute("status", { method:"POST", body:{ childSessionId, jobId } });
    if (st.phase === "submitted") {
      byJob.set(key, { status:"publishing" }); host.requestRender?.();
      await publishAndLoad({ input: { yaml: st.yaml } }, st.baseSha ?? baseSha, st.headSha ?? headSha);
      return;
    }
    if (st.phase === "error") { byJob.set(key, { status:"error", error: st.error ?? "Reviewer failed." }); host.requestRender?.(); return; }
    await sleep(POLL_INTERVAL_MS);
  }
  byJob.set(key, { status:"error", error:"The reviewer didn't produce a walkthrough — try again." }); host.requestRender?.();
};
```
`runBody` carries the changeset selector the panel already has (`baseSha`/`headSha` from params, or `prUrl`); no auto-invoke on mount (unchanged §5 v). Note `onRun` may now be `async` (the launch is a route call, not a gesture-gated `postMessage`, so the synchronous-user-activation constraint that forced the old await-free `postMessage` no longer applies).

### Decision E — job lifecycle + idempotency without the legacy store

- **Canonical target / changeset id.** Reuse `changesetIdForGithub(owner, repo, number, headSha)` from `src/shared/pr-walkthrough/ids.ts` (already imported by `src/panel.js:30` and re-exported by the pack's `yaml-to-cards.mjs`). The `canonicalKey` (idempotency key) is the `github:owner/repo#number` shape from `canonicalizeTarget` (`walkthrough-agent-manager.ts:780-820`) — port that pure helper into `lib/routes.mjs` (or `src/shared/pr-walkthrough/ids.ts`) so the worker can compute it without server imports.
- **Idempotency (one reviewer per parent+target) — deterministic for the bound-but-not-started case.** The `run` route reads `reviewerKey(parentSessionId, canonicalKey)`. If it resolves a child whose `host.agents.status` is **not** `terminated` (LIVE), it loads that child's `binding/${childSessionId}` and branches: if `binding.kickedOff === false` (spawned + bound, but the kickoff `host.agents.prompt` never landed — e.g. a prior `run` crashed between binding-write and kickoff) it **re-issues `host.agents.prompt(childSessionId, kickoffPrompt)`** (deterministic kickoff retry) and flips `kickedOff:true`, THEN returns that child — it never returns a never-started child that would make the panel poll `running` forever. If the resolved child is **terminated**, the reviewer index is stale: the route deletes `reviewerKey(…)` and launches fresh. This replaces `findByParentAndTarget` + `launchKey` dedupe. The parent session id is the bound owner session id (`ctx.sessionId`, available to the route handler as the spawn owner — the worker's `host.agents` is owner-bound).
- **Concurrency dedupe (one reviewer under near-simultaneous launches).** The `reviewerKey` check alone is insufficient if two `run` calls for the same `${parent}\0${canonicalKey}` interleave before either writes the index — both would observe no `reviewerKey` and both spawn. The `run` route therefore keeps a MODULE-SCOPED in-flight launch map keyed by that launchKey — the direct analogue of the deleted `launchInFlight`/`launchKey` mutex (`walkthrough-agent-manager.ts`): a second concurrent call awaits the first's promise and returns its result (created:false), and the entry is cleared in a `finally`. The routes module is a worker singleton, so the map persists across `host.callRoute("run")` invocations (§3.2 step 1b). Combined with the persisted `reviewerKey` check (which dedupes across restarts / separate worker generations) this guarantees exactly one reviewer per parent+target under both concurrent and sequential launches.
- **Atomic launch sequence (race-free binding + failure-atomic post-spawn).** `run` spawns with `deferInitialPrompt:true` (child created + visible but NOT started), writes `binding/${childSessionId}` (`kickedOff:false`) + `reviewer/…`, THEN calls `host.agents.prompt(childSessionId, kickoffPrompt)`, THEN flips `binding.kickedOff:true` only AFTER the prompt succeeds. All of these post-spawn steps run inside ONE try/catch: on ANY post-spawn failure (binding write, reviewer-index write, or the kickoff prompt) the route best-effort COMPENSATES — `host.agents.dismiss(childSessionId)`, then delete `binding/${childSessionId}` and `reviewer/${parent}/${b64(canonicalKey)}` — and returns `{ ok:false, retryable:true, error, code }`, so a retry starts clean (no orphaned visible child, no stale reviewer index). Because the binding exists before the reviewer's first tool call, the reviewer's initial `read_pr_walkthrough_bundle`/`submit_pr_walkthrough_yaml` can never 403 on a missing binding (Decision A.5, §3.2).
- **Retry on transient launch failure.** If `host.agents.spawn` throws (including `OrchestrationCoreError("…","ROLE_TOOLS_UNRESOLVED")` when the role's tool grants can't be resolved — Decision A.2), the `run` route returns a structured `{ ok:false, retryable:true, error, code }` with no binding written; the panel surfaces a retry. If the spawn SUCCEEDS but a post-spawn step fails, the compensation above guarantees the same clean slate (dismissed child, no binding, no reviewer index), so the retry re-spawns from scratch. A retry that instead finds a LIVE bound-but-not-started child (`kickedOff:false`, e.g. the process died after the kickoff but before the success was observed) re-issues the kickoff deterministically (idempotency bullet above) rather than spawning a duplicate.
  - **Retry granularity (auto + manual).** The criterion is satisfied at two levels. (1) IN-ROUTE bounded auto-retry: the `run` route wraps `host.agents.spawn` in a small bounded retry (≤2 attempts, short backoff) for clearly-transient errors (e.g. a momentary core/session-manager unavailability), so a blip does not surface to the user at all; non-transient codes like `ROLE_TOOLS_UNRESOLVED` are NOT retried (they would fail identically) and return immediately. (2) OUTER manual/affordance retry: any returned `{retryable:true}` renders a "Run again" affordance in the panel, and because `run` is idempotent (concurrency guard + `reviewerKey` + `kickedOff` re-kickoff) re-invoking it is always safe — it returns the existing reviewer or launches one cleanly, never a duplicate. The acceptance criterion "transient launch failure retries" is met by (1); (2) is the user-visible fallback for persistent/just-surfaced failures.
- **Dismissal on terminal (server-synchronous).** The submit-yaml endpoint, after persisting the YAML + marking the binding `submitted`, calls `orchestrationCore.dismiss(binding.parentSessionId, sessionId)` (thread `orchestrationCore` into the submit handler). This closes the orphan window in the happy path WITHOUT waiting for a panel poll. The `status` route's `host.agents.dismiss(childSessionId)` on `phase:"submitted"` is then a **redundant safety net** (idempotent, own-child scope); on `phase:"error"` (no submit endpoint ran) it is the **primary** cleanup driver and also stamps the generic `childTerminal` marker (Decision D / Finding 4).
- **Boot-reap of terminal reviewers (generic, pack-agnostic).** If the gateway restarts after a job becomes terminal but before any dismiss while the parent is still alive, the owner-gone boot reap would NOT remove the terminal reviewer. The reap boundary stays **fully generic — `OrchestrationCore` never reads pack-store keys or knows about PR-walkthrough.** Instead, the completing server-side code writes a GENERIC persisted terminal marker on the CHILD SESSION metadata:
  - **New generic persisted session field `childTerminal: boolean` (+ `terminalAt: number`)**, threaded exactly like the existing persisted `readOnly`/`childKind` session fields (via `updateSessionMeta` for live sessions and `updateArchivedMeta` for archived ones), and surfaced on the existing `PersistedSessionLike` view.
  - **Where it is set (server-side only):** the `submit-yaml` endpoint stamps `childTerminal:true` on the reviewer child BEFORE it dismisses (so the marker survives even if the dismiss never runs), and `orchestrationCore.dismiss`/`host.agents.dismiss` of a `childKind:"host-agents"` child also stamps it — which is how the worker `status` error path (Finding 4), which calls `host.agents.dismiss`, gets the marker without the confined worker touching session metadata directly. No pack code writes session metadata.
  - **How the reap uses it:** `OrchestrationCore.shouldReapChildOnBoot` populates `ReapInput.kindTerminal` purely from this generic persisted `childTerminal` field (read through `PersistedSessionLike`). It is the "small generic rule" the spec's Delete section anticipated, with ZERO pack knowledge in core — NOT a re-introduced `WalkthroughAgentStore`/`pr-walkthrough` bespoke branch, and NOT core consulting pack-store binding keys.
- **Restart-safety floor: a terminated child is never a live reviewer.** Independently of the marker, a `childKind:"host-agents"` reviewer whose underlying child is already `terminated` at boot is reapable regardless of its binding (the binding may still read `running` if a dismiss raced a crash). `shouldReapChildOnBoot` treats a terminated `host-agents` child with a gone-or-irrelevant live counterpart as reapable. This covers the error/termination case (Finding 4) even before the `childTerminal` marker is observed.
- **Model inheritance** is native to `OrchestrationCore.spawn` (`orchestration-core.ts:303` `opts.model ?? resolveSessionModel(owner)`) — the reviewer inherits the owner's current model automatically. No per-call model needed.

### Decision F — deletion order (master stays green)

Phased so the new path lands + is proven before the legacy path is removed. Partitioned by file boundary for parallel coders (see §5).

**Phase 1 — introduce the new path (legacy still present, both compile):**
1. `OrchestrationCore` amendments (Decision A) + `server.ts` `resolveRoleAllowedTools` wiring. Add the generic persisted `childTerminal`/`terminalAt` session field (threaded like `readOnly`/`childKind` via `updateSessionMeta`/`updateArchivedMeta`, surfaced on `PersistedSessionLike`), have `OrchestrationCore.dismiss` of a `host-agents` child stamp it, and derive `ReapInput.kindTerminal` from it in `shouldReapChildOnBoot` (no pack knowledge in core). Add unit coverage to `orchestration-core.test.ts` / `host-agents-scope.test.ts` (role-sourced tools; explicit-full-under-readOnly; `childTerminal`→`kindTerminal` reap; terminated-child reapable regardless of binding).
2. Ship the `pr-reviewer` role file + `pack.yaml` `contents.roles` + default-deny group policy.
3. Add `run` + `status` to `lib/routes.mjs` + `pack.yaml routes.names`; add the pack-store binding/submitted keys (binding carries the target; **no** launch-bundle key — the bundle is resolved server-side).
4. Rewire `routes.ts` submit-yaml + bundle to resolve `jobId`(+`target`) from the binding and read/write the pack store; `bundle` lazily resolves the analysis bundle from the target into `WalkthroughAnalysisBundleStore` (kept); thread `orchestrationCore` into submit-yaml for the terminal-synchronous dismiss and stamp the generic `childTerminal` marker (Finding 3/4) before dismissing; add `verifyCallerSession`. Keep the legacy manager wiring intact but no longer reached by the new tools (the new tools send no jobId/proof).
5. `extension.ts`: drop env-gate + proof header; send session secret.

**Phase 2 — switch the panel:**
6. Replace `src/panel.js` `onRun`/`RUN_PROMPT`/`postMessage`/`postErrorMessage` with the `run`/`status` flow (Decision D). Run `build:packs`, commit `lib/panel.js`.

**Phase 3 — delete legacy (now unreachable):**
7. Delete `walkthrough-agent-manager.ts` launch path + `server.ts` wiring (`:242,:1595,:1934,:2461-2466`, the `prWalkthroughAgentManager` param). Keep `routes.ts` `bundle`/`submit-yaml`/`resolve`/`export` surfaces; remove the legacy launch endpoint `/api/pr-walkthrough/launch`.
8. Delete `walkthrough-reap.ts` + its references; rely on `OrchestrationCore.shouldReapChildOnBoot`, extended with the GENERIC terminal-marker rule (Decision E): `ReapInput.kindTerminal` is derived purely from the new generic persisted `childTerminal` session field (read through `PersistedSessionLike`) — core reads NO pack-store keys and has NO `pr-walkthrough` knowledge. The `childTerminal` field is set server-side by the `submit-yaml` endpoint (before dismiss) and by `dismiss` of a `host-agents` child; a terminated `host-agents` child is reapable at boot regardless of binding (Decision E restart-safety floor). This is NOT a re-introduced `pr-walkthrough` bespoke branch and NOT core consulting pack-store keys.
9. Delete the submit-proof secret entirely from `walkthrough-agent-store.ts` (`createSubmissionProof`/`hashSubmissionProof`/`verifySubmissionProof`/`rotateSubmissionProofForRestoredJob`/`walkthroughTargetEnvForJob`/`submissionProofHash`/`BOBBIT_WALKTHROUGH_SUBMIT_PROOF`).
10. Remove the `session-manager.ts` `childKind==="pr-walkthrough"` special-cases: boot-reap branch (`:3362-3374`), `restoreWalkthroughSubmitEnv` (`:3491-3499,:3513`), sandbox-worktree skip (`:5620`, the `host-agents` child shares the parent worktree and is read-only, so the existing `!session.delegateOf` guard plus the read-only marker already prevent worktree deletion — verify and drop the `pr-walkthrough` clause). The `walkthroughJobId/walkthroughChangesetId/walkthroughTargetKey` persisted fields become dead — remove the threading (≈20 sites) OR leave the optional fields unused and unwritten (lower-risk: stop writing them in Phase 1, delete the field plumbing in Phase 3).

**Phase 4 — parity + e2e:** the full Run→spawn→submit→publish→cleanup browser E2E, read-only denial, idempotent re-run, restart-orphan reap (§7).

---

## 5. Files changed (grouped for parallel coders)

**Group 1 — OrchestrationCore + server wiring** (`src/server/agent/orchestration-core.ts`, `src/server/server.ts`, `src/server/agent/session-manager.ts` persisted-field threading)
- A1 lifecycle selection; A2 `resolveRoleAllowedTools` dep + role-sourced `childAllowedTools`; production wiring at `server.ts:1175`.
- Generic persisted `childTerminal`/`terminalAt` session field (threaded like `readOnly`/`childKind`; surfaced on `PersistedSessionLike`); `dismiss` of a `host-agents` child stamps it; `shouldReapChildOnBoot` derives `kindTerminal` from it (+ terminated-`host-agents`-child-reapable floor). No pack knowledge in core (Decision E / Findings 3–4).
- Phase 3: remove `WalkthroughAgentManager` import/instantiation/threading; remove `prWalkthroughAgentManager.restore()`.

**Group 2 — pack contributions** (`market-packs/pr-walkthrough/`)
- `roles/pr-reviewer.yaml` (new); `pack.yaml` (`contents.roles`, `routes.names`).
- `lib/routes.mjs`: add `run` (spawn `deferInitialPrompt:true` → write binding → `host.agents.prompt` kickoff) + `status`; port `canonicalizeTarget`/changeset id; pack-store binding keys (binding carries the target; **no** launch-bundle key). (`bundle`/`publish` byte-stable.)
- `src/panel.js` + `lib/panel.js` (rebuilt): Decision D state machine; delete `RUN_PROMPT`/`postMessage`/`postErrorMessage`.

**Group 3 — server PR-walkthrough routes + tools** (`src/server/pr-walkthrough/routes.ts`, `defaults/tools/pr-walkthrough/extension.ts`, group policy seed)
- `routes.ts`: rewire submit-yaml + bundle to the pack store binding; `bundle` lazily resolves the analysis bundle from the binding target into `WalkthroughAnalysisBundleStore` (kept); thread `orchestrationCore` into submit-yaml for the terminal-synchronous dismiss; `verifyCallerSession`; delete `/api/pr-walkthrough/launch`.
- `extension.ts`: drop env-gate + proof header; send session secret.
- default `PR Walkthrough` group policy = deny.

**Group 4 — legacy deletion + session-manager** (`src/server/pr-walkthrough/walkthrough-agent-manager.ts`, `walkthrough-reap.ts`, `walkthrough-agent-store.ts`, `src/server/agent/session-manager.ts`)
- Phase 3 deletions (launcher, reap, proof, special-cases, metadata fields).

Groups 1–3 are independent in Phase 1 (different files). Group 4 is Phase 3 and depends on 1–3 landing. Group 2's panel change (Phase 2) depends on Group 2's routes + Group 3's tools.

---

## 6. `WalkthroughAgentStore` / `WalkthroughAnalysisBundleStore` disposition

- `WalkthroughAgentStore` (the `prw-*` job record fs store) existed to hold the job + proof + bundle metadata for the legacy launcher. With routing moved to the pack store, the new path does **not** need it. Decision: **stop using it on the new path**; the pack-store binding (`binding/`, `reviewer/`, `submitted/`) is the single source of routing truth. Delete `WalkthroughAgentStore` in Phase 3 (its only remaining readers are the legacy manager + the session-manager boot-reap branch, both deleted). Keep `PrWalkthroughTarget`/`PrWalkthroughJobError` *types* if still referenced by `routes.ts` response shapes; otherwise inline minimal types.
- `WalkthroughAnalysisBundleStore` and `github-adapter.ts` are **KEPT** (not deleted). The `/api/internal/pr-walkthrough/bundle` server endpoint resolves the analysis bundle **lazily on first read** from the binding's TARGET (owner/repo/number or baseSha/headSha/prUrl) using the EXISTING server pipeline — `github-adapter` for GitHub PRs, `git-changeset` → `createAnalysisBundleFromParsedDiff` for local changesets — caches it in `WalkthroughAnalysisBundleStore` keyed by `jobId`, and returns the SAME shape `read_pr_walkthrough_bundle` returns today. The reviewer's bundle inputs are therefore **byte-stable** and the toolchain does not change. The `run` route does NOT build a launch bundle in the worker (no `launch-bundle/` store key); the binding carries the target so the server endpoint can resolve it. Trusted-host/credential logic (`preferencesStore` githubTrustedHosts, `GITHUB_TOKEN`) stays server-side in the bundle endpoint — this is why the resolution cannot move into the confined pack worker. **Note:** see §8 #1 (a parity note, not a fidelity risk).

---

## 7. Test plan (acceptance criterion → test)

| Acceptance criterion | Test (new / ported) |
|---|---|
| Run mints a NEW read-only reviewer session; user's agent NOT prompted/modified | **New** API E2E `tests/e2e/pr-walkthrough-host-agents.spec.ts`: call `run` route; assert a new session with `childKind:"host-agents"`, `role:"pr-reviewer"`, `readOnly:true`, `accessory:"review"`; assert the owner transcript has **no** injected user message (the anti-`postMessage` assertion). |
| Reviewer runs toolchain + submits; panel renders SAME cards (byte-stable) | **Ported/kept** `tests/pr-walkthrough-card-synthesis.test.ts`, `tests/pr-walkthrough-diff-parser.test.ts`, `tests/pr-walkthrough-yaml-schema.test.ts` (pure synthesis, unchanged). **Kept** `tests/e2e/pr-walkthrough-api.spec.ts` `bundle`/`publish` parity. **New** browser E2E (below) asserts the rendered cards. |
| Read-only enforced (write/commit/disallowed blocked) | **Kept** `tests/pr-walkthrough-readonly-policy.test.ts` (the policy is unchanged). **New** assertion in the spawn test that the reviewer's `allowedTools === [readonly_bash, read_pr_walkthrough_bundle, submit_pr_walkthrough_yaml]` (no `write`/`edit`/`bash`). |
| Submit routed only via the REQUIRED session-secret + binding (no proof secret) | **New** API E2E: a `submit-yaml`/`bundle` request without (or with a wrong) `X-Bobbit-Session-Secret` is rejected 403 even when `sandboxScope` would admit it (the secret is required, not a degrade — Risk #5). |
| Submit authz without a secret: only `pr-reviewer` can submit; routed to bound job; cross-job/terminal rejected; no proof in tree | **New** unit: `general` role does NOT resolve `submit_pr_walkthrough_yaml` (group default-deny); `pr-reviewer` does. **New** API E2E: submit with a valid bound session → routed to `binding[sessionId].jobId`; submit with an unbound session → 403; second submit (terminal job) → 409. **New** repo-grep test: no `BOBBIT_WALKTHROUGH_SUBMIT_PROOF` / `x-bobbit-walkthrough-submit-proof` / `submissionProof` token anywhere (mirrors existing "no secret" grep tests). |
| Idempotency: same PR twice → one reviewer; transient failure retries | **New** API E2E: (sequential) two `run` calls for the same `canonicalKey` return the same `childSessionId` (created:false on the 2nd); (concurrent) two near-simultaneous `run` calls for the same `${parent}\0${canonicalKey}` yield exactly ONE spawned reviewer (the in-flight launch-map mutex serializes them — Decision E concurrency dedupe); a spawn failure returns `retryable:true` and writes no binding; a transient spawn error is auto-retried in-route (≤2 attempts) and does not surface when it then succeeds. |
| Post-spawn launch is failure-atomic; bound-but-not-started child gets a deterministic kickoff retry | **New** API E2E: force the kickoff `host.agents.prompt` to fail after spawn+binding-write → assert the route COMPENSATES (no visible orphan child, no `binding/` key, no `reviewer/` key) and returns `{retryable:true}`; a clean retry then succeeds. **New** API E2E: with a LIVE bound child whose `binding.kickedOff === false`, a `run` call re-issues `host.agents.prompt` (asserts the kickoff fired) and returns that child rather than a never-started one; a `run` whose reviewer index points at a TERMINATED child clears the stale index and launches fresh. |
| Status route is binding-authoritative (right-job routing) | **New** API E2E: `status` with a `jobId` that does not match `binding.jobId` (or a `childSessionId` not owned by the caller) returns a structured `phase:"error"` and does NOT read/return the probed job's `submitted/` marker; a matching binding returns `phase:"submitted"`/`running` as expected. |
| Cleanup: archive/terminate owner cascade-reaps reviewer; terminal job dismisses; no orphan after restart | **Kept/extended** the generalized cascade + `shouldReapChildOnBoot` coverage (`orchestration-core.test.ts` / session-manager restart tests): a `childKind:"host-agents"` reviewer is cascade-reaped on owner archive and reaped on boot when owner is gone. **New** assertion that submit-yaml server-dismisses (and `status` dismiss is a redundant safety net). |
| No spawn/binding race: immediate `read_pr_walkthrough_bundle` after spawn resolves the binding (no 403) | **New** API E2E: drive a `read_pr_walkthrough_bundle` immediately after `run` returns (before any poll); assert it resolves `binding/${sessionId}` and returns the bundle. The deferred-prompt launch (binding written BEFORE `host.agents.prompt`) guarantees no 403 race. |
| No orphan reviewer after restart for TERMINAL jobs (parent still alive) | **New** restart test: reviewer submits → binding `submitted` → simulate gateway restart with the parent still alive → assert NO orphan reviewer remains (server-synchronous `orchestrationCore.dismiss` on submit + the generic `childTerminal` marker stamped before dismiss → boot-reap, Decision E). |
| No orphan reviewer after restart when the reviewer ERRORS/terminates (parent still alive) | **New** restart test: reviewer terminates without submitting → a `status` poll observes `terminated` and marks `binding.status:"error"` + stamps the generic `childTerminal` marker via `host.agents.dismiss` → simulate gateway restart with the parent still alive → assert NO orphan reviewer remains (persisted error terminal marker + generic boot-reap, plus the terminated-child reapable floor, Decision E / Finding 4). |
| Scope: pack drives only its own reviewer child | **Kept** `tests/host-agents-scope.test.ts` (source-filtered owner scope) — extend with a `pr-reviewer` child to confirm a sibling delegate/team child is invisible. |
| `npm run check` + unit + e2e green; full browser E2E | **New/ported** `tests/e2e/ui/pr-walkthrough-pack.spec.ts` (replace the postMessage flow): Run → reviewer child appears in sidebar → submits → panel publishes the same cards → reviewer cleaned up; read-only denial; idempotent re-run. Use the e2e mock agent (canned, non-flaky → e2e phase, never test:manual), as `tests/e2e/host-agents.spec.ts` does. |

Notes:
- `tests/pr-walkthrough-agent-manager.test.ts` covers the **deleted** launcher — remove it (its idempotency/proof assertions are superseded by the new binding tests above) or repoint the idempotency assertions at the `run` route.
- The `walkthrough-readonly-policy` negative tests are NON-NEGOTIABLE and must stay green unchanged.

---

## 8. Risks

1. **Bundle endpoint must preserve `WalkthroughAnalysisBundleStore` semantics (note, not a fidelity risk).** The analysis bundle is resolved server-side from the binding target via the unchanged `github-adapter`/`git-changeset` pipeline and cached in `WalkthroughAnalysisBundleStore` keyed by `jobId`, so `read_pr_walkthrough_bundle` returns the same shape as today — the reviewer's inputs are byte-stable and the toolchain is unchanged. The only requirement is that the `bundle` endpoint preserve the existing store semantics (lazy resolve + cache keyed by `jobId`); pinned by the kept `bundle` parity test (`tests/e2e/pr-walkthrough-api.spec.ts`).
2. **packId constant in `routes.ts`.** The submit/bundle server routes hardcode `PRW_PACK_ID = "pr-walkthrough"` to reach the pack-scoped store. If the builtin pack's server-derived id ever differs from its directory name, the lookup breaks. *Mitigation:* assert the id via the same `resolvePackIdentityForTool`/`pack-identity` path the route dispatcher uses; pin with a test.
3. **Group default-deny blast radius.** Setting `PR Walkthrough: deny` as a default group policy could hide the tools from any existing flow that relied on env-gated registration. *Mitigation:* the only consumer is the reviewer (granted via role); add the unit test that `general` lacks submit and that `pr-reviewer` has all three.
4. **Accessory/visibility assumption.** Decision A relies on `createSession` applying `role.accessory` and rendering a `parentSessionId`+`childKind` child in the sidebar. *Mitigation:* verify in implementation against the team `reviewer` role (which shows `review`); if `accessory` is not auto-applied, thread it in `session-setup` (small, localized).
5. **Session-secret verification plumbing.** `verifyCallerSession` adds a header + a `sessionSecretStore` lookup to `routes.ts`. It is the authoritative right-job routing proof and is **REQUIRED** for the new binding-routed `submit-yaml`/`bundle` paths — a missing/mismatched secret hard-fails (403), it does NOT degrade to a weaker check. This is safe because every reviewer child always carries `BOBBIT_SESSION_SECRET` (set for every session), so the requirement never locks out a legitimate reviewer. *Mitigation:* the `sandboxScope.sessionIds` check stays as an ADDITIONAL floor (defence in depth), not a fallback; pin with an API E2E that a request without the correct secret is rejected even when `sandboxScope` would otherwise admit it.
6. **Build artifact drift.** `lib/panel.js` must be regenerated from `src/panel.js` via `build:packs` and committed; forgetting it ships the old postMessage panel. *Mitigation:* CI runs `build:packs` in `build`; add a check that `lib/panel.js` is in sync (or document the commit step in the PR checklist).
