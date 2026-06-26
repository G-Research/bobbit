# Configurable agent directory

## Goals

Make the pi-coding-agent data directory configurable without live-switching the running gateway. The new safe default is project-local:

```text
<projectRoot>/.bobbit/agent/
```

Resolution precedence must be exact:

1. `BOBBIT_AGENT_DIR`
2. `PI_CODING_AGENT_DIR`
3. persisted Bobbit setting
4. `<projectRoot>/.bobbit/agent/`

The directory is resolved once at server startup. A Settings change only writes the persisted next-start setting; the current process and all active sessions keep using the startup-resolved active directory until restart.

## Current audit

| Area | Current code | Path(s) | Required behavior |
|---|---|---|---|
| Resolver | `src/server/bobbit-dir.ts::globalAgentDir()` | env override or `~/.bobbit/agent` | Replace with startup-resolved `AgentDirConfig`. Default becomes `<projectRoot>/.bobbit/agent`; preserve env precedence. |
| Global auth | `globalAuthPath()`, `auth/oauth.ts`, `agent/model-registry.ts`, `agent/model-completion.ts`, `agent/name-generator.ts`, `agent/title-generator.ts`, `agent/image-generation.ts`, `agent/host-tokens.ts`, `agent/google-code-assist.ts` | `<agentDir>/auth.json` | Runtime reads/writes active startup dir only. Settings migration may copy it, never move/delete. Sandbox must never mount this host file directly. |
| Agent sessions | `agent/agent-session-path.ts`, `agent/session-manager.ts::recoverSessionFile()`, restore/orphan scans, cost backfill | `<agentDir>/sessions/` | New local/session paths use active startup dir. Recovery must also understand historical absolute `agentSessionFile` paths and known historical sessions roots. |
| Transcript safety | `agent/transcript-sanitizer.ts::isWithinAgentSessionsDir()` / `resolveSafeSessionsPath()` | currently only `globalAgentDir()/sessions` | Broaden trusted roots safely: active sessions root plus recorded historical roots and exact persisted `agentSessionFile` paths. Keep symlink and traversal protection. |
| Sandbox mounts | `agent/docker-args.ts` | host `<agentDir>/sessions` to `/home/node/.bobbit/agent/sessions`; `<agentDir>/models.json` read-only; sandbox auth from `.bobbit/state/sandbox-agent-auth/*.auth.json` to `/home/node/.bobbit/agent/auth.json:ro` | Use active startup dir for sessions and models only. Continue mounting scoped sanitized auth, not host `<agentDir>/auth.json`. |
| Container path translation | `agent/rpc-bridge.ts::buildMountTable()` | `/home/node/.bobbit/agent/sessions` <-> active host sessions root | Use active startup sessions root. Translation stays consistent with `docker-args.ts`. |
| Model cache/config | `agent/aigw-manager.ts`, `agent/openai-model-additions.ts`, `agent/model-completion.ts` | `<agentDir>/models.json` | Runtime writes active startup dir. Migration copies to pending dir when requested. |
| Google Code Assist cache | `agent/google-code-assist.ts` | `<agentDir>/google-code-assist.json` | Runtime reads/writes active startup dir. Migration copies to pending dir when requested. |
| Agent settings file | legacy migration in `bobbit-dir.ts` | `<agentDir>/settings.json` | Bobbit does not otherwise own it today, but migration must copy it for pi-coding-agent compatibility. |
| Bundled binaries | `server/cli.ts`, `server/binaries.ts::stageBundledBinaries()` | `<agentDir>/bin/{fd,rg}` | Stage into active startup dir after resolver initialization. Migration copies `bin/` recursively, skipping existing files unless overwrite selected. |
| Legacy Pi migration | `bobbit-dir.ts::migrateFromLegacyPiDir()` | `~/.pi/agent` -> `~/.bobbit/agent` | Keep existing startup migration only as a legacy pre-step, but do not silently migrate from old default to project default. New project-default migration is user-initiated copy-only. |
| Orphan transcript scan | `SessionStore.scanOrphanedTranscripts()`, `session-manager.ts` | active `<agentDir>/sessions` | Scan active sessions root for new orphan banner. Optional maintenance can include historical roots later, but not required for this goal. |
| Cost backfill transcript scan | `server.ts` boot after restore | active `<agentDir>/sessions` | Use active sessions root for boot scan. Persisted `agentSessionFile` sidecar fallback remains absolute-path based. |

## Startup resolver design

Add server-local types/helpers in `src/server/bobbit-dir.ts` or a small sibling module such as `src/server/agent-dir-config.ts`:

