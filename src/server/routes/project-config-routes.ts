// src/server/routes/project-config-routes.ts
//
// STR-01 cohort 2: the per-project config family —
// GET/PUT /api/projects/:id/config, GET /api/projects/:id/config/defaults,
// GET /api/projects/:id/config/resolved — migrated out of handleApiRoute's
// legacy if/else chain into the core route registry. See
// docs/design/route-registry.md (cohort 1 established the seam + protocol).
//
// Mechanical extraction — every handler body below is byte-for-byte the same
// logic as the `if (projectConfigMatch) { ... }` block it replaced in
// server.ts, with the same mechanical substitutions as cohort 1
// (regex capture → `params.id`; handleApiRoute params/closures → `ctx`).
// Zero behavior change: same validation order, same status codes, same
// error shapes.
//
// LEGACY FALL-THROUGH PARITY (the one subtlety in this family): the legacy
// block matched the PATH first (`if (projectConfigMatch)`), resolved the
// project context (404 "Project not found" when missing) and only THEN
// branched on method/suffix — an unhandled combination (e.g. DELETE
// /api/projects/:id/config, PUT .../config/defaults) fell out of the block
// and continued down the whole remaining legacy chain to its terminal
// `json({ error: "Not found" }, 404)` (verified: no other matcher in the
// chain or the delegate route modules matches an /api/projects/:id/config*
// path). A method-keyed registry can't "fall through after matching", so
// those method/path combinations are registered explicitly against a shim
// (`handleUnhandledMethod`) that reproduces the exact same terminal
// behavior: 404 "Project not found" when the project doesn't resolve,
// otherwise 404 "Not found".
//
// The five sandbox-secret helpers below (redactSandboxSecrets,
// redactSandboxSecretsResolved, mergeSecretsIntoTokens,
// mergeSandboxTokensStructured, mergeSandboxSecrets) moved here verbatim
// from server.ts module scope — this family holds their ONLY call sites.
// LEGACY_QA_TOP_LEVEL_KEYS stays in server.ts (PUT /api/project-config — a
// NOT-yet-migrated legacy route — also uses it) and flows through
// `ctx.legacyQaTopLevelKeys`; the server-level ProjectConfigStore flows
// through `ctx.serverProjectConfigStore` (needed by the "resolved" view's
// project→server→default source cascade).
//
// NOT migrated in this cohort: GET /api/projects/:id/qa-testing-config
// (unrelated feature that merely shares the path shape — same exclusion as
// cohort 1) and the server-level /api/project-config trio (its PUT handler
// is lexically adjacent to the marketplace block being migrated in a
// parallel cohort; kept out to stay conflict-free).

import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { RouteTable } from "./route-table.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import { resolveScalarConfig } from "../agent/config-resolver.js";
import { isGitRepo } from "../skills/git.js";

const execFileAsync = promisify(execFileCb);

/** Redact token values in sandbox config for API responses. Never send real secrets to the browser.
 *  `sandbox_tokens` is a structured array (post-native-YAML); other fields stay flat strings. */
function redactSandboxSecrets(config: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...config };
	if (Array.isArray(result.sandbox_tokens)) {
		result.sandbox_tokens = (result.sandbox_tokens as Array<any>).map((e: any) => ({
			...e,
			value: e.value ? "__REDACTED__" : "",
		}));
	}
	if (typeof result.sandbox_credentials === "string" && result.sandbox_credentials) {
		try {
			const obj = JSON.parse(result.sandbox_credentials);
			if (typeof obj === "object" && obj !== null) {
				const redacted: Record<string, string> = {};
				for (const [k, v] of Object.entries(obj)) {
					redacted[k] = v ? "__REDACTED__" : "";
				}
				result.sandbox_credentials = JSON.stringify(redacted);
			}
		} catch { /* leave as-is */ }
	}
	return result;
}

/** Redact token values in resolved config (with source annotations).
 *  `sandbox_tokens.value` is now a structured array; sandbox_credentials remains a JSON string. */
