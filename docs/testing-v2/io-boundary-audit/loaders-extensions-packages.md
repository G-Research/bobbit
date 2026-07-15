# Loader, extension, package, and tool I/O boundary audit

## Baseline and proof rule

This re-audit is pinned to merge base `4df9a35e2bd1ac5b662382189e12973fc4e1c4c2`. Every file and assertion cited as proof below was checked with `git show`/`git cat-file` at that commit. Working-tree, branch-head, and other post-merge-base tests are not evidence.

Only tests selected by the merge-base `test:e2e:v2` runner qualify:

- Group A real-fidelity Node tests selected from the merge-base `daily` bucket.
- Group B `tests/e2e/**/*.spec.ts` files selected as `daily`/`relocate`.
- Group C the physical `tests2/browser/e2e/**/*.spec.ts` adapter files.
- Group I the twelve files in the merge-base `scripts/testing-v2/integration-e2e-files.mjs` list.

The following do **not** qualify:

- `tests2/browser/journeys/**/*.spec.ts`; they run in the tier-2 browser project, not the E2E project.
- Unit-scope `tests2/integration/**/*.test.ts` files outside Group I, even when their names or comments say E2E.
- Legacy `tests/e2e` files not selected in the merge-base `daily` bucket.
- `tests/manual-integration` files.
- Any test or assertion added after the merge base.

Status meanings:

- **MB-COVERED** — merge-base E2E crosses the same boundary and has materially equivalent assertions for the whole seam.
- **PARTIAL** — merge-base E2E proves only a representative path or adjacent result. It does not authorize wholesale unit mocking.
- **GAP** — no merge-base E2E has assertion-level equivalence for the boundary.

“Boundary-independent” means an assertion can consume an injected value/typed result and still prove the same contract. Assertions whose subject is actual import/bundle evaluation, process execution, sandbox escape rejection, package contents or installation, executable discovery/staging, or provider/extension process behavior are boundary-dependent. They remain real unless materially equivalent merge-base E2E exists.

## Verified merge-base E2E evidence

| Merge-base file | Runner membership and material assertions |
|---|---|
| `tests2/browser/e2e/terminal-pack.spec.ts` | Group C file exists. The smoke test asserts `terminal.panel` and “Open Terminal” contributions, opens the shipped panel, runs real shell `echo`, observes output, resize frames, reload attach, exit, kill, restart, and cleanup. This is exact for the terminal happy path, not for arbitrary bundles, custom directories, or `fd`/`rg`. |
| `tests2/browser/e2e/pr-walkthrough-pack.spec.ts` | Group C file exists. It asserts built-in panel/routes/entrypoints, calls the real `bundle` route, rejects caller `repoDir` exfiltration by asserting the outside marker/file are absent and status is not 200, toggles concrete tools/entrypoints with reload persistence, and asserts built-ins cannot be removed. It does not install or rewrite a module. |
| `tests2/browser/e2e/pr-walkthrough-default-off.spec.ts` | Group C file exists. It asserts default-off absence, master-toggle enablement of panel/`bundle`/`publish`/launcher/tools, reload persistence, and disablement. It is activation proof, not package installation or provider dispatch proof. |
| `tests/e2e/marketplace-mcp.spec.ts` | Group B `daily`/`relocate` file exists. It adds a loopback MCP-gateway source, browses virtual packs, installs one, asserts manifest/runtime catalogue and activation, uninstalls it, and separately installs a local authored stdio MCP pack then updates it to a non-MCP pack and asserts runtime/tool disconnection. It does not prove git clone/fetch, generic copied file contents, `.pack-meta.yaml`/order fidelity, or generated Pi proxy execution. |
| `tests/e2e/mcp-integration.spec.ts` | Group B `daily`/`relocate` file exists. It launches the real stdio mock MCP subprocess, asserts connected status/tool discovery, calls `echo` and `add` through `/api/internal/mcp-call`, and asserts errors/tool metadata. It does not load the generated MCP meta-extension in Pi. |
| `tests/e2e/mcp-tool-permission.spec.ts` | Group B `daily`/`relocate` file exists. It uses the real stdio MCP server and proves permission/catalogue flows. Its agent is the harness mock agent; it is not proof that a real Pi process loaded a generated proxy extension. |
| `tests2/integration/team-dismiss-structured-regression.test.ts` | Group I file exists. The merge-base test registers a scoped sandbox token/session secret and asserts same-goal non-lead dismissal is 403 while lead dismissal succeeds. It does not inspect child/container environment or mounts. |
| `tests2/integration/team-delegate.test.ts` | Group I file exists. It asserts delegate lifecycle and model inheritance/override using the in-process mock bridge. It does not prove real provider or extension-process environment behavior. |
| `tests2/integration/sidebar-actions-fork-github-link.test.ts` | Group I file exists. It uses real local `git` for worktrees and branch/link behavior. It never invokes the bundled-binary resolver or asserts `fd`/`rg` discovery/staging. |