```ts
export type AgentDirSource = "BOBBIT_AGENT_DIR" | "PI_CODING_AGENT_DIR" | "persisted" | "default";

export interface AgentDirResolution {
  dir: string;              // absolute, normalized host path
  source: AgentDirSource;
  raw?: string;             // raw env/setting value, if any
  projectRoot: string;
  defaultDir: string;
}

export interface AgentDirRuntimeState {
  startup: AgentDirResolution;
  persisted?: string;       // resolved persisted setting, if present
  nextStart: AgentDirResolution;
  restartRequired: boolean; // startup.dir !== nextStart.dir
  history: string[];        // resolved historical agent dirs
}
```

Implementation notes:

- `setProjectRoot(args.cwd)` still runs before resolution.
- Add `defaultAgentDir(projectRoot = getProjectRoot()) => path.join(projectRoot, ".bobbit", "agent")`.
- Expand `~` for env and setting values. Resolve relative values against `<projectRoot>`.
- Initialize once at startup, before `stageBundledBinaries(globalAgentDir())` and before any agent/session work.
- Because `PreferencesStore` is created later today, the resolver should read `.bobbit/state/preferences.json` directly for the persisted key, or `cli.ts` should initialize the preferences store earlier. Direct read is the least invasive.
- Persisted preference key: `agentDir`. Store the normalized absolute path as a string. Store `agentDirHistory` as a string array for transcript compatibility.
- `globalAgentDir()` should return `runtimeAgentDirState.startup.dir`; it should not recompute from env after boot.
- Expose pure helpers for tests:
  - `resolveAgentDir({ env, projectRoot, persisted })`
  - `readPersistedAgentDir(stateDir)`
  - `normalizeAgentDirInput(input, projectRoot)`
  - `getAgentDirState()`
  - `recordAgentDirHistory(dir)`

Startup flow:

1. `setProjectRoot(args.cwd)`.
2. `scaffoldBobbitDir(args.cwd)` so `.bobbit/state` exists.
3. Run legacy `~/.pi/agent` -> `~/.bobbit/agent` migration as today only for that legacy rename path.
4. Initialize `AgentDirRuntimeState` from env/persisted/default and record the startup dir in `agentDirHistory`.
5. Stage binaries into `startup.dir`.
6. All runtime callers continue using `globalAgentDir()`.

## Restart-gated semantics

The running gateway has one active agent dir for its entire lifetime. Settings writes update only the persisted `agentDir` preference and recompute `nextStart` for display. They must not update `globalAgentDir()` or any mount table in-process.

Important cases:

| Startup source | User saves persisted setting | Active now | Effective after restart with same env | UI guidance |
|---|---|---|---|---|
| default | custom path | default dir | custom path | Restart required. |
| persisted | another path | old persisted path | new path | Restart required. |
| `BOBBIT_AGENT_DIR` | any persisted path | env path | env path | Env override wins; saved path will only apply after removing env and restarting. |
| `PI_CODING_AGENT_DIR` | any persisted path | legacy env path | legacy env path unless `BOBBIT_AGENT_DIR` set | Env override wins; `BOBBIT_AGENT_DIR` has higher precedence. |

`restartRequired` should mean the effective next-start directory under the current environment differs from the startup active directory. A saved setting can still be "pending" even when an env var prevents it from becoming effective.

## Path validation

Add `validateAgentDirTarget(input, projectRoot)` used by both validate and save endpoints.

Rules:

1. Input must be a non-empty string.
2. Expand `~` / `~/...` using `os.homedir()`.
3. Resolve relative paths against `<projectRoot>`.
4. Normalize to an absolute path with platform-native separators for storage and display.
5. Determine the git worktree root with `git rev-parse --show-toplevel` from `<projectRoot>`; if git is unavailable, fall back to `<projectRoot>`.
6. Reject targets inside the git worktree, except the exact allowed default `<projectRoot>/.bobbit/agent/` and paths nested inside it. This prevents accidentally storing credentials in source-controlled project files while preserving the intended safe local default.
7. Create the target directory with mode `0700` where supported.
8. Verify it is a directory.
9. Verify read/write access by creating, reading, and deleting a small temp probe file inside it.
10. Return structured errors with a stable `code`, human message, raw input, and resolved path when available.

Suggested error codes: `EMPTY_PATH`, `INSIDE_WORKTREE`, `CREATE_FAILED`, `NOT_DIRECTORY`, `ACCESS_DENIED`, `PROBE_FAILED`.

## API endpoints

Add dedicated endpoints rather than overloading generic preferences, because validation, migration, and restart guidance are domain-specific.

### `GET /api/agent-dir`

Returns runtime and pending state:

