# Extension sandbox requirements

**Status:** implementation contract
**Baseline inspected:** `abaa642bc`
**Scope:** declarative extension requests for approved sandbox toolchains. This adds no extension process runtime and no image-builder parallel to the Docker build path.

## 1. Current seams

The only sandbox image is Bobbit-owned:

- `src/server/agent/sandbox-status.ts`
  - `resolveSandboxDockerContext()` always finds Bobbit's `docker/Dockerfile`, not a project Dockerfile.
  - `buildSandboxImage(imageName, dockerContextRoot?, commandRunner?)` runs the sole `docker build` command.
  - `ensureImageAgentVersion()` rebuilds the same image when the Pi label is stale.
  - `checkDockerAvailability()` currently reports Docker/image presence only.
- `src/server/server.ts`
  - `sandboxBootstrap` (near `4870`) reads the selected project's `sandbox` and `sandbox_image`, calls the three helpers above, then supplies `ProjectSandboxOptions.image`.
  - `GET /api/sandbox-status` and `POST /api/sandbox-image/build` (near `6615`) read only the selected project's existing config and call the same helpers.
  - `invalidateResolverCaches()` (near `5714`) already runs after marketplace install/update/remove, pack activation, extension-settings mutation, and grant mutation.
- `src/server/agent/sandbox-manager.ts::SandboxManager.ensureForProject()` owns lazy per-project construction; `ProjectSandboxOptions.image` is immutable for the running `ProjectSandbox` in `src/server/agent/project-sandbox.ts`. Its `buildDockerRunArgs()` call consumes that already-resolved image.
- `docker/Dockerfile` contains all executable build instructions and currently accepts only Bobbit-owned `PI_AGENT_VERSION` plus its fixed internal arguments.

Extension eligibility already has the needed authority pattern:

- `pack-manifest.ts::validateManifest()` and `pack-types.ts::PackManifest` validate manifest catalogues and safe basenames.
- `pack-contributions.ts::loadPackContributions()` loads schema-2 declaration files, while `PackContributionRegistry` collapses installed packs to the highest-precedence winner and applies pack activation, extension settings, and config activation.
- `ProjectConfigStore` persists `pack_activation`, `extension_settings`, and exact `extension_grants` atomically. `createExtensionCapabilityGrantResolver()` first proves an active server-resolved pack, then reads a current exact grant; a stored grant cannot revive a removed, disabled, or shadowed pack.

There is **no current sandbox requirement fingerprint**, no rebuild-on-extension-change path, and no requirement status projection.

## 1.5. Equal-scope approach comparison and defect surface

Both options retain the same product scope: only core-approved profiles may alter Bobbit's single Docker build; no extension supplies a Dockerfile, command, package, image, or project-config write.

| Dimension | Option A — chosen dedicated requirement path | Option B — minimal composition through runtimes |
|---|---|---|
| Data and control flow | `contents.sandboxRequirements` → strict inert declaration loader → winning-pack/settings/activation/exact `sandbox:build` grant projection → `SandboxImagePlan` → existing `buildSandboxImage(plan, ...)` → fixed Dockerfile branches. | Extend schema-2 `runtimes/<name>.yaml` with `profiles`, reuse `loadServiceExtensions()` and the runtime settings/activation projection, then use `ProjectConfigStore`'s existing `sandbox_image` as the base image while deriving profiles from active runtimes. |
| Existing seams reused | Reuses `loadPackContributions()`, `PackContributionRegistry`, `ProjectConfigStore`, `sandbox-status.ts`, and the sole Docker context/build runner; it adds only the sandbox-specific authority and plan boundary. | Reuses `src/server/agent/pack-contributions.ts::loadServiceExtensions()`, `src/server/extension-host/pack-contribution-registry.ts` runtime projection, `ExtensionSettingsTargetKind = "runtime"`, `DisabledRefs.runtimes`/`ACTIVATION_KINDS`, and `ProjectConfigStore.sandbox_image`. Existing guard coverage is `tests2/core/pack-contributions.test.ts`, `tests2/core/extension-grant-config-store.test.ts`, and `tests2/core/sandbox-status.test.ts`. |
| Files touched | Adds the schema-3 catalogue and loader, one settings/activation kind, one pack-only grant, the small plan module, and plan-aware existing sandbox seams. | Avoids `pack-types.ts`/`pack-manifest.ts` schema-3 work and the new catalogue/settings/activation/capability enums, but must change the runtime service declaration contract, its loader, registry projection, service lifecycle consumers, and the sandbox seams. |
| Failure modes | A malformed requirement is dropped before settings/grants; missing `sandbox:build` produces no plan; stale/missing matching image is explicitly pending; a failed exact plan is explicitly failed. Process-runtime eligibility is irrelevant. | A runtime enable/disable, invalid runtime service declaration, or runtime execution-grant/lifecycle change can silently add or remove an image profile. A runtime declaration requires a `service` mapping and carries process semantics, so a build-only profile is either artificial runtime data or unexpectedly coupled to an executable runtime. Adding a separate build grant restores the very authority path Option B was meant to avoid. |
| Test seams | New focused plan/authorization tests are required, while `tests2/core/sandbox-status.test.ts` remains the sole Docker-runner fence and integration tests exercise the existing bootstrap path. | Reuses existing runtime fakes and settings tests, but requires new regression coverage proving runtime process lifecycle, execution grants, and profile derivation cannot affect one another — a broader and less local seam. |