`tests2/browser/journeys/pi-runtime-upgrade.journey.spec.ts` and `tests2/browser/journeys/marketplace-packs.journey.spec.ts` also exist at the merge base, but are deliberately excluded: they are tier-2 browser journeys. Their model/provider-key and marketplace-tab assertions cannot upgrade any seam below.

## Verdict summary

| # | Seam | MB status | Are the baseline unit assertions boundary-independent? |
|---:|---|---|---|
| 1 | Browser imports, package exports, production UI bundles | PARTIAL | No (mixed) |
| 2 | Server prebundle/cache | GAP | N/A — absent at merge base |
| 3 | Generated TypeScript extensions | GAP | No (mixed) |
| 4 | Extension Host action/route module loading | PARTIAL | No (mixed) |
| 5 | Extension containment and channel/PTY isolation | PARTIAL | No (mixed) |
| 6 | Pack manifest/contribution discovery | PARTIAL | No (mixed) |
| 7 | Pi-extension resolution/probe/remap | GAP | No (mixed) |
| 8 | Tool/config-directory/skill discovery | PARTIAL | No (mixed) |
| 9 | MCP loading/discovery/subprocess/proxy | PARTIAL | No (mixed) |
| 10 | Marketplace source/install lifecycle | PARTIAL | No (mixed) |
| 11 | npm contents/healing/runtime resolution | GAP | No (mixed) |
| 12 | Executable discovery/staging | PARTIAL | No (mixed) |
| 13 | Bobbit project-state archive | GAP | No (mixed) |
| 14 | Agent-directory validation/migration | GAP | No (mixed) |
| 15 | Credential bootstrap and process/container propagation | PARTIAL | No (mixed) |
| 16 | Provider-key storage/routing/env injection | GAP | No (mixed) |
| 17 | OAuth and Google Code Assist I/O | GAP | No (mixed) |
| 18 | AI Gateway discovery/models/headers | GAP | No (mixed) |
| 19 | Provider lifecycle hooks/modules | GAP | No (mixed) |
| 20 | Built-in tool-extension HTTP/file boundaries | GAP | No (mixed) |
| 21 | OS credential store | GAP | N/A — not implemented |

No broad seam in this document is wholly **MB-COVERED**. Narrow happy paths are covered inside several PARTIAL seams, but their unproved assertion groups must remain real.

## Detailed seam audit

### 1. Browser dynamic imports, package exports, and production UI bundles

**Baseline unit owners:** `pi-ai-browser-boundary`, `clean-build-warnings-regression`, `bundle-size`, and `artifacts-pack-viewer`.

**MB status: PARTIAL.** `tests2/browser/e2e/terminal-pack.spec.ts` loads and operates one shipped production panel bundle. No qualifying merge-base E2E invokes the lazy `streamSimplePiAi` API/provider imports, resolves the full allowed Pi export matrix, asserts emitted chunk names/loading, or checks bundle size. The tier-2 `pi-runtime-upgrade` journey is not E2E evidence.

**Boundary-independent unit assertions: No (mixed).** Import-policy/source-scan assertions are boundary-independent architecture checks. Actual package resolution, production build/chunk loading, bundle evaluation, and built-asset size assertions are boundary-dependent. The `artifacts-pack-viewer` substitution of node-safe source helpers is not equivalent to evaluating the served bundle. Keep actual bundle/import assertions real until exact E2E exists.

### 2. Content-addressed server prebundle and transpilation cache

**Baseline unit owners:** none. `tests2/core/server-prebundle-cache.test.ts`, `tests2/integration/server-prebundle-runtime.test.ts`, and `scripts/testing-v2/server-prebundle.mjs` do not exist at the merge base.

**MB status: GAP.** Post-merge-base tests cannot establish baseline E2E coverage.