```json
{
  "active": { "path": "...", "source": "default|persisted|BOBBIT_AGENT_DIR|PI_CODING_AGENT_DIR" },
  "defaultPath": "<projectRoot>/.bobbit/agent",
  "persistedPath": "... or null",
  "pendingPath": "... or null",
  "nextStart": { "path": "...", "source": "..." },
  "restartRequired": true,
  "envOverride": { "name": "BOBBIT_AGENT_DIR", "path": "..." } | null,
  "history": ["..."]
}
```

### `POST /api/agent-dir/validate`

Body: `{ "path": "..." }`. Runs validation and returns `{ ok, resolvedPath, error? }`. It may create the directory because validation requires proving access.

### `PUT /api/agent-dir/pending`

Body: `{ "path": "..." }`, with `null` or empty string meaning "clear persisted setting and use default/env precedence". On non-empty input, validate before saving. Save `agentDir` in preferences, append the previous active dir and new resolved dir to `agentDirHistory`, broadcast `preferences_changed` or a new `agent_dir_changed` event, and return the same shape as `GET /api/agent-dir` plus a restart guidance message.

### `POST /api/agent-dir/migrate`

Body:

```json
{
  "sourcePath": "active path or explicit historical path",
  "destinationPath": "pending path",
  "overwrite": false
}
```

Server constraints:

- Source and destination must be resolved/validated directories.
- Destination should normally equal the currently persisted pending dir; allow explicit destination only if it validates, then return a warning that it is not effective until saved/restarted.
- Never delete or move the source.
- Copy only the allowlist:
  - `sessions/`
  - `auth.json`
  - `models.json`
  - `settings.json`
  - `google-code-assist.json`
  - `bin/`
- Recursive directories merge by file. Existing destination files are skipped unless `overwrite: true`.
- Preserve file modes where practical, especially `auth.json` (`0600`) and directory modes (`0700`).
- Do not follow symlinks blindly. Prefer copying symlinks as symlinks or skipping them with a reported warning; never dereference a symlink that points outside the selected source tree.
- Return counts: copied, skippedExisting, overwritten, missingSourceItems, warnings, errors.

## Settings UI

Add an Advanced section under system Settings, preferably `Settings -> Maintenance` or a new `Settings -> Advanced` tab. The UI should:

- Load `GET /api/agent-dir` on render.
- Show:
  - active directory path;
  - startup source;
  - default directory;
  - persisted pending directory;
  - effective next-start directory;
  - whether restart is required;
  - any env override and its precedence impact.
- Provide a path input with "Validate" and "Save for next restart" actions.
- Show validation errors inline before save.
- After saving, show clear restart guidance: "Active now: X. After restart: Y." If an env override wins, say: "After restart with current environment, Bobbit will still use X. Remove BOBBIT_AGENT_DIR/PI_CODING_AGENT_DIR to use Y."
- Provide a migration card when `pendingPath` exists and differs from `active.path`:
  - Source: active directory.
  - Destination: pending directory.
  - Checklist of copy items.
  - Default mode skips existing destination files.
  - Optional explicit "Overwrite existing files" checkbox.
  - Run copy via `POST /api/agent-dir/migrate`.
  - Display copied/skipped/overwritten counts and missing items.
  - Repeat restart guidance after migration.
- Do not imply live switching. Avoid labels like "Use now".
- The existing harness restart button can be reused when available; otherwise tell the user to restart the Bobbit server manually.

## Sandbox credential safety

The configurable agent dir must not widen sandbox access.

- Keep mounting only `<activeAgentDir>/sessions` into `/home/node/.bobbit/agent/sessions`.
- Keep mounting `<activeAgentDir>/models.json` read-only if it exists.
- Never mount `<activeAgentDir>` as a whole.
- Never mount `<activeAgentDir>/auth.json` into a sandbox.
- Continue generating scoped sandbox auth files under `.bobbit/state/sandbox-agent-auth/*.auth.json` via `host-tokens.ts`, with only sanitized credentials allowed by sandbox token policy.
- Keep `.bobbit/state` root unmounted; only selected subdirectories remain mounted (`sessions`, `tool-guard`, `html-snapshots`, `google-code-assist` read-only).
- Ensure `rpc-bridge.ts::buildMountTable()` remains in sync with `docker-args.ts`; both should use the startup-resolved active sessions root.

## Transcript compatibility strategy

Existing persisted sessions store `agentSessionFile` as an absolute path. That path must remain readable after migration and future config changes.

Implementation strategy:

