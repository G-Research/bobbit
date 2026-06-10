# Marketplace source fixtures (Pack Schema V1)

Each `*-src/` directory is a **local-dir marketplace source**: a directory whose
immediate subdirectories are packs (a dir is a pack iff it contains `pack.yaml`).
Tests register a source via `POST /api/marketplace/sources` with the absolute
`*-src` path, then install a named pack with
`POST /api/marketplace/install { sourceId, dirName, scope }`.

All packs here use the **V1 on-disk schema** (see
`docs/design/pack-schema-v1-rationalisation.md`):

- tool YAML (`tools/<group>/<tool>.yaml`) declares **only** `renderer` + `actions`;
- panels are **auto-discovered** from `panels/*.yaml` (never listed in `contents`);
- entrypoints live in `entrypoints/<name>.yaml`, listed by basename in
  `contents.entrypoints` (toggleable activation points);
- pack-level routes live in `pack.yaml` `routes: { module, names }`;
- shared implementation modules live in `lib/`;
- path-bearing fields resolve relative to the declaring YAML and stay inside the
  pack root (`tools/<g>/<t>.yaml` → `../../lib/x.js`, `panels/p.yaml` →
  `../lib/x.js`, `pack.yaml` → `lib/x.mjs`).

## Available sources

| Source dir | Pack(s) | Purpose |
|---|---|---|
| `retry-demo-src` | `retry-demo` | renderer + action tool pack (Phase-1 litmus; unchanged shape) |
| `no-tools-pack-src` | `no-tools-pack` | ORPHAN / UI-only pack: `contents.tools:[]`, panel + 2 entrypoints + pack-level route. Drives pack-bound surface auth. |
| `panel-only-src` | `panel-only` | panel-only pack: a single auto-discovered panel, all-empty `contents`. |
| `conflict-dup-route-name-src` | `dup-route-name` | HARD CONFLICT: duplicate route name within a pack (`routes.names: [bundle, bundle]`). |
| `conflict-dup-panel-id-src` | `dup-panel-id` | HARD CONFLICT: two `panels/*.yaml` with the same `id`. |
| `conflict-dup-entrypoint-id-src` | `dup-entrypoint-id` | HARD CONFLICT: two `entrypoints/*.yaml` with the same `id`. |
| `conflict-dup-routeid-src` | `dup-routeid-a`, `dup-routeid-b` | HARD CONFLICT: two packs claiming the same host-global `routeId` — install both, register neither. |

These `*-src/` sources are the **marketplace-install + E2E** fixtures, consumed by
`tests/e2e/ui/extension-host.spec.ts`, `artifacts-pack.spec.ts`, and
`marketplace-conflicts.spec.ts` (the latter installs every conflict / orphan /
panel-only source above and asserts install-vs-registration surfacing via
`GET /api/ext/contributions`).

The **loader/parser unit** fixtures are NOT on disk: `tests/pack-contributions.test.ts`
synthesises packs in inline temp dirs (`fs.mkdtempSync`) and drives
`loadPackContributions` directly. (There is no `tests/fixtures/pack-schema-v1/**`
directory — that reference was stale.)