**Boundary-independent unit assertions: N/A at the baseline.** If audited separately, key computation and manifest parsing may be pure, but actual esbuild invocation, atomic publication, corruption repair, and runtime import remain boundary-dependent without pre-existing E2E.

### 3. Generated TypeScript extensions: transpile, write, import, and repair

**Baseline unit owners:** the generated Google/provider bridge, tool guard/error bridge, MCP meta/proxy, tool activation, image, output-containment, and session-extension argument tests.

**MB status: GAP.** No qualifying merge-base E2E spawns real Pi and proves that generated provider/guard/MCP/image/error source is written, repaired, transpiled, imported, registered, and executed. Direct REST E2Es and mock-agent journeys are not equivalent.

**Boundary-independent unit assertions: No (mixed).** Source-string/schema generation, option selection, handler mapping, and cache-key calculations can use injected inputs. Assertions that transpile/write/import the generated file, detect tampering, register with Pi, or perform the generated extension’s HTTP/file behavior are boundary-dependent and must remain real.

### 4. Extension Host action/route module loading and invalidation

**Baseline unit owners:** action dispatcher, route dispatcher, module isolation, isolation config, lifecycle hub, and server Host API tests.

**MB status: PARTIAL.** The PR Walkthrough E2E resolves and executes real built-in routes, including Host API/git/filesystem work; the terminal E2E resolves and operates a real channel-backed panel. No qualifying E2E installs or rewrites a module and asserts invalidation, nor proves timeout, OOM, top-level-await, crash recovery, provider shadowing, or default-export variants.

**Boundary-independent unit assertions: No (mixed).** Route selection, authorization decisions, message mapping, limits, and invalidation epoch bookkeeping can be tested against an injected module host. Actual worker startup, file-URL import, rewrite/fresh-import behavior, timeout termination, crash/OOM handling, and Host API message crossing are boundary-dependent. Retain real module/worker canaries; PARTIAL proof does not cover the failure matrix.

### 5. Extension import containment, ambient authority, and channel/PTY isolation

**Baseline unit owners:** module/path/isolation tests plus channel substrate/grant/permit, terminal, and WebSocket attach/open tests.

**MB status: PARTIAL.** PR Walkthrough proves caller-controlled `repoDir` cannot expose another repository. Terminal proves the live PTY/channel happy path, resize, attach, exit, kill, and restart. No qualifying E2E attempts module-graph `file:`/symlink escapes, hostile top-level code, CPU/heap exhaustion, secret-environment access, or oversized frames.

**Boundary-independent unit assertions: No (mixed).** Token/permit state machines, quotas, attach ordering, and audit events are independent with injected channels/clocks. Actual loader realpath/symlink rejection, worker resource enforcement, forbidden import behavior, and platform PTY behavior are boundary-dependent. In particular, sandbox-escape rejection assertions remain real without equivalent E2E.

### 6. Pack manifest and contribution discovery

**Baseline unit owners:** pack/tool contributions, provider loader, panels endpoint, built-ins, marketplace resolver, default-disabled, market-tool runtime/activation, activation catalogue, and unit-scope marketplace provider activation.

**MB status: PARTIAL.** Terminal and PR Walkthrough E2Es prove built-in contribution discovery and activation, including default-off/reload and per-surface toggles. No qualifying E2E installs conflicting/malformed packs, proves precedence/shadowing across bands, or dispatches a schema-v2 provider from an installed pack.

**Boundary-independent unit assertions: No (mixed).** YAML/JSON interpretation, precedence, duplicate handling, activation filtering, and catalogue shaping can consume injected manifest records. Actual directory enumeration, manifest/file reading, realpath containment, installed-pack precedence, and provider module dispatch are boundary-dependent. Retain representative real pack-tree loading until the missing installed-pack E2E lands.

### 7. Pi-extension entry resolution, executable discovery, activation, and sandbox remapping

**Baseline unit owners:** pack Pi-extension loader/discovery/collision/scope/activation, session and tool activation, pack-path remap, Docker args, and sandbox mount tests.

**MB status: GAP.** `tests/e2e/marketplace-pi-extension.spec.ts` exists at the merge base but is not a merge-base `daily` E2E; it was mapped to unit replacement coverage and therefore cannot qualify. No eligible file runs the real probe, exposes the discovered tool, or loads a remapped extension in Docker.