1. Treat a non-empty absolute `PersistedSession.agentSessionFile` as authoritative for reads, continues, sidecar lookup, and UI transcript recovery. Do not rewrite it during migration.
2. New sessions write new absolute paths under the startup active `<agentDir>/sessions`.
3. Record `agentDirHistory` in preferences. Add the startup active dir at boot and source/destination dirs after every save/migration. Seed history with the legacy defaults `~/.bobbit/agent` and `~/.pi/agent` for backward recovery.
4. Change transcript recovery scans to consider ordered roots: active sessions root, historical sessions roots, then default/legacy roots. Stop at the first matching session id / timestamp match.
5. Update transcript sanitizer path guards to accept:
   - paths inside any trusted historical `<agentDir>/sessions` root; and
   - exact absolute `agentSessionFile` paths that came from persisted session records.
   Keep the existing no-`..`, realpath, parent-directory, regular-file, and no-final-symlink checks.
6. For sandboxed container paths, continue translating `/home/node/.bobbit/agent/sessions/...` through the active mount table. Historical sandbox paths should normally be host absolute paths in `agentSessionFile`; if not, the session can only be recovered while its original mount is active.

This avoids live multi-root runtime behavior for new writes while preserving read compatibility for old absolute transcript paths.

## Migration behavior details

Migration is user-initiated copy-only. It must never run silently at startup and must never delete, rename, or modify the source directory.

Default copy policy:

- `sessions/`: recursive merge; skip existing destination transcript/sidecar files.
- `auth.json`: copy if absent; preserve `0600` where supported.
- `models.json`: copy if absent.
- `settings.json`: copy if absent.
- `google-code-assist.json`: copy if absent.
- `bin/`: recursive merge; skip existing files by default.

If overwrite is selected, overwrite only files in the allowlist. Existing destination files outside the allowlist are untouched.

Return a migration report suitable for display and tests:

```ts
interface AgentDirMigrationReport {
  sourcePath: string;
  destinationPath: string;
  overwrite: boolean;
  copied: string[];
  skippedExisting: string[];
  overwritten: string[];
  missing: string[];
  warnings: string[];
  errors: Array<{ path: string; message: string }>;
}
```

## Regression test plan

| Phase | File | Coverage |
|---|---|---|
| unit | `tests/bobbit-dir-agent-dir.test.ts` | Pure resolver precedence: `BOBBIT_AGENT_DIR` > `PI_CODING_AGENT_DIR` > persisted > default; `~` expansion; relative paths against project root; startup resolver does not recompute when env changes after initialization. |
| unit | `tests/agent-dir-validation.test.ts` | Path validation accepts default `<projectRoot>/.bobbit/agent`; rejects other paths inside git worktree; creates target dir; verifies read/write; handles invalid/missing permissions with structured errors. |
| unit | `tests/agent-dir-settings-api.test.ts` or API E2E if using full server | Save pending setting persists `agentDir`, reports active vs next-start, and stays restart-gated: `globalAgentDir()` remains startup value until simulated restart. Env override response shows saved setting is not effective under current env. |
| unit | `tests/agent-dir-migration.test.ts` | Copy allowlist only; recursively merges `sessions/` and `bin/`; skips existing by default; overwrites only when requested; copies `auth.json`, `models.json`, `settings.json`, `google-code-assist.json`; preserves source. |
| unit | `tests/docker-args.test.ts` | Sandbox mounts use configured active sessions root and optional read-only `models.json`; host `auth.json` is never mounted; scoped sandbox auth file is still mounted read-only. |
| unit | `tests/container-path-translation.test.ts` | `/home/node/.bobbit/agent/sessions` maps to configured active sessions root, not hard-coded home default; round trip remains stable. |
| unit | `tests/transcript-sanitizer.test.ts` | Sanitizer accepts active and historical sessions roots, rejects traversal/symlink/outside paths, and can safely process an exact persisted absolute `agentSessionFile` after active dir changes. |
| unit | `tests/session-recovery-agent-dir.test.ts` | `recoverSessionFile()` scans active plus historical roots and keeps existing absolute `agentSessionFile` paths readable after migration. |
| e2e | `tests/e2e/agent-dir-settings.spec.ts` | REST flow: GET state, validate, save pending, restart-gated active dir, migration copy report. Use isolated project/state dirs. |
| browser e2e | `tests/e2e/ui/settings-agent-dir.spec.ts` | Settings Advanced UI shows active/source/pending/next-start; validation error display; save shows restart guidance; migration card copies with skip/overwrite messaging; reload preserves pending state. |
| existing unit | `tests/cost-backfill*.test.ts`, `tests/continue-archived-clone.test.ts`, `tests/session-store-orphan-cleanup.test.ts` | Update expectations only where paths are explicitly defaulted; add cases for historical roots rather than weakening existing assertions. |

## Non-goals

- No live switching of the running process.
- No concurrent multi-root writes.
- No automatic project-default migration at startup.
- No deletion or movement of old agent directories.
- No expansion of sandbox credential access.
