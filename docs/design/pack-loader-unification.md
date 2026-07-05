# Pack loader unification — providers/mcp/channels/runtimes vs. PackResolver (P2)

Status: **design only, no code moved**. Written against
`EXTENSION-SEAM-AUDIT.md` §1 row 31 / §2 P2's optional item: *"Unify
`providers/mcp/channels/runtimes` loading under PackResolver's pipeline"* —
noting that only `roles|tools|skills` go through the single, unified
`PackResolver` (`pack-types.ts:26-27`); the audit calls
`providers/mcp/channels/runtimes` "bespoke loaders in
`pack-contributions.ts`" and marks the item optional, explicitly leaving
open whether it's worth doing at all.

All line numbers below were verified live against
`src/server/agent/pack-*.ts`, `src/server/extension-host/*.ts`, and
`docs/marketplace.md` in this worktree (`fable/d6-loader-design`, based on
`origin/aj-current`) on 2026-07-05 — grep and read, not recalled.

## Recommendation

**Do not migrate providers/mcp/channels/runtimes/panels/entrypoints/
settings-sections onto `PackResolver`'s per-entity-name shadow-merge
pipeline.** The audit's framing ("bespoke loaders," implying drift) doesn't
match what's actually on disk: these seven contribution kinds already share
one substrate — `loadPackContributions()` (`pack-contributions.ts:379-396`)
loads all of them in one pass per pack, sharing YAML parsing, basename/path
containment guards, duplicate-id conflict handling, and the
`PackContributionError` protocol; `PackContributionRegistry`
(`pack-contribution-registry.ts:83`) then does the SAME enumerate → collapse
→ activation-filter → cache job `PackResolver` does for roles/tools/skills,
just collapsing by **packId** instead of by **entity name**. When a sixth
kind (`settings-section`) was added in production three months ago
(`docs/design/pack-settings-contribution.md`, PR #145), it was built by
extending this existing shared substrate in an afternoon's worth of
copy-shaped code (`loadSettingsSections()`, `pack-contributions.ts:461-522`)
— not by inventing a seventh bespoke pattern. That's the strongest evidence
available that the "optional" unification is **already >80% done** in
practice; what's left is a real, load-bearing architectural difference
(§1), not accumulated drift.

The one piece worth doing regardless of the unification question:
**§4's four pinning tests don't exist today** (no `pack-resolver.test.ts`,
no dedicated `pack-contribution-registry.test.ts` — precedence coverage is
folded into `pack-marketplace.test.ts` and `pack-contributions.test.ts`
without a byte-identical-resolution-order pin per contribution kind). Add
those regardless of whether any further migration ever happens — they are
cheap, they are the thing every future pack-loader change (including a
future contribution kind) will need, and per repo convention a missing pin
IS the bug.

The "do nothing" option (§3 row 1) is a legitimate, low-regret choice here
— not a placeholder for "someone should eventually do the real unification."

---

## 1. What concretely differs across the loaders

There are really **three** loading mechanisms in play today, not one
unified one and five bespoke ones:

| | `PackResolver` (roles/tools/skills) | `loadPackContributions` + `PackContributionRegistry` (panels/settings-sections/entrypoints/providers/channels/runtimes/mcp) | Direct ad-hoc calls |
|---|---|---|---|
| **Merge key** | Entity **name**, global across all packs (`pack-resolver.ts:44-66`) | **packId** — whole-pack winner-take-all across scopes, no cross-pack merge of individual contributions (`pack-contribution-registry.ts:193-203`) | n/a — single-pack read |
| **Cross-pack collision semantics** | Real: pack A and pack B can both define a role named `reviewer`; one shadows the other, both retained in `shadows[]` for conflict UI (`pack-types.ts:177-232`) | Structural non-issue for same-kind ids: a provider `id` is scoped `(packId, contributionId)`, so pack A's `memory` provider and pack B's `memory` provider are BOTH active, never a "conflict" (`pack-contributions.ts:782-783` comment, explicit design choice) — except entrypoint `routeId` and panel-serving paths, which ARE host-global and DO get a real cross-pack conflict check (`pack-contribution-registry.ts:266-285`) | n/a |
| **Precedence across scopes** | Builtin < server < global-user < project, by construction of `buildPackList()` (`pack-list.ts:153-275`) | Same underlying `buildPackList()`/enumerate ordering, but collapsed to ONE winning `PackEntry` per packId BEFORE loading (`pack-contribution-registry.ts:196-203`) — a same-named pack installed at both `global-user` and `project` scope resolves as a single pack (the higher scope's copy entirely), never a per-contribution merge of the two installs | n/a (single install site, no scope layering) |
| **Activation filtering timing** | BEFORE merge, via `ActivationFilter` callback per `(entry, type, name)` (`pack-resolver.ts:34,52-54`) — a disabled higher-priority entity lets a lower-priority same-name entity win | AFTER load, inline per resolved pack in `PackContributionRegistry.build()` (entrypoints `:220-225`, providers `:226-245`, runtimes `:251-262`) — there is no "shadow reappears" case because packId-collapse already picked one winning `PackEntry`; disabling drops the entry from the one winner, it can't fall through to a different scope's copy of the "same" pack | n/a |
| **Enable/disable granularity** | Per entity name (`DisabledRefs.roles/tools/skills`) | Per contribution `listName`/id (`DisabledRefs.entrypoints/providers/mcp/piExtensions/runtimes`, `pack-default-activation.ts:83-92`) — PLUS providers get a second, config-gated activation layer (`activation.requiresConfig`/`activeWhenConfig`, `pack-contributions.ts:304-339`, evaluated in `pack-contribution-registry.ts:308-341`) that no other kind has | n/a |
| **Error handling** | Malformed role/tool/skill file: warn + drop (existing `parseRolesDir`/`parseToolsDir`/`scanSkillDir` tolerance) | Same warn-and-drop tolerance for malformed files, but **hard** `PackContributionError` throws (reject the WHOLE pack's contribution load) on five specific intra-pack id collisions enumerated at `pack-contributions.ts:20-24` — a class of failure PackResolver's per-entity-name shadowing doesn't need, because a name collision there is a NORMAL, handled case (shadow), not an error | Errors caller-specific (e.g. `marketplace-routes.ts:181`, `server.ts:828` each `try/catch PackContributionError` independently) |
| **Runtime execution model after resolution** | None — roles/tools/skills are data (YAML → prompt/tool-schema fragments); no process/module isolation concept applies | Sharply divergent PER KIND: providers/channels load as **JS modules inside a `worker_threads` resource+crash-isolated ModuleHost** (`module-host-bootstrap.ts`, `confinement-loader.ts`) with path-containment on the module graph; runtimes are **not JS modules at all** — they're declarative descriptors handed to `PackRuntimeSupervisor`, which manages Docker-sidecar lifecycles; panels/settings-sections are **browser-loaded ESM via Blob URL** in the main frame, no isolation (`docs/marketplace.md`'s "Model A" trust note); MCP contributions become **stdio/http client configs**, not loaded code at all | n/a |
| **Caching / invalidation** | No caching in `PackResolver` itself — callers (`config-cascade.ts`, `slash-skills.ts`) own their own TTL/cache | `PackContributionRegistry` caches per-`projectId` (`cache: Map`, `:84`), invalidated by the single `invalidateResolverCaches()` chokepoint (`docs/marketplace.md` §"Precedence, project scoping, and cache invalidation") | No caching — several call sites (`server.ts:828,1687`, `marketplace-install.ts:324`, `marketplace-routes.ts:181,617`, `builtin-pack-defaults.ts:80`) call `loadPackContributions` directly, bypassing the registry's activation filtering AND its cache, each for a narrow single-pack read |
| **Discovery mechanism** | Auto-discover directory contents (`scanRolesDir`/`scanToolsDir`/`scanSkillDir`), no manifest listing needed | Split: panels/settings-sections are **auto-discovered** (glob the dir, `pack-contributions.ts:399-406,461-468`); entrypoints/providers/channels/runtimes/mcp are **manifest-listed** (`manifest.contents.<kind>[]` is the allowlist of basenames to load, `:526-527,660-661,710-711,786,1118`) — a file sitting in `providers/` that isn't listed in `contents.providers` is silently never loaded | n/a |

**The one real, load-bearing divergence** is the merge key: entity-name
shadow-merge (PackResolver) vs. packId-scoped winner-take-all
(PackContributionRegistry). Everything else in the table above — activation
timing, error-handling tone, execution model — is either a direct
*consequence* of that key difference or an orthogonal concern (module
isolation) that has nothing to do with which pipeline loads the manifest.
`docs/marketplace.md` already states the architectural reason plainly:
*"MCP uses a separate pack-contribution path because it resolves to scoped
runtime managers rather than role/tool/skill name-merged entities"*
(`docs/marketplace.md:1012`). That sentence generalizes to all seven kinds
in the right-hand column, not just MCP.

### 1.1 What the direct ad-hoc call sites reveal (the real gap)

The clearest actual inconsistency isn't PackResolver vs. PackContributionRegistry
— it's that **`loadPackContributions()` itself is called directly, bypassing
the registry, in at least six places**: `server.ts:828` (provider id listing
for the pack-order UI), `server.ts:1687` (MCP contribution enumeration),
`marketplace-install.ts:324` (entrypoint listName collection during install),
`marketplace-routes.ts:181,617` (pack detail / provider-config routes), and
`builtin-pack-defaults.ts:80` (default-activation catalogue). Each of these
re-reads the winning pack's manifest from disk, uncached, and — critically —
**without the registry's activation filtering** (disabled providers/entrypoints/
runtimes are NOT dropped by a bare `loadPackContributions` call; only
`PackContributionRegistry.build()` applies that). Most of these call sites
have a documented reason to want the RAW, unfiltered view (`getRawPack`'s own
doc comment at `pack-contribution-registry.ts:117-134` explains exactly this
for the managed-runtime REST surface), but the pattern of "just call
`loadPackContributions` again" rather than "call `registry.getRawPack()`"
is inconsistent and is genuine, fixable drift — independent of the
PackResolver-unification question this doc was asked to evaluate.

---

## 2. Full unification, thinner substrate, or null option

Three shapes, evaluated against the actual difference found in §1:

### (a) Full unification under PackResolver

Force providers/mcp/channels/runtimes/panels/settings-sections/entrypoints
through `PackResolver.resolve<T>(type)`'s name-shadow-merge pipeline. This
would require either:

- Declaring cross-pack namespacing (`packId:contributionId`) AS the "name"
  PackResolver merges on — which makes the shadow/conflict mechanism
  (`shadows[]`, `buildConflictsFor()`) permanently inert for these kinds
  (two packs' `memory` providers never actually collide by construction —
  §1's row 2), so the machinery being adopted would carry dead code paths
  forever, or
- Redefining PackResolver's merge key to be scope-collapse-then-list
  instead of name-shadow — which is a different algorithm, not an adoption
  of the existing one; at that point "unification" means rewriting
  PackResolver into something that also expresses PackContributionRegistry's
  shape, not migrating one onto the other.

Either path also has to reconcile PackResolver's pre-merge
`ActivationFilter` timing with the provider config-gate
(`activation.requiresConfig`/`activeWhenConfig`) which depends on
POST-load, resolved config data that doesn't exist until after the winning
pack's file is read — the filter would need a new "activation depends on
loaded content" capability PackResolver doesn't have today.

**Cost**: touches the load-bearing pipeline every role/tool/skill resolution
depends on, for a payoff that is mostly cosmetic (both pipelines already
share `buildPackList()`/`scopePaths()`/enumerate ordering underneath). **Not
recommended.**

### (b) Thinner shared substrate: common discovery + precedence, kind-specific validation

This already exists in substance. `loadPackContributions()` is the shared
discovery/read layer (one function, one call per pack, all seven kinds);
`PackContributionRegistry` is the shared precedence/activation/cache layer
(one class, one `build()` pass, all seven kinds). The remaining
non-uniformity is exactly the tolerable, kind-specific bits: whether a kind
is auto-discovered vs. manifest-listed (§1 discovery row), and each kind's
own field validation (`PROVIDER_ID_RE` vs. `CHANNEL_NAME_RE` vs. the MCP
transport normalizer) — which is inherent to each kind having a different
shape, not a loader-architecture problem PackResolver-style unification
would fix.

The one genuine thinning worth doing: **collapse the six ad-hoc
`loadPackContributions()` call sites (§1.1) onto `registry.getRawPack()` /
`registry.getPack()`**, so there is exactly one code path per (raw vs.
activation-filtered) need, not seven. This is small, mechanical, and has an
existing precedent to follow (`getRawPack`'s own documented rationale).

### (c) Null option — document and stop

Given (a)'s cost/benefit and (b)'s "already mostly done" finding, the
honest recommendation is: **write this document, fix §1.1's ad-hoc-call
drift as ordinary cleanup, add the resolution-order pins in §4, and close
the audit's P2 item as "evaluated, not pursued."** The audit itself flagged
this as optional and asked whether divergence is "mostly superficial" — it
is: the two real mechanisms (name-merge vs. packId-collapse) exist because
the entities they resolve have genuinely different collision semantics, not
because five loaders drifted from a shared design that was never enforced.

| | (a) Full unification | (b) Thinner substrate | (c) Do nothing further |
|---|---|---|---|
| Engineering cost | High — rewrites or bends the shared roles/tools/skills pipeline | Low — mostly the §1.1 cleanup, which is independently justified | Zero (this doc + pins in §4) |
| Risk to existing packs | Real — PackResolver is on the hot path for every role/tool/skill resolution in every session | Low — touches only the 6 ad-hoc call sites, each already has a registry equivalent to switch to | None |
| What it actually buys | A conceptual "one pipeline" claim that doesn't hold once you look at merge semantics | One fewer inconsistent pattern (§1.1), no new capability | Nothing new, but nothing lost — the substrate sharing already achieved (§0) stands |
| Consistency with `settings-section`'s precedent | Contradicts it — that migration explicitly extended the EXISTING contribution substrate, not PackResolver | Matches it exactly | Matches it exactly |

**Recommended: (c), with (b)'s one cleanup item folded in as ordinary
maintenance**, not as "phase 1 of the unification."

---

## 3. Migration staging (if a future kind DOES need to be added)

Even under the null option, the next contribution kind will want to know
"where does this go" without re-deriving the analysis in §1-2. The
decision rule the `settings-section` precedent already establishes:

1. **Does the new kind have real cross-pack same-name collision semantics**
   (two packs plausibly defining the "same" thing, where one should win)?
   → it belongs on `PackResolver` as a new `EntityLoader`
   (`docs/marketplace.md:1011`'s own guidance: "adding a future name-merged
   entity type is *adding a loader*, not touching the ordering core").
2. **Is it inherently pack-scoped** (namespaced by `packId` from the
   start, never expected to collide across packs, resolves to a
   scoped runtime manager/handler rather than a flat entity)? → it belongs
   in `pack-contributions.ts` + `PackContributionRegistry`, following the
   `settings-section` pattern exactly: add a `<Kind>Contribution`
   interface, a `load<Kind>s()` function copy-shaped from `loadPanels`/
   `loadSettingsSections`, a field on `PackContributions`, a case in
   `loadPackContributions()`, and (if it needs activation filtering) a
   block in `PackContributionRegistry.build()` mirroring the
   entrypoints/providers/runtimes handling.

No wave-based migration of EXISTING kinds is proposed (per §2c), so there
is no "never break an installed pack" staging plan to design here — the
null option's only forward action is: apply this same per-new-kind decision
rule, and don't let a future kind invent an eighth ad-hoc pattern the way
§1.1's six call sites did.

If §2's recommendation is ever revisited and (b)'s cleanup is picked up:

1. **Wave 1 (mechanical, no behavior change)**: switch the six §1.1 call
   sites to `registry.getRawPack()`/`registry.getPack()` one at a time,
   each behind the resolution-order-parity pin in §4 (byte-identical output
   for the same pack, before/after the switch). Independently revertible
   per call site.
2. **No wave 2 is proposed** — there is no further consolidation target
   once §1.1 is closed, per §2's finding that the substrate is already
   shared.

---

## 4. Pins that must exist regardless of any migration decision

None of these exist today by that exact shape (`pack-contributions.test.ts`
and `pack-marketplace.test.ts` cover functional behavior but not a
dedicated byte-identical-resolution-order pin per kind). Add before any
further change to either pipeline, migration or not:

1. **PackResolver resolution-order pin** (if missing beyond the existing
   `#4 three-scope resolution` / `market-vs-market` tests in
   `tests/pack-marketplace.test.ts:200,241`): a fixture with builtin +
   server market pack + global-user market pack + project market pack all
   defining a role/tool/skill of the SAME name, asserting winner + exact
   `shadows[]` order low→high.
2. **PackContributionRegistry packId-collapse pin**: a fixture with the
   SAME packId installed at two different scopes (e.g. `global-user` and
   `project`), asserting the higher-scope copy wins WHOLESALE (not a
   per-contribution merge) — this is the one property (a) in §2 would have
   to change, so it needs to be locked down before anyone touches either
   pipeline.
3. **Per-kind activation-filter-timing pin**: one test per kind
   (entrypoints, providers, runtimes) asserting a disabled contribution is
   dropped from `registry.getPack()`'s output but the field IS present
   (unfiltered) via `registry.getRawPack()` — pins the raw-vs-filtered
   distinction that `getRawPack`'s own doc comment (`pack-contribution-registry.ts:117-134`)
   currently only asserts in prose.
4. **§1.1 ad-hoc-call-site parity pin**: for any of the six direct
   `loadPackContributions()` callers that get switched to the registry (§3
   wave 1, if ever pursued), a before/after fixture asserting identical
   output for a pack with no disabled contributions (the common case where
   raw and filtered are supposed to agree).

---

## 5. Interaction with coming per-project/per-bobbit sandboxing

Per `bobbit-sandboxing-direction` (a separate, robust sandbox effort), pack
code will eventually run inside a contained environment rather than
today's Model A same-realm trust model
(`docs/marketplace.md`'s "Limitations & deferred work" §"No signing;
isolation is stability-only"). This doc's recommendation is orthogonal to
that effort and actively easier to reconcile with it under the null
option than under full unification:

- **The packId-scoped merge key (§1) is what makes per-pack sandboxing
  tractable at all.** A future sandbox boundary is naturally drawn AROUND
  one pack's contributions (one worker/container per pack, or per
  `(pack, contribution)` pair) — exactly the granularity
  `PackContributionRegistry` already resolves at (`getPack(projectId,
  packId)`). If contributions were instead flattened into PackResolver's
  global entity-name space (option (a)), the sandbox boundary would need
  to be re-derived FROM the resolved output's `origin` field on every
  entity, rather than being the natural unit the loader already produces.
- **The existing `worker_threads` ModuleHost isolation for
  providers/channels (`module-host-bootstrap.ts`, `confinement-loader.ts`)
  is the closest existing analogue to what a robust sandbox will formalize**
  — resource/crash isolation + module-root containment today, likely
  extended (not replaced) by the sandboxing effort. Runtimes already run in
  Docker sidecars (`PackRuntimeSupervisor`), i.e. already sandboxed at the
  OS level for a different reason (managed external services, not this
  trust boundary) — that precedent is worth the sandboxing effort looking
  at directly.
- **Nothing in §2's recommendation blocks or complicates the sandboxing
  work.** The null option leaves the packId-keyed contribution shape
  exactly as-is; a future sandbox seam attaches to
  `PackContributionRegistry`'s existing per-pack resolution, not to a
  hypothetical unified-under-PackResolver shape this doc recommends against
  building.

---

## 6. Summary answer to the audit's P2 item

Close `EXTENSION-SEAM-AUDIT.md`'s optional P2 unification item as
**evaluated, not pursued** — link this document. The two-mechanism split
(name-shadow-merge for roles/tools/skills vs. packId-scoped
collapse-and-cache for the other seven contribution kinds) reflects a real
difference in collision semantics between "one global namespace of
entities" and "many independently-namespaced pack surfaces," not
architectural drift. The `settings-section` contribution kind's own
migration (`docs/design/pack-settings-contribution.md`) is the strongest
available evidence: when a real, production need for a sixth
`pack-contributions.ts`-style kind arrived, it was built by extending the
existing shared substrate, cheaply, in-pattern — not by inventing a new
bespoke loader outside it. The one genuine, independently-justified cleanup
(§1.1's six ad-hoc `loadPackContributions()` calls that bypass the
registry's cache and activation filtering) should land as ordinary
maintenance, and the four missing resolution-order pins (§4) should land
regardless of any of the above, because they are what the NEXT change to
either pipeline — migration or not — will need.