function redactSandboxSecretsResolved(config: Record<string, { value: unknown; source: string }>): Record<string, { value: unknown; source: string }> {
	const result = { ...config };
	if (result.sandbox_tokens && Array.isArray(result.sandbox_tokens.value)) {
		result.sandbox_tokens = {
			...result.sandbox_tokens,
			value: (result.sandbox_tokens.value as Array<any>).map((e: any) => ({
				...e,
				value: e.value ? "__REDACTED__" : "",
			})),
		};
	}
	for (const key of ["sandbox_credentials"] as const) {
		if (!result[key]) continue;
		const entry = { ...result[key] };
		if (key === "sandbox_credentials" && typeof entry.value === "string" && entry.value) {
			try {
				const obj = JSON.parse(entry.value);
				if (typeof obj === "object" && obj !== null) {
					const redacted: Record<string, string> = {};
					for (const [k, v] of Object.entries(obj)) {
						redacted[k] = v ? "__REDACTED__" : "";
					}
					entry.value = JSON.stringify(redacted);
					result[key] = entry;
				}
			} catch { /* leave as-is */ }
		}
	}
	return result;
}

/** Merge secrets into sandbox_tokens for GET responses (adds value from SecretsStore).
 *  Operates on a config object whose `sandbox_tokens` is the structured array (or absent). */
function mergeSecretsIntoTokens(config: Record<string, unknown>, secretsStore: import("../agent/secrets-store.js").SecretsStore): void {
	const tokens = config.sandbox_tokens;
	if (!Array.isArray(tokens)) return;
	const secrets = secretsStore.getAll();
	config.sandbox_tokens = (tokens as Array<any>).map((e: any) => ({
		...e,
		value: secrets[e.key] || e.value || "",
	}));
}

/** Strip redacted sentinel from incoming structured sandbox_tokens, persisting real values
 *  to the SecretsStore. Returns the structured array suitable for setSandboxTokens(). */
function mergeSandboxTokensStructured(
	incoming: Array<{ key: string; enabled?: boolean; value?: string }>,
	secretsStore?: import("../agent/secrets-store.js").SecretsStore | null,
): Array<{ key: string; enabled: boolean }> {
	if (secretsStore) {
		const updates: Record<string, string> = {};
		for (const e of incoming) {
			if (!e || typeof e.key !== "string") continue;
			if (e.value === "__REDACTED__") {
				// Keep existing
			} else if (e.value) {
				updates[e.key] = e.value;
			} else {
				updates[e.key] = "";
			}
		}
		secretsStore.update(updates);
	}
	return incoming
		.filter(e => e && typeof e.key === "string")
		.map(e => ({ key: e.key, enabled: e.enabled !== false }));
}

/** Merge redacted sentinel values with existing stored values before saving. */
function mergeSandboxSecrets(updates: Record<string, string>, configStore: import("../agent/project-config-store.js").ProjectConfigStore, secretsStore?: import("../agent/secrets-store.js").SecretsStore | null): void {
	// sandbox_tokens is now handled via mergeSandboxTokensStructured at the
	// migrated-fields layer in the PUT handler. This helper only handles the
	// remaining legacy flat sandbox_credentials key.
	void configStore;
	void secretsStore;
	if (updates.sandbox_credentials) {
		try {
			const incoming = JSON.parse(updates.sandbox_credentials) as Record<string, string>;
			const existingRaw = configStore.get("sandbox_credentials") || "";
			let existingObj: Record<string, string> = {};
			try { existingObj = existingRaw ? JSON.parse(existingRaw) : {}; } catch { /* ignore */ }
			for (const [k, v] of Object.entries(incoming)) {
				if (v === "__REDACTED__") {
					incoming[k] = existingObj[k] || "";
				}
			}
			updates.sandbox_credentials = JSON.stringify(incoming);
		} catch { /* leave as-is */ }
	}
}

// GET /api/projects/:id/config
async function handleProjectConfigGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectContextManager } = ctx;
	const c = projectContextManager.getOrCreate(params.id);
	if (!c) { json({ error: "Project not found" }, 404); return; }
	const flat = c.projectConfigStore.getAll();
	// Upgrade migrated keys to native structured form for the wire response.
	const config: Record<string, unknown> = { ...flat };
	config.config_directories = c.projectConfigStore.getConfigDirectories();
	config.sandbox_tokens = c.projectConfigStore.getSandboxTokens();
	// Defence in depth: legacy top-level qa_* keys must never appear on
	// the wire. Migration removes them on boot; strip again here in case
	// a stale on-disk value slipped through.
	for (const k of ctx.legacyQaTopLevelKeys) delete config[k];
	mergeSecretsIntoTokens(config, c.secretsStore);
	json(redactSandboxSecrets(config));
}

