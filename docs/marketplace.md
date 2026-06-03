# Marketplace — Extension Packs

The Marketplace lets a user point Bobbit at git repos or local directories that
contain **Extension Packs**, browse the packs they hold, and install a pack's
entities (roles, tools, skills) into the local config layers Bobbit already
reads. There is no hosted registry, no signing, and no sandbox — the model is
deliberately simple: *"point at repos with the right layout, install locally."*

This document describes how the feature behaves and why it is shaped the way it
is. The implementation-ready design rationale (every resolved open question,
the file-by-file plan, the test plan) lives in
[docs/design/marketplace-mvp.md](design/marketplace-mvp.md); this page is the
durable behaviour reference.

## Why it exists

Bobbit's roles, tools, and skills are already pluggable through a three-layer
config cascade (builtin → server → project). But there was no way to *share* a
themed bundle of them. The Marketplace fills that gap with the smallest thing
that works: a pack is just a directory tree laid out like Bobbit's own
`defaults/`, and "installing" it is just copying files into the config layer the
cascade reads. Nothing about resolution changes — an installed role is
byte-identical to a hand-authored one and resolves with the same origin badge
and scope semantics. That is the central design bet: **lean entirely on existing
mechanisms instead of inventing a parallel plugin runtime.**

## Where it fits

```
Source (git repo / local dir)
  └─ pack directory (has pack.yaml)
       ├─ roles/<name>.yaml        ─┐
       ├─ tools/<group>/...         ├─ install → .bobbit/config/... (or ~/.bobbit/skills)
       └─ skills/<name>/SKILL.md   ─┘            ↓
                                          ConfigCascade / skill discovery
                                                 ↓
                                          resolves like hand-authored config
```

- **Source registry** — server-global list of where to fetch packs from.
- **Sync** — clone/pull git sources into a state cache; local dirs read in place.
- **Scanner** — turns a synced source root into a list of packs + their entities.
- **Install engine** — copies a pack's entities into a config layer and records
  provenance so update/uninstall are exact and reversible.
- **Market page** — the browse/install UI, reached from a sidebar button.

The headline unit of distribution is the **pack**, not the loose entity. A
source contains one or more packs; a pack bundles several entity types around a
theme (e.g. a "Research Pack" of research roles, a web-digging tool, and a
deep-research skill).

## The unit of distribution: packs

A **source** is a git repo or a local directory. Its top level is a *collection
of pack directories* — never a flat `defaults/` mirror. A directory is a pack
**iff it contains a `pack.yaml`**; directories without one are ignored, so a
source repo can carry a README, CI config, etc. at the top level without
confusing the scanner. Scanning is **one level deep** — only immediate children
of the source root are considered.

```
<source-root>/
  research-pack/
    pack.yaml          # REQUIRED — makes this dir a pack
    roles/researcher.yaml
    tools/research/{*.yaml, extension.ts, _shared/...}
    skills/deep-research/SKILL.md
  qa-pack/
    pack.yaml
    roles/qa-lead.yaml
  README.md            # ignored (no pack.yaml)
```

The entity payload layout *inside* a pack mirrors Bobbit's `defaults/` tree
exactly, so authoring a pack is the same as authoring builtin config.

### `pack.yaml` manifest

`pack.yaml` is the pack's identity **and** a declaration of its contents. The
declaration is authoritative: a declared entity missing on disk makes the pack
invalid, while an on-disk entity that is not declared is ignored. This keeps
install deterministic and lets an author ship example/unsupported files without
them being installed.