Option B is the smallest *apparent* composition, but is unsuitable: runtimes are declarative service/process contributions (`ServiceExtensionContribution`, `service-extension-contract.ts`) whose activation and later execution semantics answer whether a process may run. Sandbox image building is an administrative pack-principal action with a distinct grant lifecycle. Coupling the two makes revoking execution eligibility alter a container image, or forces a parallel `sandbox:build` check inside the runtime path. Either outcome makes status/rebuild behavior less honest and expands runtime semantics. Option A therefore remains the smallest robust design: a single inert contribution kind, one explicit build authority, and one core plan module, all feeding the pre-existing builder.

The resulting new defect surface is deliberately small and each item is load-bearing:

- **Desired-plan cache, keyed by project and resolver generation** — owned by `sandbox-image-requirements.ts`; prevents stale activation/grant results from choosing an image while preserving existing resolver invalidation ownership.
- **Applied plan fingerprint/image on `SandboxManager`'s tracked project sandbox** — necessary because `ProjectSandboxOptions.image` is immutable and the existing ready fast path otherwise cannot detect a desired-image change.
- **`ExtensionCapability`/`EXTENSION_PACK_CAPABILITIES`: `sandbox:build`** — separates permission to build a core image from hook and runtime execution authority.
- **`DisabledRefs` and `ACTIVATION_KINDS`: `sandboxRequirements`** — supplies the existing scoped activation/revoke path without overloading `runtimes`.
- **`ExtensionSettingsTargetKind`: `sandboxRequirement`** — gives an inert declaration its own server-derived settings tuple, rather than making a build profile a runtime setting.
- **Schema-3 `contents.sandboxRequirements` catalogue** — bounds filenames before loading and makes requirement declarations distinguishable from process services.
- **`sandbox-image-requirements.ts`** — is the one core-only conversion boundary from authorized profile IDs to deterministic image names, fingerprints, and build arguments.
- **Docker readiness labels: existing `bobbit.pi-agent-version` plus new `bobbit.sandbox-requirements-fingerprint`** — both are needed to distinguish an agent-version-compatible base image from one built for the exact approved plan.
- **Dockerfile arguments `BOBBIT_SANDBOX_TOOLCHAINS` and `BOBBIT_SANDBOX_REQUIREMENTS_FINGERPRINT`** — are the bounded inputs required to select fixed core branches and stamp the plan; no extension-controlled Docker argument exists.

## 2. Contract: schema 3, declarative and closed

Add schema-3 manifest catalogue key `contents.sandboxRequirements: string[]`; entries are safe basenames and name files in `sandbox-requirements/`.

```yaml
name: code-intel
schema: 3
contents:
  roles: []
  tools: []
  skills: []
  entrypoints: []
  sandboxRequirements: [python-analysis]
```

Each `sandbox-requirements/<listName>.yaml` is an inert declaration:

```yaml
id: python-analysis
profiles: [python]
config:
  enabled: { type: boolean, default: true }
activation:
  requiresConfig: [enabled]
```

Its exact top-level key set is `{ id, profiles, config, activation }`.