// GET /api/projects/:id/config/defaults
async function handleProjectConfigDefaults(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectContextManager } = ctx;
	const c = projectContextManager.getOrCreate(params.id);
	if (!c) { json({ error: "Project not found" }, 404); return; }
	json(c.projectConfigStore.getDefaults());
}

// GET /api/projects/:id/config/resolved
async function handleProjectConfigResolved(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectContextManager, serverProjectConfigStore } = ctx;
	const c = projectContextManager.getOrCreate(params.id);
	if (!c) { json({ error: "Project not found" }, 404); return; }
	const defaults = c.projectConfigStore.getDefaults();
	const result: Record<string, { value: unknown; source: string }> = {};
	// Include all default keys
	for (const key of Object.keys(defaults)) {
		result[key] = resolveScalarConfig(key, c.projectConfigStore, serverProjectConfigStore, null, defaults);
	}
	// Also include custom keys from the project's own config that aren't in defaults
	const rawConfig = c.projectConfigStore.getAll();
	for (const key of Object.keys(rawConfig)) {
		if (!(key in result)) {
			result[key] = { value: rawConfig[key], source: "project" };
		}
	}
	// Include custom keys from the server-level config that aren't already covered
	const serverRaw = serverProjectConfigStore.getAll();
	for (const key of Object.keys(serverRaw)) {
		if (!(key in result)) {
			result[key] = { value: serverRaw[key], source: "server" };
		}
	}
	// Override migrated fields with structured values (resolveScalarConfig returns flat strings).
	const migratedSource = (key: string): string => {
		return (rawConfig[key] !== undefined && rawConfig[key] !== "") ? "project"
			: (serverRaw[key] !== undefined && serverRaw[key] !== "") ? "server"
			: "default";
	};
	result.config_directories = { value: c.projectConfigStore.getConfigDirectories(), source: migratedSource("config_directories") };
	result.sandbox_tokens = { value: c.projectConfigStore.getSandboxTokens(), source: migratedSource("sandbox_tokens") };
	// Defence in depth: strip legacy top-level qa_* keys.
	for (const k of ctx.legacyQaTopLevelKeys) delete result[k];
	// Merge secrets into sandbox_tokens (structured) for the resolved response.
	if (Array.isArray(result.sandbox_tokens.value)) {
		const tempConfig: Record<string, unknown> = { sandbox_tokens: result.sandbox_tokens.value };
		mergeSecretsIntoTokens(tempConfig, c.secretsStore);
		result.sandbox_tokens = { value: tempConfig.sandbox_tokens, source: result.sandbox_tokens.source };
	}
	json(redactSandboxSecretsResolved(result));
}

