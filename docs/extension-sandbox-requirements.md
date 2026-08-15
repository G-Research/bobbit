# Extension sandbox requirements

Schema-3 packs can declare a **toolchain requirement** for Bobbit's Docker sandbox.
The declaration says which core-owned toolchain profile a pack needs; it does not let a
pack describe how to build an image. This lets a project opt into a supported toolchain
without turning a marketplace pack into a Docker build authority.

This reference complements [Marketplace](marketplace.md), [Project extension
settings](extension-settings.md), and [Extension capability grants](extension-capability-grants.md).

## Authoring a declaration

A pack must use schema 3 and list each declaration basename in `pack.yaml`. Only listed
files under `sandbox-requirements/` are considered.

```yaml
# pack.yaml
schema: 3
name: python-analysis
version: 1.0.0
description: Python analysis helpers.
contents:
  roles: []
  tools: []
  skills: []
  entrypoints: []
  sandboxRequirements: [analysis]
```

```yaml
# sandbox-requirements/analysis.yaml
id: python-analysis
profiles: [python]
config:
  enabled:
    type: boolean
    default: true
activation:
  requiresConfig: [enabled]
```

The declaration has exactly these top-level fields:

| Field | Meaning |
| --- | --- |
| `id` | A pack-local, bounded lowercase identifier shown in status and settings. |
| `profiles` | A non-empty, duplicate-free list of approved core toolchain IDs. `python` is the currently supported profile. |
| `config` | Optional flat, public extension-settings descriptor map. It uses the [project settings descriptor contract](extension-settings.md#descriptor-contract); secret fields are not allowed. |
| `activation` | Optional `requiresConfig` gate for keys declared in `config`. |

Manifest list names and declaration identifiers are bounded safe basenames. Catalogues,
declaration files, profile lists, and the final aggregate plan are also bounded. Unknown
top-level fields, malformed IDs, duplicate profiles or IDs, unknown profiles, invalid
settings, and unsafe or unlisted files are rejected rather than partly interpreted. The
exact limits and profile vocabulary are core implementation details so they can be
safely tightened or expanded; pack authors must use the currently accepted schema rather
than depending on incidental capacity.

A declaration is inert metadata. It does not run code, create a process, invoke Docker,
or make a toolchain available by itself.

## Required project authority

A requirement participates only when **all** of these independent checks pass:

1. The pack is the active winning pack for the project and its manifest-listed requirement
   is enabled through Marketplace activation.
2. The requirement's project settings target (`sandboxRequirement`) is enabled and any
   `requiresConfig` gate is satisfied. Settings are public primitives only; an unavailable
   or invalid settings read denies use.
3. A project operator has granted the active pack principal the exact `sandbox:build`
   capability. This is a pack-only capability: a hook cannot receive it, and a manifest
   cannot grant it to itself.
4. The project config selects `sandbox: docker`.

The first three steps decide whether an active declaration is part of the **desired image
plan**. The fourth is separately owned by project configuration and decides whether Bobbit
may build or start a Docker sandbox. A pack cannot enable Docker mode, select an image, or
cause a build for another project.

Activation, settings, and grants are separate on purpose. Disabling a requirement does
not erase its settings or grant; revoking the grant does not alter its declaration; and a
project setting cannot revive an inactive pack. Each resolver pass rechecks the current
winning pack, settings, and grant, so no restart is required for a revocation to take
effect.

## Core-built image plan

Core resolves eligible declarations to a deterministic set of approved profiles, then
uses its existing sandbox image builder. The fingerprint incorporates the normalized
project base-image configuration, approved profile set, core recipe-set revision, and
agent version. Requirement identities are retained for status but do not provide build
input. Equivalent eligible declarations therefore produce the same desired plan,
regardless of discovery order.

Bobbit builds only from its own Docker context and supplies fixed, core-generated build
arguments and image identity. An extension declaration can never provide or interpolate:

- Dockerfile text or another build context;
- commands, paths, image tags, packages, registries, or build arguments;
- environment variables, credentials, or secret settings.

This is both an injection boundary and an ownership boundary: toolchain recipes, package
selection, base image validation, Docker invocation, and all environment handling remain
core responsibilities. This feature is not a general extension image builder and does
not add a second sandbox builder, arbitrary package installation, or extension-defined
runtime commands.

## Status, build, and lifecycle

`GET /api/sandbox-status?projectId=…` reports the server-resolved requirements projection
when a plan can be resolved. It includes a fingerprint, the approved profiles, and one
entry per eligible `{ packId, requirementId }`. Status is intentionally derived from
project state and Docker inspection, not from client-supplied requirement or image data.

| State | Meaning |
| --- | --- |
| `pending` | The desired profile plan is not yet represented by an image with matching core labels. The image may be missing or stale. |
| `available` | Docker is available and the desired image has matching requirement-fingerprint and agent-version labels. A present base image alone is not sufficient. |
| `failed` | A build attempt for this project and exact desired fingerprint failed. The projection exposes only the stable `build-failed` code, not Docker output. A later successful build clears this state. |
| `unsupported` | Bobbit cannot use the resolved plan in the current sandbox context, such as unavailable Docker; requirements are also unsupported when the project does not select Docker mode. |

If the base-image configuration itself is invalid, no safe plan or requirement projection
is claimed; sandbox status reports unsupported image configuration instead. If there are
no eligible declarations, the projection contains no requirement entries.

`POST /api/sandbox-image/build` resolves the plan again on the server. Its request may
choose only the project; requirement lists, image names, profiles, and other build-shaped
values from a client are ignored. It rejects a project not configured for Docker mode and
fails closed for an unsupported base image. Normal sandbox bootstrap also checks the same
plan: a missing image is built, and an existing image with stale agent or requirement
labels is rebuilt through the same core path.

A ready sandbox has a fast path only while its resolved image identity and fingerprint are
unchanged. When an eligible requirement is added, changed, disabled, revoked, or removed
with its pack, the next resolution yields the new plan; a ready sandbox is recreated rather
than reused with the old identity. Removal therefore withdraws the requirement from status,
fingerprint/rebuild decisions, and future sandbox use. Build failures are tracked only for
the exact project and desired fingerprint, so an old failure cannot describe a different
plan.

## Operator checklist

1. Install an active schema-3 pack with a valid, listed declaration.
2. Review and enable the requirement in Marketplace if appropriate, and satisfy its public
   configuration gate.
3. Grant that pack the exact `sandbox:build` capability for the intended project.
4. Set that project's sandbox mode to Docker.
5. Inspect sandbox status and use the normal build path when the plan is pending.

To withdraw the toolchain, revoke `sandbox:build`, disable the requirement or pack, or
remove the pack. Each option stops the requirement from entering the next resolved plan;
no extension-provided cleanup command runs.