- `id` uses the existing bounded hook/contribution identifier grammar and is unique within its winning pack.
- `profiles` is a non-empty, duplicate-free array, maximum 8, of core `SandboxToolchainId` values. Initial core vocabulary is deliberately small: `python`. Adding an identifier requires a core Dockerfile + resolver change and tests; manifests never define profile semantics.
- `config` and `activation` use the existing strict `normalizeExtensionSettingsSchema()` grammar and limits. Missing config is allowed only with no `activation` block. Settings are public primitive controls only; no secret field is permitted for this contribution.
- No other field is tolerated. In particular the declaration has no Dockerfile text, command, path, image/tag, package, registry, repository, URL, environment, mount, shell, or arbitrary build argument field.
- Schema 1/2 packs cannot declare this catalogue. Schema 3 is accepted only after `validateManifest()` has added it to its supported-schema and safe-basename validation; malformed files are dropped before settings, activation, grants, or build planning are consulted.

`PackManifest.contents`, `validateManifest()`, and fixture helpers must add `sandboxRequirements`; do not add a project.yaml field or a proposal-tool parameter. The project continues to own `sandbox` and `sandbox_image`; the extension can only request one of the fixed profiles.

## 3. Resolver and authorization

Introduce `SandboxRequirementContribution` in `src/server/agent/pack-contributions.ts` and load it with a new `loadSandboxRequirements(packRoot, manifest)` invoked by `loadPackContributions()`. Add `sandboxRequirements` to `PackContributions` and `PackContributionResolver.listSandboxRequirements(projectId)`.

`PackContributionRegistry` must process these after winning-pack collapse and before exposing them, with the same fail-closed sequence used for runtimes:

1. installed winning pack only;
2. pack-level extension setting remains enabled;
3. `pack_activation[scope][packName].sandboxRequirements` has not disabled its `listName`;
4. the `sandboxRequirement` project settings target is enabled and satisfies `activation.requiresConfig`;
5. an exact active pack-principal `sandbox:build` grant is present.

Extend the existing closed authority surfaces rather than creating a special grant store:

- Add `"sandbox:build"` to `ExtensionCapability`, `EXTENSION_CAPABILITIES`, `EXTENSION_PACK_CAPABILITIES`, and `server.ts::extensionPackGrantCapabilities`. It is a pack-principal-only capability; it cannot be a hook grant.
- Extend `DisabledRefs`, `ACTIVATION_KINDS`, and Market activation catalogue handling with `sandboxRequirements`.
- Extend `ExtensionSettingsTargetKind`, `ExtensionSettingsTargetRef`, persistent normalization, and `settingsTargets()` / `extensionSettingsRuntimeLookup()` with `"sandboxRequirement"`. The setting key stays the server-derived tuple `packId\0sandboxRequirement\0id`; it never names a Docker target.
- Add `PackContributionRegistry`'s optional final disabled-list lookup for this kind so existing fakes remain source-compatible. Its live server construction beside `marketPackEntriesForProject` reads the same scoped `ProjectConfigStore.getPackActivation()` as the other contribution types.

The resolver must return copies in deterministic pack precedence, then `packId`, requirement `id`, and profile lexical order. It must deduplicate profile IDs. It never consumes a raw manifest object at build time.

## 4. Core-owned image plan and sole build path

Create `src/server/agent/sandbox-image-requirements.ts` as the boundary between extensions and Docker. It owns:

```ts
export type SandboxToolchainId = "python";
export interface SandboxImageRequirement { packId: string; requirementId: string; profiles: readonly SandboxToolchainId[]; }
export interface SandboxImagePlan {
  baseImageName: string;
  imageName: string;
  profiles: readonly SandboxToolchainId[];
  fingerprint: string;
  requirements: readonly SandboxImageRequirement[];
}
export function resolveSandboxImagePlan(input: { baseImageName: string; requirements: readonly SandboxImageRequirement[]; piAgentVersion: string | null }): SandboxImagePlan;
export function sandboxImageBuildArgs(plan: SandboxImagePlan): readonly string[];
```

The module's `SANDBOX_TOOLCHAIN_RECIPES` is the single allowlist. A recipe supplies only a core constant ID and fixed Dockerfile branch; it contains no pack bytes. `resolveSandboxImagePlan()` sorts and de-duplicates IDs, canonicalizes a versioned JSON payload, SHA-256s it, and produces a core-derived image tag such as `<validated configured repository>:bobbit-req-<16 hex>`. A core image-reference parser must validate the configured base image (repository path with an optional tag and/or exact `sha256` digest, including registry ports), normalize it for the fingerprint, and derive the profile image from the validated repository path after stripping its optional tag/digest. An invalid configured base image is `unsupported` and is never passed to Docker. It must preserve the configured `sandbox_image` exactly as the baseline choice, while no declaration can supply a repository or tag. With no profiles, `imageName === baseImageName` for compatible current behavior.