**Boundary-independent unit assertions: No (mixed).** Probe-output parsing, diagnostics, trust gating, cache-key bounds, collision policy, and mount-path planning can use an injected backend. Package `exports`/`module`/`main` resolution against disk, TypeScript/CommonJS bundling, real child-probe execution, tool registration, timeout, filesystem/network/process denial, and symlink/out-of-root rejection are boundary-dependent.

At the merge base, `pi-extension-discovery.test.ts` explicitly executes trusted extension fixtures, bundles TypeScript/CommonJS, and asserts real sandbox rejection. Replacing those assertions with scripted backend results after the merge base does not qualify; the real assertions must remain while this seam is GAP.

### 8. Tool-directory, config-directory, and skill discovery

**Baseline unit owners:** config directories, tool contributions/runtime/activation/policies, tool activation, nested skill scanning/resolution, slash-skill activation, and unit-scope skill integration tests.

**MB status: PARTIAL.** Terminal and PR Walkthrough prove shipped built-in tools/contributions become visible and activation toggles affect runtime surfaces. No qualifying E2E creates a custom `config_directories` entry or proves a custom tool/skill is loaded and invoked by a spawned real agent. The tier-2 marketplace journey is not E2E evidence.

**Boundary-independent unit assertions: No (mixed).** Precedence, disabled-ref filtering, activation policy, CLI argument construction, and parsed skill semantics are independent over injected records. Directory existence/stat/read, nested discovery, and real agent loading are boundary-dependent. Built-in pack evidence is not equivalent to custom-directory discovery.

### 9. MCP contribution loading, discovery, subprocess ownership, and generated proxy tools

**Baseline unit owners:** marketplace MCP contributions/gateway, MCP manager discovery, meta/proxy generation, failure isolation, documentation cache, policy tests, and unit-scope meta-call/tool-cascade tests.

**MB status: PARTIAL.** `tests/e2e/mcp-integration.spec.ts` proves a real stdio MCP subprocess, discovery, tool list, direct internal calls, and errors. `tests/e2e/marketplace-mcp.spec.ts` proves loopback HTTP gateway discovery plus runtime activation/update. `tests/e2e/mcp-tool-permission.spec.ts` proves permission flows against a real MCP server. None loads the generated MCP meta/proxy extension inside real Pi and invokes MCP through that extension; complete subprocess close/restart/error ownership is also not asserted.

**Boundary-independent unit assertions: No (mixed).** Manifest parsing, fingerprints, policy filtering, operation mapping, proxy source generation, and error mapping can use injected transports/catalogues. Actual stdio spawn, HTTP session protocol, `Mcp-Session-Id`, subprocess ownership, generated-file import, and Pi proxy call are boundary-dependent. The baseline E2Es permit mocking duplicated catalogue/route permutations, not removal of every real MCP adapter/proxy assertion.

### 10. Marketplace source sync and install/update/uninstall

**Baseline unit owners:** installer, built-in source, source store/gateway, pack marketplace, MCP gateway, and unit-scope provider/role activation tests.

**MB status: PARTIAL.** `tests/e2e/marketplace-mcp.spec.ts` performs actual source creation, virtual MCP pack install/uninstall, and local authored-pack install/update with runtime assertions. It does not perform git clone/fetch/revision sync, assert the generic copied file set, `.git` exclusion, `.pack-meta.yaml`, `pack_order`, staged atomic replacement/rollback, or restart persistence.

**Boundary-independent unit assertions: No (mixed).** Source classification, copy plans, exclusions, scope/order updates, response mapping, and operation sequencing can be asserted over injected source/installer adapters. Actual clone/fetch, directory copy, package contents, metadata write, atomic replace, install/update/uninstall, and executable-bit/file fidelity are boundary-dependent. Package-install assertions without exact merge-base E2E equivalence remain real.

### 11. npm package contents, dependency repair, and runtime package resolution

**Baseline unit owners:** package files, support packaging, node-modules ring fence, CLI real dependencies, and default-real gateway dependencies.

**MB status: GAP.** No qualifying merge-base E2E installs the packed artifact, boots Bobbit from it, damages dependencies and observes real `npm install` healing, or proves snapshot fallback. No daily E2E asserts `npm pack` contents.