// PUT /api/projects/:id/config
async function handleProjectConfigPut(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { req, json, readBody, projectContextManager } = ctx;
	const c = projectContextManager.getOrCreate(params.id);
	if (!c) { json({ error: "Project not found" }, 404); return; }
	const body = await readBody(req);
	if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }

	// Reject legacy top-level qa_* keys — they have moved into
	// `components[<name>].config`. Done before any other parsing so the
	// error is fast and unambiguous.
	for (const key of ctx.legacyQaTopLevelKeys) {
		if (key in (body as Record<string, unknown>)) {
			json({ error: `${key} settings have moved to components[].config[]; set components[<name>].config.${key} instead` }, 400);
			return;
		}
	}

	// Validate components[].config eagerly (mirrors propose_project tool).
	{
		const err = ctx.validateComponentsConfig((body as Record<string, unknown>).components);
		if (err) { json({ error: err }, 400); return; }
	}

	// `base_ref` validation — runs only when the field is present in the PUT body.
	// On any failure we return HTTP 400 with `{ field: "base_ref", error, details? }`
	// so the Settings UI can render the error inline. Non-fatal warnings (component
	// paths that aren't git repos) bubble up via `baseRefWarnings` and are attached
	// to the success response below. See docs/design/base-ref.md.
	const baseRefWarnings: string[] = [];
	if ("base_ref" in (body as Record<string, unknown>)) {
		const rawBaseRef = (body as Record<string, unknown>).base_ref;
		const baseRefValue = typeof rawBaseRef === "string" ? rawBaseRef.trim() : "";
		if (baseRefValue) {
			// 1. SHA shape (7-40 hex chars). Reject before grammar — a 40-char hex
			//    string is grammatically valid but is rejected for clarity.
			if (/^[0-9a-f]{7,40}$/i.test(baseRefValue)) {
				json({ field: "base_ref", error: `base_ref must be a branch ref, not a commit SHA. Got: ${baseRefValue}` }, 400);
				return;
			}
			// 2. Invalid branch grammar.
			if (!ctx.isValidBaseRefBranchGrammar(baseRefValue)) {
				json({ field: "base_ref", error: `base_ref must be a valid branch name. Got: ${baseRefValue}` }, 400);
				return;
			}
			// 3. Non-origin remote prefix. Anything matching `<prefix>/<rest>` where
			//    `<prefix>` is not `origin` is rejected. Local refs (no slash, or
			//    `feature/foo`) are still accepted — the prefix gate only fires when
			//    the first segment looks like a remote name and isn't `origin`.
			//    We treat the first slash-segment as a remote prefix only when the
			//    full value is exactly `<prefix>/<rest>` AND `<rest>` looks like a
			//    branch (rather than e.g. `feature/foo` which has no remote prefix at all).
			//    Practically: if the value starts with anything other than `origin/`
			//    AND the first segment is a known-remote-shaped token, reject.
			//    We use a simple heuristic: if it doesn't start with `origin/` and
			//    its first segment contains no special chars and a slash exists,
			//    treat it as a remote prefix. The error message names the value
			//    so users can correct it.
			//
			// To avoid false positives on local refs like `feature/foo`, we only
			// reject values whose first segment matches the set of typical
			// remote names (upstream/fork/etc.). Today's design says: anything
			// with a remote-style prefix other than `origin/` is rejected, but
			// distinguishing local `feature/foo` from remote `upstream/foo`
			// requires git knowledge we don't have at validate time. The design
			// doc's error inventory specifically calls out `upstream/main` as the
			// example to reject — so we use a conservative allowlist: anything
			// matching a known remote-name pattern that isn't `origin` is rejected.
			// Known remote-shaped tokens: upstream, fork, mirror, github, gitlab,
			// bitbucket. Everything else flows through (local branches with slashes).
			const firstSegment = baseRefValue.split("/")[0];
			const KNOWN_NON_ORIGIN_REMOTES = new Set(["upstream", "fork", "mirror", "github", "gitlab", "bitbucket", "remote"]);
			if (baseRefValue.includes("/") && firstSegment !== "origin" && KNOWN_NON_ORIGIN_REMOTES.has(firstSegment)) {
				json({ field: "base_ref", error: `base_ref only supports the 'origin' remote today. Got: ${baseRefValue}. If you need a different primary remote, configure it as 'origin' in your local clone.` }, 400);
				return;
			}
			// 4. Sandbox + local — when the project runs in a docker sandbox, only
			//    remote refs work because the container has separate ref visibility
			//    from the host.
			const sandboxResolved = c.projectConfigStore.getWithDefaults().sandbox || "none";
			if (sandboxResolved === "docker" && !baseRefValue.startsWith("origin/")) {
				json({ field: "base_ref", error: `base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: ${baseRefValue}` }, 400);
				return;
			}
			// 5. Multi-repo ref existence — `git rev-parse --verify` against every
			//    component repo. Also detect tags up-front: a value that resolves
			//    via `refs/tags/<value>` in ANY component is rejected as a tag.
			const componentsForCheck = c.projectConfigStore.getComponents();
			const componentsToCheck = componentsForCheck.length > 0
				? componentsForCheck
				: [{ name: c.project.name || "default", repo: "." }];
			const failures: Array<{ component: string; message: string }> = [];
			let checkedRepoCount = 0;
			let tagDetected = false;
			for (const comp of componentsToCheck) {
				const repoPath = path.join(c.project.rootPath, comp.repo);
				const gitRepoCheck = await isGitRepo(repoPath).catch(() => false);
				if (!gitRepoCheck) {
					baseRefWarnings.push(`base_ref validation skipped for component '${comp.name}': not a git repo at ${repoPath}`);
					continue;
				}
				checkedRepoCount++;
				// Tag check first — if the value resolves as a tag in any component
				// repo, fail with the tag-specific message rather than the generic
				// "not present" error.
				try {
					await execFileAsync("git", ["rev-parse", "--verify", `refs/tags/${baseRefValue}`], { cwd: repoPath, timeout: 5_000 });
					tagDetected = true;
					break;
				} catch {
					// Not a tag in this repo — continue with branch-ref check below.
				}
				try {
					await execFileAsync("git", ["rev-parse", "--verify", baseRefValue], { cwd: repoPath, timeout: 5_000 });
				} catch {
					failures.push({
						component: comp.name,
						message: `ref not found. Try: cd ${comp.repo} && git fetch origin`,
					});
				}
			}
			if (tagDetected) {
				json({ field: "base_ref", error: `base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: ${baseRefValue}` }, 400);
				return;
			}
			if (failures.length > 0) {
				json({
					field: "base_ref",
					error: `base_ref '${baseRefValue}' is not present in ${failures.length} of ${checkedRepoCount} component repos`,
					details: failures,
				}, 400);
				return;
			}
		}
	}

	// Extract structured fields (components / workflows) before flat-key validation.
	let components = (body as Record<string, unknown>).components;
	const workflows = (body as Record<string, unknown>).workflows;
	delete (body as Record<string, unknown>).components;
	delete (body as Record<string, unknown>).workflows;

	// Back-compat: legacy top-level *_command fields (build_command, test_command, etc.)
	// are folded into components[0].commands when no `components` field was supplied.
	// This keeps the propose_project tool, the project assistant, and the provisional
	// promotion path working after Follow-up A removed the legacy schema. Existing
	// components stored on disk are not modified — callers who want to update components
	// must pass a fresh `components` array. See multi-repo follow-up Issue 2 / Issue 5.
	if (!Array.isArray(components)) {
		const LEGACY_KEY_MAP: Record<string, string> = {
			build_command: "build",
			test_command: "test",
			typecheck_command: "check",
			test_unit_command: "unit",
			test_e2e_command: "e2e",
		};
		const legacyCmds: Record<string, string> = {};
		for (const [legacyKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
			const v = (body as Record<string, unknown>)[legacyKey];
			if (typeof v === "string" && v.trim().length > 0) legacyCmds[newKey] = v.trim();
		}
		const legacyHook = (body as Record<string, unknown>).worktree_setup_command;
		const hasAnyLegacy = Object.keys(legacyCmds).length > 0
			|| (typeof legacyHook === "string" && legacyHook.trim().length > 0);
		if (hasAnyLegacy) {
			const existing = c.projectConfigStore.getComponents();
			const defaultName = existing[0]?.name || c.project.name || "default";
			const defaultRepo = existing[0]?.repo || ".";
			const mergedCommands = { ...(existing[0]?.commands ?? {}), ...legacyCmds };
			const defaultComponent: Record<string, unknown> = {
				name: defaultName,
				repo: defaultRepo,
				commands: mergedCommands,
			};
			if (existing[0]?.relativePath) defaultComponent.relative_path = existing[0].relativePath;
			const hookValue = (typeof legacyHook === "string" && legacyHook.trim().length > 0)
				? legacyHook.trim()
				: existing[0]?.worktreeSetupCommand;
			if (hookValue) defaultComponent.worktree_setup_command = hookValue;
			// Preserve existing per-component config (qa_* keys etc.) — the legacy
			// flat-key write path must not silently wipe it.
			if (existing[0]?.config && Object.keys(existing[0].config).length > 0) {
				defaultComponent.config = { ...existing[0].config };
			}
			// Replace the first component but preserve any additional components on disk.
			const remaining = existing.slice(1).map(comp => {
				const entry: Record<string, unknown> = { name: comp.name, repo: comp.repo };
				if (comp.relativePath) entry.relative_path = comp.relativePath;
				if (comp.worktreeSetupCommand) entry.worktree_setup_command = comp.worktreeSetupCommand;
				if (comp.commands) entry.commands = comp.commands;
				if (comp.config && Object.keys(comp.config).length > 0) entry.config = { ...comp.config };
				return entry;
			});
			components = [defaultComponent, ...remaining];
		}
		// Legacy flat keys remain in `body` so they are ALSO written as legacy
		// flat-config entries (preserves GET round-trip for existing API clients
		// that only know the legacy schema). The structural components mirror is
		// the source of truth for workflow steps and the Components UI.
	}

	// Validate ALL flat keys before writing ANY (atomic: all-or-nothing)
	for (const [key] of Object.entries(body)) {
		if (key.includes(".")) {
			json({ error: `Config key "${key}" must not contain dots` }, 400);
			return;
		}
	}

	// Validate workflows structurally if both components and workflows are present.
	if (components && workflows && Array.isArray(components) && typeof workflows === "object") {
		try {
			const { validateAllWorkflows } = await import("../agent/workflow-validator.js");
			const errors = validateAllWorkflows(
				workflows as Parameters<typeof validateAllWorkflows>[0],
				components as Parameters<typeof validateAllWorkflows>[1],
			);
			if (errors.length > 0) {
				json({ error: "Workflow validation failed", details: errors }, 400);
				return;
			}
		} catch (err) {
			console.warn("[server] workflow validation skipped:", err);
		}
	}

	// Native-YAML migrated fields: reject legacy string payloads (must be structured
	// types or null/empty to clear). For sandbox_tokens we still need to merge
	// redacted values via mergeSandboxSecrets; the merge helper now operates on
	// structured arrays.
	const migratedExtracted: Record<string, unknown> = {};
	const MIGRATED_FIELDS = [
		{ key: "config_directories", expect: "array" as const },
		{ key: "sandbox_tokens", expect: "array" as const },
	];
	for (const { key, expect } of MIGRATED_FIELDS) {
		if (!(key in body)) continue;
		const v = (body as Record<string, unknown>)[key];
		if (v === null || v === "") {
			migratedExtracted[key] = null;
			delete (body as Record<string, unknown>)[key];
			continue;
		}
		if (typeof v === "string") {
			json({ error: `Field "${key}" must be sent as a structured ${expect}, not a JSON-encoded string` }, 400);
			return;
		}
		if (expect === "array" && !Array.isArray(v)) {
			json({ error: `Field "${key}" must be an array` }, 400);
			return;
		}
		migratedExtracted[key] = v;
		delete (body as Record<string, unknown>)[key];
	}

	// Merge secrets for migrated structured sandbox_tokens, and for any legacy
	// keys that still carry inline credentials (sandbox_credentials).
	if (Array.isArray(migratedExtracted.sandbox_tokens)) {
		migratedExtracted.sandbox_tokens = mergeSandboxTokensStructured(
			migratedExtracted.sandbox_tokens as Array<{ key: string; enabled?: boolean; value?: string }>,
			c.secretsStore,
		);
	}
	mergeSandboxSecrets(body as Record<string, string>, c.projectConfigStore, c.secretsStore);

	// Write legacy flat keys.
	for (const [key, value] of Object.entries(body)) {
		if (value === null || value === "") {
			c.projectConfigStore.remove(key);
		} else if (typeof value === "string") {
			c.projectConfigStore.set(key, value);
		}
	}

	// Apply migrated structured fields via typed setters.
	if ("config_directories" in migratedExtracted) {
		const v = migratedExtracted.config_directories;
		if (v === null) {
			c.projectConfigStore.remove("config_directories");
		} else if (Array.isArray(v)) {
			c.projectConfigStore.setConfigDirectories(
				v.filter((e: any) => e && typeof e === "object" && typeof e.path === "string").map((e: any) => ({
					path: String(e.path),
					types: Array.isArray(e.types) ? e.types.filter((t: unknown): t is string => typeof t === "string") : [],
				})),
			);
		}
	}
	if ("sandbox_tokens" in migratedExtracted) {
		const v = migratedExtracted.sandbox_tokens;
		if (v === null) {
			c.projectConfigStore.remove("sandbox_tokens");
		} else if (Array.isArray(v)) {
			c.projectConfigStore.setSandboxTokens(
				v.filter((e: any) => e && typeof e === "object" && typeof e.key === "string").map((e: any) => ({
					key: String(e.key),
					enabled: e.enabled !== false,
				})),
			);
		}
	}

	// Persist structured fields if provided.
	if (Array.isArray(components)) {
		const normalized = (components as Array<Record<string, unknown>>).map(comp => ({
			name: String(comp.name ?? ""),
			repo: typeof comp.repo === "string" && comp.repo ? comp.repo : ".",
			relativePath: typeof comp.relative_path === "string" ? comp.relative_path : (typeof comp.relativePath === "string" ? comp.relativePath as string : undefined),
			worktreeSetupCommand: typeof comp.worktree_setup_command === "string" ? comp.worktree_setup_command : (typeof comp.worktreeSetupCommand === "string" ? comp.worktreeSetupCommand as string : undefined),
			commands: comp.commands && typeof comp.commands === "object" && !Array.isArray(comp.commands) ? comp.commands as Record<string, string> : undefined,
			config: comp.config && typeof comp.config === "object" && !Array.isArray(comp.config) ? comp.config as Record<string, string> : undefined,
		}));
		c.projectConfigStore.setComponents(normalized);
	}
	if (workflows && typeof workflows === "object" && !Array.isArray(workflows)) {
		c.projectConfigStore.setWorkflows(workflows as Record<string, import("../agent/project-config-store.js").InlineWorkflowDef>);
	}

	if (baseRefWarnings.length > 0) {
		json({ ok: true, warnings: baseRefWarnings });
		return;
	}
	json({ ok: true });
}