The fingerprint includes the plan format version, normalized base image name, sorted approved IDs, core recipe-set version, and host Pi version. It excludes settings values, secrets, pack paths, manifest text, package names, and all user-controlled free text. The result is deterministic: equivalent active inputs produce byte-identical arguments and image name.

Only `sandbox-status.ts::buildSandboxImage()` changes execution. Its permanent signature is `buildSandboxImage(plan: SandboxImagePlan, dockerContextRoot?, commandRunner?)`; do not retain a string-image overload. It constructs the existing `docker build` call with `sandboxImageBuildArgs(plan)` (`BOBBIT_SANDBOX_TOOLCHAINS` and the core-derived fingerprint only), then the existing core `PI_AGENT_VERSION` argument, `-t plan.imageName`, and the existing Bobbit `docker/` context. Do not introduce `exec`, a generated Dockerfile, `--file`, a second image builder, or any extension-controlled Docker argument.

`docker/Dockerfile` adds core-owned `ARG BOBBIT_SANDBOX_TOOLCHAINS` and `ARG BOBBIT_SANDBOX_REQUIREMENTS_FINGERPRINT`, fixed conditional branches for profiles in the core table (initially Python's fixed Debian packages), and a `bobbit.sandbox-requirements-fingerprint` label. It rejects any other toolchain value. Packages, repositories, and commands remain literal Dockerfile text reviewed with Bobbit; profile IDs are the only variable input.

`ensureImageAgentVersion(plan, ...)` and `checkDockerAvailability(plan, ...)` inspect both the existing Pi label and a new core label `bobbit.sandbox-requirements-fingerprint`. A matching Pi version alone is not ready for a requirement plan.

## 5. Lifecycle, rebuilds, and status

`server.ts` resolves a fresh plan from `packContributionRegistry.listSandboxRequirements(projectId)` plus `extensionCapabilityGrantResolver(projectId, { kind: "pack", packId }, "sandbox:build")` at all three existing image seams:

1. `sandboxBootstrap` resolves it before checking/building and sets `ProjectSandboxOptions.image = plan.imageName`.
2. `GET /api/sandbox-status` resolves it but never builds.
3. `POST /api/sandbox-image/build` ignores any client-supplied requirements and builds that server-resolved plan through `buildSandboxImage(plan, ...)`.

Expand the status wire shape without removing current fields:

```ts
requirements: {
  fingerprint: string;
  profiles: SandboxToolchainId[];
  entries: Array<{ packId: string; requirementId: string; state: "pending" | "available" | "failed" | "unsupported"; code?: string }>;
}
```

- `available`: Docker is available and the resolved tag has both matching labels.
- `pending`: a supported active requirement has no matching image, or its build is currently in progress.
- `failed`: the most recent attempted build for the exact fingerprint failed; retain only a bounded sanitized error code/message, never Docker command text or environment. `sandbox-image-requirements.ts` owns this as a bounded in-memory LRU keyed by project ID and fingerprint (cleared for a project on invalidation and replaced on success); it is deliberately not persisted or shared across projects.
- `unsupported`: Docker sandbox is disabled/unavailable, the core profile recipe is unavailable on the host platform, or the active declaration cannot map to a current supported profile. No build is attempted.

The endpoint may separately expose the existing `configured`, Docker version, and base/image existence fields. It must never claim `available` merely because `sandbox_image` exists when the resolved profile fingerprint does not match.

Cache desired plans by project ID plus resolver generation. Add `sandboxImageRequirements.invalidateProject(projectId)` and call it after all relevant `invalidateResolverCaches()` causes: marketplace install/update/uninstall, pack order/activation change, extension settings mutation, and grant/revoke. A requirement is consequently removed immediately from the desired plan when disabled, revoked, uninstalled, or shadowed. Do not delete old Docker images automatically.

Because `ProjectSandboxOptions.image` is immutable, `SandboxManager.ensureForProject()` must compare the tracked sandbox's applied fingerprint/image to the newly resolved plan before its ready fast path. A changed plan stops/removes only that project's container and recreates it through the normal `ProjectSandbox` path; unchanged plans retain the long-lived container. Failure leaves the old container usable but status is `failed` for the desired plan. The next explicit build or bootstrap retries. This is the required rebuild/removal behavior, not a second lifecycle manager.

## 6. Security and authority invariants

- An installed declaration has no effect without all of winning-pack selection, activation/settings eligibility, and exact `sandbox:build` grant. Revocation wins the next resolution just as existing grants do.
- Only the server resolves pack identity, requirement IDs, profiles, fingerprint, derived image tag, Docker context, and Docker arguments. The HTTP body can select only the already-authorized project.
- A sandboxed token remains unable to read or mutate project config/grants; do not widen `sandbox-guard.ts`.
- Existing project proposal/config authority is unchanged: `propose_project` and `ProjectConfigStore` retain sandbox mode/base image ownership. No extension writes project config and no proposal gains arbitrary toolchain/package/image fields.
- Existing Docker security stays intact: Bobbit context only; no project Dockerfile; current mounts/network/credentials; injected command runner; no extension environment, mounts, build context, shell, registries, packages, paths, or tags.

## 7. Implementation file plan

| File | Change |
|---|---|
| `src/server/agent/pack-types.ts` | Schema-3 catalogue type `contents.sandboxRequirements`. |
| `src/server/agent/pack-manifest.ts` | Supported schema 3 and strict safe-basename validation for the new catalogue. |
| `src/server/agent/pack-contributions.ts` | `SandboxRequirementContribution`, strict loader, `PackContributions` field. |
| `src/server/extension-host/pack-contribution-registry.ts` | Active winning-pack/settings/activation/disabled projection and `listSandboxRequirements()`. |
| `src/server/agent/project-config-store.ts` | Closed capability, disabled ref kind, and settings target-kind persistence. |
| `src/server/agent/extension-settings-schema.ts`, `src/server/agent/extension-settings-store.ts` | Add the new target kind in both settings contracts; retain primitive bounded schema validation and ban secrets at the requirement loader. |
| `src/server/agent/sandbox-image-requirements.ts` | Core allowlist, canonical plan/fingerprint, derived tag, fixed build arguments, status reason helpers. |
| `src/server/agent/sandbox-status.ts` | Plan-aware inspect/build/version checks and requirements status projection; still owns the sole Docker build. |
| `src/server/server.ts` | Resolve plan at bootstrap/status/build routes, wire activation/settings/grants invalidation, and expose honest status. |
| `src/server/agent/sandbox-manager.ts`, `src/server/agent/project-sandbox.ts` | Compare applied plan fingerprint and recreate only an affected project's existing container. |
| `docker/Dockerfile` | Fixed core branches keyed by the core profile enum and fingerprint label. |

## 8. Focused Test Suite v2 coverage

Add new tests; do not dilute existing security pins.

1. `tests2/core/sandbox-extension-requirements.test.ts` (Vitest `core`): malformed/unknown profile declarations; duplicate/bounds; no forbidden key can parse; canonical sorting/deduplication; exact fixed build arguments; profile/tag/package/env injection attempts cannot reach Docker args; fingerprint changes for profile/Pi/base changes only.
2. Extend `tests2/core/pack-contributions.test.ts`: schema-3 catalogue/load validation, winning-pack collapse, disabled list, settings activation, and invalid declaration fail-closed before settings reads.
3. Extend `tests2/core/extension-grant-policy.test.ts` and `extension-grant-config-store.test.ts`: `sandbox:build` is pack-only, exact, active, durable, and revoked/inactive packs are denied.
4. Extend `tests2/core/sandbox-status.test.ts`: injected command runner sees only the existing `docker build` with core arguments; Pi plus requirement label is required; pending/available/failed/unsupported projections are accurate.
5. Add `tests2/integration/sandbox-extension-requirements.test.ts`: selected-project isolation; status/build never trusts request requirements; marketplace/activation/settings/grant/remove invalidates desired state; changed plan recreates only that project sandbox through the existing bootstrap seam. Use fake Docker runners, not Docker.
6. Add `tests2/browser/e2e/sandbox-extension-requirements.spec.ts`: install/enable/grant/configure requirement, verify pending then available after build, reload, revoke/disable/remove and verify it disappears. Clean up pack, activation, settings, and grants.

Register every new file in `tests2/tests-map.json`: core tests as `runner: "vitest", tier: "unit", project: "core"`; integration test as its existing in-process integration runner/tier; browser file as the browser journey entry. Update the map's census/generated metadata using the repository's registration workflow rather than hand-editing unrelated entries. The normal verification sequence is `npm run check`, targeted Vitest files, then the registered browser journey; no real Docker is required for the focused suite.

## 9. Non-goals

This slice does not add Code Intelligence consumer behavior, arbitrary package installation, extension-authored containers, custom Dockerfiles, a second image builder, or automatic pruning of old images. It only establishes the generic, safe declaration-to-existing-build-path contract.
`