```yaml
apiVersion: 1                 # REQUIRED int. Schema version; MVP accepts only 1.
id: research-pack             # REQUIRED. Stable id, unique within the source.
                              #   Pattern: ^[a-z0-9][a-z0-9-]*$
name: Research Pack           # REQUIRED. Display name.
description: Research roles…  # REQUIRED. Shown in the browse list + drill-down.
version: 1.2.0                # REQUIRED. Author-declared label. Displayed + recorded
                              #   in provenance, but NOT used for ordering (the git
                              #   commit SHA is the real freshness signal).
author: jane@example.com      # OPTIONAL
homepage: https://...         # OPTIONAL (rendered as a link only for http/https)
license: MIT                  # OPTIONAL
minBobbit: "0.80.0"           # OPTIONAL. Advisory only — shown, not enforced.

contents:                     # REQUIRED. At least one non-empty list required.
  roles:  [researcher]        # role file basenames (no .yaml) → roles/<name>.yaml
  tools:  [research]          # tool GROUP dir names → tools/<group>/
  skills: [deep-research]     # skill dir names → skills/<name>/ (must contain SKILL.md)
```

**Validation.** A pack is valid when `pack.yaml` parses, `apiVersion === 1`,
`id`/`name`/`description`/`version` are non-empty strings, `id` matches the
pattern, `contents` declares at least one supported entity, and every declared
entity exists on disk with the right shape (a role file that parses and whose
internal `name` matches the filename; a tool group dir with ≥1 `*.yaml`
carrying a `name:`; a skill dir with a `SKILL.md`). Validation failures are
**non-fatal at the source level**: an invalid pack is surfaced with an error and
marked non-installable, while valid sibling packs remain usable. Two packs in
one source claiming the same `id` are *all* marked invalid (the id is ambiguous
for install/uninstall keying).