// See LEGACY FALL-THROUGH PARITY in the module header: matched-path,
// unhandled-method combinations reproduce the legacy block's terminal
// behavior exactly — project-context lookup first (404 "Project not found"
// when the project doesn't resolve, as the legacy block did before its
// method branches), otherwise the legacy chain's terminal 404 "Not found".
async function handleUnhandledMethod(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectContextManager } = ctx;
	const c = projectContextManager.getOrCreate(params.id);
	if (!c) { json({ error: "Project not found" }, 404); return; }
	json({ error: "Not found" }, 404);
}

export function registerProjectConfigRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/projects/:id/config", handleProjectConfigGet);
	table.register("PUT", "/api/projects/:id/config", handleProjectConfigPut);
	table.register("GET", "/api/projects/:id/config/defaults", handleProjectConfigDefaults);
	table.register("GET", "/api/projects/:id/config/resolved", handleProjectConfigResolved);
	// Legacy fall-through parity shims (see module header). POST/PATCH/DELETE
	// on all three paths, plus PUT on the read-only defaults/resolved views.
	// Written as literal register("METHOD", "pattern") calls — NOT a loop —
	// so tests/helpers/server-route-surface.ts's extractRegistryRoutes()
	// (which scans for literal method/pattern arguments) sees the complete
	// registered surface.
	table.register("POST", "/api/projects/:id/config", handleUnhandledMethod);
	table.register("PATCH", "/api/projects/:id/config", handleUnhandledMethod);
	table.register("DELETE", "/api/projects/:id/config", handleUnhandledMethod);
	table.register("POST", "/api/projects/:id/config/defaults", handleUnhandledMethod);
	table.register("PATCH", "/api/projects/:id/config/defaults", handleUnhandledMethod);
	table.register("DELETE", "/api/projects/:id/config/defaults", handleUnhandledMethod);
	table.register("PUT", "/api/projects/:id/config/defaults", handleUnhandledMethod);
	table.register("POST", "/api/projects/:id/config/resolved", handleUnhandledMethod);
	table.register("PATCH", "/api/projects/:id/config/resolved", handleUnhandledMethod);
	table.register("DELETE", "/api/projects/:id/config/resolved", handleUnhandledMethod);
	table.register("PUT", "/api/projects/:id/config/resolved", handleUnhandledMethod);
}