**Boundary-independent unit assertions: No (mixed).** Manifest allowlists, repair-decision logic, resolution-order policy, and error classification can use injected package inventories/executors. `npm pack --dry-run`, exact tarball contents, actual install/healing, and Node package resolution are boundary-dependent. At the merge base `support-packaging.test.ts` runs the real `npm pack --dry-run` assertion; gating or mocking it only after the merge base does not qualify.

### 12. Executable discovery and staging (`fd`, `rg`, Node, git/gh/shell)

**Baseline unit owners:** binary resolver, Node exec-path invariant, local sub-agent push policy, verification runner contract, command fence, and fetch fence.

**MB status: PARTIAL.** Terminal proves a platform shell/PTY can execute `echo`; the Group I sidebar-actions test proves real local `git` worktree behavior. Neither crosses the bundled `fd`/`rg` package resolver/stager. PR Walkthrough’s `NO_PR` behavior is not an assertion about `gh` discovery.

**Boundary-independent unit assertions: No (mixed).** Platform tuple mapping, candidate ordering, fence classification, staging plan, and missing/error mapping can use injected probes. Package resolution, PATH probing, executable permission checks, symlink/copy staging, `command -v`, and Pi use of staged binaries are boundary-dependent. A test that tolerates `bundled | path | missing` also does not establish a deterministic substitute for executable discovery.

### 13. Bobbit project-state archive boundary

**Baseline unit owners:** Bobbit archive and archive allowlist.

**MB status: GAP.** No qualifying merge-base E2E invokes project preflight/archive and asserts moved entries, preservation, manifest, EXDEV fallback, or partial failure. Session/goal record archive tests are a different interaction.

**Boundary-independent unit assertions: No (mixed).** Allowlist classification, archive naming, operation planning, and manifest-data construction can be pure. Real walk/rename/copy/unlink, EXDEV/permission fallback, symlink behavior, and durable on-disk manifest assertions are boundary-dependent. Post-merge-base memfs conversion is not baseline proof; retain a real filesystem archive canary and all unproved adapter semantics.

### 14. Agent-directory resolution, validation, and credential migration

**Baseline unit owners:** Bobbit/agent-dir resolution, validation, migration, container path translation, and unit-scope settings integration.

**MB status: GAP.** No qualifying merge-base E2E changes the agent directory, restarts, and proves credentials/models/sessions/generated extensions/staged binaries use it. The legacy settings-agent-dir browser file is not in the merge-base E2E bucket.

**Boundary-independent unit assertions: No (mixed).** Precedence, allowlist, overwrite policy, and container-path translation can be tested from explicit inputs. Git-root discovery, canonical existing-prefix/symlink checks, destination write probe, migration copy, permissions, and restart activation are boundary-dependent.

### 15. Gateway credential bootstrap and direct/sandbox environment propagation

**Baseline unit owners:** Bobbit tool credentials, gateway env, spawn env, argument redaction, Docker sanitization/args, Codex/Google auth, project sandbox mounts, and unit-scope token/inheritance integrations.

**MB status: PARTIAL.** The Group I team-dismiss test proves scoped token/session-secret route authorization. Team-delegate proves model metadata through a mock bridge. No qualifying E2E inspects a real child/container environment, scoped `auth.json`, token omission, provider variables, or read-only generated-extension mounts.

**Boundary-independent unit assertions: No (mixed).** Credential precedence, allowlisted env mapping, redaction, scoped-auth content planning, and Docker argument/mount planning can use explicit inputs. File mode/content, real process environment, container mounts, admin-token omission, and loaded-extension visibility are boundary-dependent. Route authorization is not equivalent to propagation.

### 16. Provider-key storage, routing, and model-specific env injection

**Baseline unit owners:** OpenRouter bridge, controlled fallback, image registry, Bobbit dispatch, redaction, sandbox auth, and unit-scope provider/model API tests.

**MB status: GAP.** No qualifying merge-base E2E saves/reloads a provider key, performs upstream validation, or spawns a provider-bound real Pi process. The provider-key case in `tests2/browser/journeys/pi-runtime-upgrade.journey.spec.ts` is tier-2 and intercepts both test/save requests; it is neither eligible nor equivalent.

**Boundary-independent unit assertions: No (mixed).** Provider-to-env/header mapping, model selection, request shaping, redaction, and fallback policy are independent with an injected key store/transport. Persistence, permissioned auth-file access, upstream authentication, and real child/provider environment behavior are boundary-dependent.