**Forward-compat.** Unknown top-level keys and unknown `contents` keys (e.g. a
future `contents.panels`) are preserved and ignored — never an error. This is
what lets a future entity type ship in a pack today and become installable the
moment a handler for it is registered (see [Extensibility](#extensibility)).

## Source registry

The list of configured sources is persisted **server-globally**, not
per-project, at `<server-root>/.bobbit/state/marketplace/sources.json`.

**Why server-global.** A source answers "where do I fetch packs from?" — a
machine/user-level concern, independent of any project, typically serving many
projects, and authenticated with the user's ambient git credentials (one
identity per machine). Per-project source lists would force re-registering the
same repos everywhere. Only the *source list* is global; install *scope* (system
vs project) is still chosen per-install. This mirrors `ProjectRegistry`, itself
a server-global JSON store with the same atomic temp-file-plus-rename write.

The registry file stores the original git URL **with any embedded credentials**
(git needs them to authenticate) and is written `0600` where the OS honours
POSIX modes. Every record that leaves the server is passed through credential
redaction first, so tokens in userinfo (`user:token@host`), query params
(`?token=`, `?access_token=`, …), or a credential-bearing fragment never appear
in an API response, a derived label, or a provenance record. See
[docs/security.md](security.md) for the broader credential-handling posture.

## Sync

`MarketplaceSyncService` owns the sync cache under
`<server-root>/.bobbit/state/marketplace/<source-id>/`. Sources are reached
through a `SourceBackend` interface so the scanner always operates on a resolved
`root` regardless of backend.

- **Git sources.** First sync is a **shallow clone** (`--depth 1`, optional
  `--branch <ref>`); the cache stays small because packs are small text trees.
  Re-sync is **fetch + hard reset + clean** rather than `pull`, to avoid merge
  conflicts in a cache the user never edits; a missing/corrupt cache falls back
  to a fresh clone. After each sync the HEAD SHA is recorded as
  `lastSyncCommit` — the real freshness signal for update detection. Auth relies
  entirely on the user's ambient git credentials; a failure is surfaced as
  `lastSyncError` (fully credential-redacted) while leaving any previous good
  cache intact. Git runs as a child process with a bounded timeout.
- **Local sources.** Read **in place** — no clone, no copy. The scanner always
  reads the live directory, so on-disk edits are reflected immediately (good for
  authors iterating locally). A "sync" just re-validates that the path still
  exists; `lastSyncCommit` is `null`.

URLs and refs are validated on add and re-validated before reaching git's argv
(defence-in-depth against a tampered `sources.json`): a leading `-` is rejected
so a URL/ref can never be parsed as a git option, only well-known transport
schemes are allowed, and `--` terminates option parsing in every git
invocation.

Adding a **git** source awaits the first sync so the initial browse reflects
real cache state and surfaces sync errors immediately; a **local** source syncs
fire-and-forget because reading in place is cheap.

## Browse

`scanSource` turns a synced source root into a list of packs, and the browse API
composes scanner output across all sources, annotating each pack with an install
status computed from provenance for the requested scope:

| Status | Meaning |
|---|---|
| `not-installed` | No provenance record for this pack at this scope. |
| `installed` | Provenance exists and on-disk bytes match what was installed. |
| `update-available` | The source's current commit (git) or content hash (local) differs from what was recorded at install. |
| `drifted` | A recorded install path is missing, or its bytes were edited locally (per-entity content-hash mismatch). Surfaced so the user knows update/uninstall may be partial. Records predating the content-hash field fall back to existence-only drift detection. |

The browse list also reports `newEntitiesAvailable` — declared entities the
install record does not yet track (an upstream pack grew new entities since you
installed it). Update never auto-adds these (see below); the UI prompts the user
to re-install the pack to add them.

## Install, update, uninstall

### Scope and the cascade

Install scope is **`system`** (server layer) or **`project`** (a specific
project), reusing Bobbit's existing config-scope vocabulary so installed
entities resolve through `ConfigCascade` exactly like hand-authored config:

| Scope | Roles → | Tools → | Skills → |
|---|---|---|---|
| `system` | `<server-root>/.bobbit/config/roles/<name>.yaml` | `<server-root>/.bobbit/config/tools/<group>/` | `~/.bobbit/skills/<name>/` |
| `project` | `<project-root>/.bobbit/config/roles/<name>.yaml` | `<project-root>/.bobbit/config/tools/<group>/` | `<project-root>/.bobbit/config/skills/<name>/` + custom-dir registration |

These are exactly the directories the cascade already reads, so the origin badge
("server" vs "project") and the "overrides" indicator come for free. Tool
overlay is **group-level**: a group present in a higher layer replaces the
entire builtin group of the same name — the same semantics as the existing
tool-customize copy.

### Why skills install differently

Skills are the one entity type that does **not** ride the role/tool cascade.
`discoverSlashSkills` resolves skills from the *session cwd* (a worktree), not
the project root the server reads roles/tools from, so a naive
`<project-root>/.bobbit/config/skills` would never be scanned. Two paths are
guaranteed to be scanned and are used instead:

- **Project scope** → skills are copied to
  `<project-root>/.bobbit/config/skills/<name>/` **and** that directory is
  registered (idempotently) as an absolute-path custom skills directory in the
  project's `config_directories`. Discovery resolves custom dirs as absolute
  paths regardless of session cwd, so every worktree session of the project sees
  the skill, with no git commit required to propagate it.
- **System scope** → skills are copied to `~/.bobbit/skills/<name>/`, which
  discovery scans unconditionally for every session on the machine.

The project-scope custom-dir registration is reconciled against on-disk reality
as the **final step** of every install/uninstall/update/rollback: the "skills"
registration exists *iff* the shared dir currently holds ≥1 skill. This single
invariant means uninstalling one skill pack can never break a sibling pack that
still lives under the shared dir, and the registration can never drift.

### Whole-pack and per-entity install

Installing the whole pack is the primary action, but installing an individual
entity from a pack's drill-down is also allowed — the install primitive is
naturally per-entity (each entity copies independently), so whole-pack install
is just "install every declared entity." Provenance records exactly which
entities were installed, so uninstall is symmetric whether the user took the
whole pack or a subset. A subset install into an already-installed pack
*merges* into the existing record (union by type/name) rather than replacing it.

### Conflict handling

A conflict is: the destination already exists *at the target scope*. The install
API takes a `conflict` mode, defaulting to **`fail`**:

- `fail` — abort the whole install transactionally; the API returns `409` with
  the conflicting entities. Nothing is written. The UI then offers to overwrite.
- `overwrite` — replace the existing entity. If it was previously
  marketplace-installed by another pack, ownership transfers to the new pack so
  uninstall stays symmetric (the prior pack must not later delete an entity it
  no longer owns).
- `skip` — install only the non-conflicting entities and report which were
  skipped.

Conflicts are evaluated against the **same scope only** — installing at project
scope when a builtin/server entity of the same name exists is *not* a conflict;
that is normal cascade-shadow behaviour, surfaced by the origin "overrides"
badge.

### Transactionality

Install computes the full plan, runs all conflict checks first, then copies.
Overwrite targets are moved aside to a temp backup before copying, so a mid-copy
failure rolls back every write — already-copied entities are removed and backups
restored — leaving the system byte-for-byte as it was. Provenance is written
only after all copies succeed. Update applies the same transactional discipline
across both removals and copies.

### Update

Update re-syncs the source first (and **aborts** if the sync failed, rather than
recording a stale/null commit), then re-copies exactly the entities the existing
provenance record tracks and the updated pack still declares. Entities the new
pack version no longer declares are removed (so update never leaves orphans);
newly-declared entities are **never** auto-added — update is "refresh what I
have," and the UI surfaces new entities via `newEntitiesAvailable`. The original
install intent (whole-pack vs subset) is preserved on the rewritten record. If
the updated pack no longer declares any tracked entity, the provenance record is
removed entirely rather than left as a phantom empty "installed" record.

### Uninstall

Uninstall deletes exactly the `installedPaths` the provenance record tracks
(refusing any path that escapes the entity type's destination dir, in case of a
tampered provenance file), reconciles the project skills registration, and drops
the record.

### After any change

Caches are invalidated so entities resolve immediately: role stores reload, the
tool scan cache is reset (it is mtime-keyed and Windows mtime is coarse), and
the skills custom-dir registration bump naturally invalidates the
discovery cache.

## Provenance

Provenance is what makes update/uninstall exact and reversible: it records the
precise paths install wrote, plus the source commit/version and a per-entity
content hash. It is **committed alongside the entities it tracks**, per scope:

- **System scope** → `<server-root>/.bobbit/config/marketplace/installed.json`
- **Project scope** → `<project-root>/.bobbit/config/marketplace/installed.json`

Installed entities live in committed `.bobbit/config/`, so provenance must
travel with them — a teammate who pulls the repo can then cleanly update or
uninstall. (The *source registry*, by contrast, is per-machine runtime state in
`.bobbit/state/`, because it is about fetch locations and credentials, not
installed artifacts.) The record key is the tuple
`(scope, projectId, sourceId, packId)`. A corrupt or hand-edited
`installed.json` never crashes the server: records failing the shape contract
are dropped on load.

## "Installs executable code" warning

A pack containing any **tool** entity ships executable `extension.ts`. The MVP
performs **no sandboxing or signing**, so the risk is made explicit at three
points: a warning chip on the pack card, a prominent notice on the drill-down,
and a confirmation dialog before installing (or updating) any code-bearing
entity. Whether an entity is code-bearing is driven by a per-entity-type
`carriesCode` flag, so the warning automatically covers future code-bearing
types (e.g. panels). Enforcement (a trust/permission model) is deferred — see
the seam below.

## REST API

All routes are under `/api/marketplace`. Scope is validated by a shared helper:
scope must be `system` or `project` (empty defaults to `system`), and `project`
requires a non-empty `projectId`; anything else is a `400`. See
[docs/rest-api.md](rest-api.md) for the full API surface.

| Method | Route | Effect |
|---|---|---|
| `GET` | `/sources` | List sources with sync status (credential-redacted). |
| `POST` | `/sources` | Add a source (`{kind, url?, ref?, path?, label?}`); validates, assigns an id, kicks the first sync. |
| `DELETE` | `/sources/:id` | Remove from the registry and delete its sync cache. Does **not** uninstall packs that came from it (installed entities are independent copies). |
| `POST` | `/sources/:id/sync` | Re-sync and return updated status. |
| `GET` | `/packs?scope=&projectId=` | List packs across all sources, annotated with install status for the scope. |
| `GET` | `/packs/:sourceId/:packId?scope=&projectId=` | Drill-down: manifest + per-entity install status. |
| `POST` | `/install` | `{sourceId, packId, scope, projectId?, entities?, conflict?}`. `entities` omitted ⇒ whole pack; otherwise a subset. Returns the provenance record + per-entity result. `409` (with `conflicts`) when `conflict=fail` and a destination exists. |
| `POST` | `/update` | Re-sync, then re-copy the tracked entities. |
| `POST` | `/uninstall` | Remove exactly the recorded paths and drop the record. |

## Market page (UI)

A **Market** button sits in the sidebar between **Workflows** and **New Goal**
(`data-testid="sidebar-market-button"`), opening the marketplace at `#/market`.
Pack drill-down is `#/market/<sourceId>/<packId>` (route view `market-pack`).

The page reuses the shared config-scope model (`config-scope.ts`): the same
System / project scope tabs as the Roles and Tools pages, defaulting to System
when no project is active. The install-button label reflects the active scope
("Install to System" / "Install to <Project>"). The list view shows a Sources
section (add / re-sync / remove) and an Extension Packs grid; invalid packs
render their error and are not installable; tool-bearing packs show the
executable-code chip. The drill-down lists per-entity install controls plus pack
metadata. Install/update/uninstall route through credential-safe gateway
fetches, with the executable-code confirmation gating code-bearing actions and
the `409` conflict response prompting an overwrite confirmation. A pack's
attacker-controlled `homepage` is only rendered as a clickable link for
`http`/`https` schemes.

## Extensibility

The MVP is intentionally small but designed so new entity types and new
distribution backends are *additive*, not a redesign. Three boundaries deliver
that:

1. **Entity-type handler registry.** Each entity type (role / tool / skill)
   provides one `EntityTypeHandler` describing its manifest key, payload path,
   validation, install/uninstall, and `carriesCode` flag. The scanner, install
   engine, and executable-code check all iterate the registry rather than
   hardcoding types. **Adding a type is one new handler + one registry entry** —
   no change to the scan/install/uninstall control flow. Because unknown
   `contents` keys are already preserved, a pack can declare a future entity
   type today and have it install the moment its handler is registered.
2. **Source-backend interface.** Sync talks to sources through a `SourceBackend`
   (`git`, `local` in the MVP). A hosted **registry** backend would implement
   `sync` to fetch into the same cache layout, after which the identical
   scanner/install pipeline runs. `sources.json` already carries a `kind`
   discriminator, so adding `"registry"` is additive.
3. **Trust-policy call site.** The install engine invokes a `TrustPolicy.check`
   gate before any handler runs. In the MVP it is a no-op that only drives the
   executable-code warning; a future phase can make it consult a
   signature/allowlist and block. The call site exists from day one.

### Deferred to later phases

These are intentionally excluded from the MVP but on the roadmap, with seams
left so each is additive (full rationale in
[the design doc](design/marketplace-mvp.md#8-extensibility-seams)):

- **UI Panels / plugins** (the eventual headline use case) — a `panels/` payload
  dir + a `panelHandler` with `carriesCode: true`.
- **Portable workflows** — blocked not by the marketplace but by workflows being
  project-scoped and bound to project-specific `(component, command)` pairs
  today; a future phase needs parameterised workflow bundles with a binding step.
- **Staff templates** — staff are runtime state today, not config; a future
  phase needs an exportable template shape first.
- **Trust / sandboxing / signing** of code-bearing packs — the call site exists;
  enforcement does not.
- **Hosted / remote registry** with search/discovery — a new `SourceBackend`.

## Testing

- **Unit** (`file://` fixtures, `tests/marketplace-*.test.ts`): manifest parsing
  and source-layout scanning, install/uninstall/update file operations,
  provenance records, conflict handling, and the source registry — pointed at
  fixture source trees.
- **Browser E2E** (`tests/e2e/ui/marketplace.spec.ts`, mandatory per
  [AGENTS.md](../AGENTS.md)): Market button visible and opens the marketplace →
  add a local source → browse packs → install a pack → its entities resolve on
  the Roles/Tools pages → persists across reload → uninstall.

See [docs/testing-strategy.md](testing-strategy.md) for the broader testing
approach.