### 17. OAuth and Google Code Assist provider I/O

**Baseline unit owners:** Google OAuth/callback/completion, Code Assist client/registry/generated provider, and unit-scope OAuth/token API integrations.

**MB status: GAP.** No qualifying merge-base E2E completes OAuth, reloads auth state, refreshes/revokes a token, loads the generated Code Assist provider in real Pi, or streams a Code Assist turn.

**Boundary-independent unit assertions: No (mixed).** PKCE/state generation, callback parsing, credential selection, request/response conversion, timeout mapping, and provider source generation can use injected inputs/transports. Loopback listener lifecycle, token HTTP exchange, chmod-0600 auth persistence, generated provider import, and provider stream behavior are boundary-dependent.

### 18. AI Gateway discovery, models file, and routed headers

**Baseline unit owners:** startup refresh, pricing, headers, context overrides/resolver, offline env, user-agent, and unit-scope AIGW API/config/session/title tests.

**MB status: GAP.** `tests/e2e/aigw-startup-refresh.spec.ts` exists at the merge base but is not a `daily` E2E; it is mapped to unit replacement coverage. No qualifying file configures AIGW, restarts, spawns a routed agent, and asserts real upstream session/User-Agent headers or models-file effects.

**Boundary-independent unit assertions: No (mixed).** Pricing/context conversion, header resolution, config mapping, and error classification can use injected model documents/transports. Discovery HTTP, `models.json` publication/removal, restart behavior, CLI/provider spawn, and real routed headers are boundary-dependent.

### 19. Provider lifecycle hooks and external provider modules

**Baseline unit owners:** provider loader/bridge, respawn bridge, lifecycle hub, Hindsight client/provider, and unit-scope external/provider activation integrations.

**MB status: GAP.** The legacy provider E2Es at the merge base are not selected in the `daily` E2E bucket. PR Walkthrough and terminal exercise routes/channels, not schema-v2 lifecycle provider dispatch. No qualifying test loads an installed provider module and observes `beforePrompt`/`beforeCompact` during a real Pi turn.

**Boundary-independent unit assertions: No (mixed).** Provider resolution, enablement, hook ordering, request shaping, timeout/error mapping, and generated bridge source can use injected lifecycle clients. Dynamic module import in the worker, provider process/worker lifecycle, real Pi hook dispatch, and external HTTP behavior are boundary-dependent.

### 20. Built-in tool-extension HTTP/file boundaries

**Baseline unit owners:** skill/ask/read-session/preview/screenshot/output containment/team-dismiss extensions plus Bobbit tool credentials/dispatch/errors/pagination/validation and unit-scope tool E2Es.

**MB status: GAP.** Qualifying E2Es call routes directly or use the harness mock agent. `mcp-tool-permission` explicitly has the mock agent POST the grant route. No qualifying merge-base journey proves the chain “real Pi process → loaded built-in extension → registered tool → authenticated gateway/file/browser call → asserted side effect.”

**Boundary-independent unit assertions: No (mixed).** Tool schemas, URL/header/body construction, pagination, validation, response/error mapping, and bounded-output policy can use an injected `GatewayClient`/browser/file adapter. Actual extension import/registration, credential lookup, internal HTTP, Playwright launch, screenshot/file write, and containment enforcement are boundary-dependent.

### 21. Keychain/OS credential-store boundary

**Baseline unit owners:** none; the merge-base source has no keychain/keytar/DPAPI/macOS `security`/Linux `secret-tool` implementation.

**MB status: GAP.** There is no implemented boundary or qualifying E2E.

**Boundary-independent unit assertions: N/A.** File-based auth tests cannot be cited as OS credential-store proof.

## Conversion consequence

PARTIAL and GAP rows do not permit wholesale replacement of real unit boundaries. Pure parsing, mapping, planning, and orchestration assertions may move behind injected typed seams, but the merge-base real assertions must remain for:

- actual module/package import and production bundle evaluation;
- Pi-extension transpile/bundle/probe execution and escape rejection;
- Extension Host worker import, invalidation, containment, and resource behavior;
- package contents, installation, update, atomic replacement, and executable fidelity;
- npm packaging/healing and `fd`/`rg` discovery/staging;
- real credential/provider/extension process behavior.

Post-merge-base injected tests can improve unit design, but they cannot retroactively supply baseline E2E equivalence or justify deleting these real canaries.