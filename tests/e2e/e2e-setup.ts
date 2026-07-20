/**
 * Shared E2E test helpers.
 *
 * The E2E test server runs with BOBBIT_DIR pointing to an isolated temp
 * directory so it doesn't pollute the real dev-server state under .bobbit/.
 *
 * Port and bobbit dir are set dynamically per-worker by the gateway fixture
 * in gateway-harness.ts. All values are read from process.env at call time
 * (not import time) so each worker gets the right server.
 */

import { readFileSync, mkdirSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Dynamic env-backed values — read at call time, not import time.
// This lets each Playwright worker point at its own gateway instance.
// ---------------------------------------------------------------------------

function port(): string { return process.env.E2E_PORT || "3099"; }
export function base(): string { return `http://127.0.0.1:${port()}`; }
export function wsBase(): string { return `ws://127.0.0.1:${port()}`; }
export function bobbitDir(): string {
	return process.env.BOBBIT_DIR
		|| join(import.meta.dirname, "..", "..", ".e2e-bobbit");
}

/**
 * Normal harness default project root.
 *
 * Headquarters now owns the server workspace (`bobbitDir()` in E2E). The
 * compatibility "default" project used by older API tests must therefore live
 * beside the server workspace, not at it, or POST /api/projects resolves to the
 * immutable Headquarters project and workflow fixtures are seeded into the
 * wrong scope.
 */
export function harnessDefaultProjectRoot(): string {
	const root = join(dirname(bobbitDir()), `${basename(bobbitDir())}-default-project`);
	mkdirSync(root, { recursive: true });
	try { return realpathSync(root); } catch { return root; }
}

export function projectStateDirForRoot(rootPath: string): string {
	return join(rootPath, ".bobbit", "state");
}

/**
 * Live server secrets (admin token, TLS, sandbox-agent auth) now live under
 * serverSecretsDir(), which the test harnesses pin via BOBBIT_SECRETS_DIR to a
 * temp dir so they never touch the real OS home. Mirror that resolution here so
 * token readers look in the right place. Falls back to `<bobbitDir>/.secrets`
 * (the harness default) when the env is not set for this worker.
 */
export function secretsDir(): string {
	return process.env.BOBBIT_SECRETS_DIR || join(bobbitDir(), ".secrets");
}

/**
 * Backward-compatible exports. These are getters so existing code like
 *   fetch(`${BASE}/api/sessions`)
 * resolves the current worker's server on each access.
 */
export let E2E_PORT: string;
export let BASE: string;
export let WS_BASE: string;
export let E2E_BOBBIT_DIR: string;
export let E2E_PI_DIR: string; // legacy alias

// Re-define as getters on the module object. The `export let` declarations
// above create the binding slots; Object.defineProperty replaces them with
// getters that read process.env each time.
// Placeholder values — every key is immediately replaced by a getter via the
// Object.defineProperty calls below, so the initial contents are throwaway.
const _thisModule: Record<string, unknown> = { E2E_PORT: "", BASE: "", WS_BASE: "", E2E_BOBBIT_DIR: "", E2E_PI_DIR: "" };
Object.defineProperty(_thisModule, "E2E_PORT", { get: port, enumerable: true });
Object.defineProperty(_thisModule, "BASE", { get: base, enumerable: true });
Object.defineProperty(_thisModule, "WS_BASE", { get: wsBase, enumerable: true });
Object.defineProperty(_thisModule, "E2E_BOBBIT_DIR", { get: bobbitDir, enumerable: true });
Object.defineProperty(_thisModule, "E2E_PI_DIR", { get: bobbitDir, enumerable: true });

// Re-export as mutable bindings that stay in sync via a refresh trick.
// NOTE: ES module live bindings don't support external reassignment, so
// we use a different approach — the helpers below always call the functions.
// For direct `BASE` usage in tests, we set them once at import time and
// the gateway-harness sets process.env BEFORE the test files are imported.

// Set initial values from env (the gateway harness sets env before tests load)
E2E_PORT = port();
BASE = base();
WS_BASE = wsBase();
E2E_BOBBIT_DIR = bobbitDir();
E2E_PI_DIR = bobbitDir();

/**
 * A cwd that is NOT inside a git repository.
 * Used by tests to prevent worktree creation on goal/session create.
 * This avoids creating real git worktrees (slow, leaky, conflicts between
 * parallel test runs that share the same repo).
 */
const _nonGitCwdByHarnessRoot: Record<string, string> = {};
let _nonGitCwdRotation = 0;
/**
 * True if `dir`, or any ancestor up to and including `stopAt`, contains a `.git`
 * entry — i.e. `dir` sits inside a git working tree.
 */
function isInsideGitRepo(dir: string, stopAt: string): boolean {
	let cur = dir;
	for (let i = 0; i < 40; i++) {
		if (existsSync(join(cur, ".git"))) return true;
		if (cur === stopAt) break;
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return false;
}
export function nonGitCwd(): string {
	const defaultRoot = harnessDefaultProjectRoot();
	const key = `${port()}|${defaultRoot}`;
	let cwd: string | undefined = _nonGitCwdByHarnessRoot[key];
	// Self-heal cross-test poisoning: the memoized workspace is SHARED across
	// every default-project session on this worker gateway. A spec that git-inits
	// its session cwd (e.g. pr-walkthrough-pack calls setupSessionGitRepo on the
	// session's real working dir, which IS this shared nonGitCwd) turns the shared
	// dir into a git repo. The next session that reuses it would then be treated
	// as "inside a repo" → the gateway creates an unexpected worktree whose
	// checked-out tree does NOT contain this untracked workspace subdir, so a
	// later `bash_bg` spawn runs with a nonexistent cwd → "spawn bash.exe ENOENT".
	// If the cached dir has become part of a git repo, rotate to a fresh,
	// guaranteed-non-git sibling so the non-git contract is restored.
	if (cwd && isInsideGitRepo(cwd, defaultRoot)) {
		delete _nonGitCwdByHarnessRoot[key];
		cwd = undefined;
	}
	if (!cwd) {
		const suffix = _nonGitCwdRotation > 0 ? `-${_nonGitCwdRotation}` : "";
		cwd = join(defaultRoot, ".e2e-workspaces", `non-git-${port()}${suffix}`);
		// If even the freshly-named dir is somehow inside a repo, keep rotating —
		// but bounded, so a poisoned defaultRoot itself can never spin forever
		// (in that pathological case there is no non-git child; fall through and
		// let the caller surface the real problem rather than hang the worker).
		for (let tries = 0; tries < 16 && isInsideGitRepo(cwd, defaultRoot); tries++) {
			_nonGitCwdRotation++;
			cwd = join(defaultRoot, ".e2e-workspaces", `non-git-${port()}-${_nonGitCwdRotation}`);
		}
		_nonGitCwdByHarnessRoot[key] = cwd;
		_nonGitCwdRotation++;
	}
	mkdirSync(cwd, { recursive: true });
	try { return realpathSync(cwd); } catch { return cwd; }
}

/**
 * A cwd that IS a git repository (minimal, no package-lock.json).
 * Used by tests that need worktree creation (e.g. staff agents).
 */
const _gitCwdByHarnessRoot: Record<string, string> = {};
export function gitCwd(): string {
	const defaultRoot = harnessDefaultProjectRoot();
	const key = `${port()}|${defaultRoot}`;
	let cwd = _gitCwdByHarnessRoot[key];
	if (!cwd) {
		cwd = join(defaultRoot, ".e2e-workspaces", `git-${port()}-${Date.now()}`);
		_gitCwdByHarnessRoot[key] = cwd;
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "README.md"), "# E2E test repo\n");
		execFileSync("git", ["init"], { cwd, stdio: "pipe" });
		execFileSync("git", ["add", "."], { cwd, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "pipe" });
	}
	try { return realpathSync(cwd); } catch { return cwd; }
}

/**
 * Read the auth token that the test server auto-created on startup.
 *
 * The token is written once per worker by the gateway fixture (sync
 * `loadOrCreateToken()` during setup) and lives for the worker's lifetime.
 * In practice, by the time any test code calls this, the file exists.
 *
 * History note: a previous version had a 10×50ms BUSY-WAIT spin loop on
 * ENOENT under the theory that Windows FS occasionally returned ENOENT for
 * files that existed. A sync busy-wait in a worker process **blocks the
 * entire event loop**, which paradoxically made cross-test contention
 * worse — every concurrent fetch in the worker parked behind the spin.
 * This version reads once and surfaces a precise error if the file is
 * truly missing.
 */
/**
 * Synchronous token read. Kept for callers that build headers in expression
 * position (e.g. inside an object literal). Throws ENOENT immediately —
 * does NOT retry. Use `readE2ETokenAsync()` from new code; over time we'd
 * like every caller to be async so we can retry transient FS errors.
 */
function envToken(): string | undefined {
	const t = process.env.BOBBIT_TOKEN?.trim();
	return t && t.length >= 64 ? t : undefined;
}

export function readE2EToken(): string {
	// The live token lives under serverSecretsDir(); fall back to the legacy
	// Headquarters-state location for older fixtures / pre-migration boots.
	const candidates = [join(secretsDir(), "token"), join(bobbitDir(), "state", "token")];
	let lastErr: any;
	for (const p of candidates) {
		try {
			return readFileSync(p, "utf-8").trim();
		} catch (err: any) {
			lastErr = err;
			if (err?.code !== "ENOENT") throw err;
		}
	}
	const fallback = envToken();
	if (fallback) return fallback;
	if (lastErr?.code === "ENOENT") {
		throw new Error(
			`E2E token missing at ${candidates.join(" or ")}. ` +
			`Either the gateway fixture didn't write it, or process.env.BOBBIT_DIR/BOBBIT_SECRETS_DIR ` +
			`point at the wrong dir. BOBBIT_DIR=${process.env.BOBBIT_DIR ?? "<unset>"}, ` +
			`BOBBIT_SECRETS_DIR=${process.env.BOBBIT_SECRETS_DIR ?? "<unset>"}.`
		);
	}
	throw lastErr;
}

/**
 * Async token read with bounded retry. Retries ENOENT/EBUSY/EPERM/EACCES
 * for ~150ms total — covers Windows Defender lock windows on freshly-
 * written files without masking real configuration mistakes.
 *
 * Prefer this over `readE2EToken()` from any code path that already runs
 * inside an `async` function (which is essentially every test).
 */
export async function readE2ETokenAsync(): Promise<string> {
	// Live token under serverSecretsDir(), legacy Headquarters-state fallback.
	const candidates = [join(secretsDir(), "token"), join(bobbitDir(), "state", "token")];
	let lastErr: any;
	for (let attempt = 0; attempt < 6; attempt++) {
		for (const p of candidates) {
			try {
				return readFileSync(p, "utf-8").trim();
			} catch (err: any) {
				lastErr = err;
				const code = err?.code;
				if (code === "ENOENT" || code === "EBUSY" || code === "EPERM" || code === "EACCES") continue;
				throw err;
			}
		}
		if (attempt < 5) await new Promise(r => setTimeout(r, 30));
	}
	if (lastErr?.code === "ENOENT") {
		const fallback = envToken();
		if (fallback) return fallback;
		throw new Error(
			`E2E token missing at ${candidates.join(" or ")} (after 6 retries). ` +
			`Either the gateway fixture didn't write it, or process.env.BOBBIT_DIR/BOBBIT_SECRETS_DIR ` +
			`point at the wrong dir. BOBBIT_DIR=${process.env.BOBBIT_DIR ?? "<unset>"}, ` +
			`BOBBIT_SECRETS_DIR=${process.env.BOBBIT_SECRETS_DIR ?? "<unset>"}.`
		);
	}
	throw lastErr;
}

// ---------------------------------------------------------------------------
// Shared REST helpers
// ---------------------------------------------------------------------------

const _tokenCache: Record<string, string> = {};

/** Lazily read and cache the E2E auth token (per-port to handle worker isolation). */
function token(): string {
	const p = port();
	if (!_tokenCache[p]) _tokenCache[p] = readE2EToken();
	return _tokenCache[p];
}

/**
 * Collection-create routes where POST must carry a registered projectId (or a
 * cwd matching one). Session subroutes such as `/api/sessions/:id/fork` and
 * `/continue` derive project scope from the source session; injecting the
 * harness default into those bodies can leak stale default-project config into
 * cross-project worktree tests.
 *
 * The E2E harness registers a "default" project at startup; tests that omit
 * projectId get it injected automatically so they don't need to know about
 * the underlying server requirement. Tests that deliberately exercise the
 * 400-path bypass this helper by calling `fetch(...)` directly.
 */
const PROJECT_INJECT_ROUTES = /^\/api\/(sessions|goals|staff)(\?|$)/;

/**
 * Routes where workflow mutations need projectId. Workflows are now project-scoped
 * only — POST /api/workflows requires projectId in the body; PUT/DELETE/customize/
 * override on /api/workflows/:id require projectId as a query param. The harness
 * auto-injects the default project so existing tests don't need updating; tests
 * that deliberately exercise the 400 path use rawApiFetch.
 */
const WORKFLOWS_BODY_INJECT = /^\/api\/workflows(\?|$)/;
const WORKFLOWS_QUERY_INJECT = /^\/api\/workflows\/[^/]+(\/customize|\/override)?(\?|$)/;

/**
 * Parse a JSON body (string or already-object), inject projectId when missing,
 * and return a string suitable for a fetch body. Returns the original body
 * unchanged if it's not a JSON object we can read.
 */
export async function injectDefaultProjectId(body: unknown): Promise<unknown> {
	if (body == null) {
		const pid = await defaultProjectId();
		return pid ? JSON.stringify({ projectId: pid }) : body;
	}
	let parsed: Record<string, unknown> | undefined;
	if (typeof body === "string") {
		try { parsed = JSON.parse(body); } catch { return body; }
	} else if (typeof body === "object") {
		parsed = body as Record<string, unknown>;
	} else {
		return body;
	}
	if (!parsed || typeof parsed !== "object") return body;
	if (typeof parsed.projectId === "string" && parsed.projectId) {
		return typeof body === "string" ? body : JSON.stringify(parsed);
	}
	const pid = (await projectIdForRequestCwd(parsed.cwd)) ?? (await defaultProjectId());
	if (!pid) return typeof body === "string" ? body : JSON.stringify(parsed);
	return JSON.stringify({ ...parsed, projectId: pid });
}

/** POST /api/projects with a tmpdir rootPath may fail on macOS where os.tmpdir()
 * returns a symlinked /var/folders/... path. Automatically inject acceptCanonical:true
 * so tests that create projects from OS temp directories don't need to know about
 * this macOS-specific quirk. Tests that explicitly exercise the symlink-rejection
 * UX (add-project-symlink.spec.ts) use rawApiFetch / fetch directly and bypass this.
 */
const PROJECTS_POST = /^\/api\/projects(\?|$)/;

async function maybeInjectProjectId(path: string, opts: RequestInit): Promise<RequestInit> {
	const method = (opts.method || "GET").toUpperCase();
	if (method === "POST" && PROJECTS_POST.test(path)) {
		// Inject acceptCanonical so tmpdir-based rootPaths work on macOS.
		let body = opts.body;
		if (typeof body === "string") {
			try {
				const parsed = JSON.parse(body) as Record<string, unknown>;
				if (parsed && typeof parsed === "object" && parsed.acceptCanonical === undefined) {
					body = JSON.stringify({ ...parsed, acceptCanonical: true });
				}
			} catch { /* not JSON — leave unchanged */ }
		}
		if (body !== opts.body) return { ...opts, body: body as BodyInit };
	}
	if (method === "POST" && (PROJECT_INJECT_ROUTES.test(path) || WORKFLOWS_BODY_INJECT.test(path))) {
		const newBody = await injectDefaultProjectId(opts.body as unknown);
		if (newBody === opts.body) return opts;
		return { ...opts, body: newBody as BodyInit };
	}
	// POST /api/projects: canonicalize rootPath via realpathSync so tests
	// using tmpdir()-derived paths (which on macOS are symlinks /var/folders
	// -> /private/var/folders) don't 400 with code:"symlink_root", AND so
	// the value stored in the registry matches what the test compares
	// against in subsequent GETs. Tests that deliberately exercise the
	// symlink-rejection path use rawApiFetch() or page-driven UI and bypass
	// this entirely.
	if (method === "POST" && path === "/api/projects" && typeof opts.body === "string") {
		try {
			const parsed = JSON.parse(opts.body) as Record<string, unknown>;
			if (typeof parsed === "object" && parsed !== null && typeof parsed.rootPath === "string") {
				let rp = parsed.rootPath;
				try { const fs = await import("node:fs"); rp = fs.realpathSync(rp); } catch { /* path may not exist yet */ }
				if (rp !== parsed.rootPath) {
					return { ...opts, body: JSON.stringify({ ...parsed, rootPath: rp }) };
				}
			}
		} catch { /* not JSON, leave alone */ }
	}
	return opts;
}

/**
 * Auto-inject `acceptCanonical: true` into POST /api/projects bodies whose
 * `rootPath` resolves through a symlink. On macOS the OS tmpdir
 * (/var/folders/...) is itself reached via /var → /private/var, so every
 * test that registers a project under `os.tmpdir()` hits a 400
 * `symlink_root` from POST /api/projects unless it opts in to the
 * canonical path. The server-side validation stays intact for production
 * callers — only test traffic going through `apiFetch` is affected, and
 * any test that wants to *exercise* the 400 path uses `rawApiFetch`
 * which bypasses this interceptor entirely.
 *
 * The marker `__e2e_no_accept_canonical: true` on the request body opts
 * out (currently unused, reserved for future negative-path tests that
 * still want to go through apiFetch).
 */
function maybeInjectAcceptCanonical(path: string, opts: RequestInit): RequestInit {
	const method = (opts.method || "GET").toUpperCase();
	if (method !== "POST" || path !== "/api/projects") return opts;
	const body = opts.body as unknown;
	let parsed: Record<string, unknown> | undefined;
	if (typeof body === "string") {
		try { parsed = JSON.parse(body); } catch { return opts; }
	} else if (body && typeof body === "object") {
		parsed = body as Record<string, unknown>;
	} else {
		return opts;
	}
	if (!parsed || typeof parsed !== "object") return opts;
	if (parsed.__e2e_no_accept_canonical) return opts;
	const patch: Record<string, unknown> = {};
	// Canonicalize rootPath up-front so server-side lookups (upsert,
	// duplicate-detection, path-containment) all operate on the same path
	// the registry stores. Without this, on macOS the OS tmpdir
	// (/var/folders/...) reaches a project through /var → /private/var,
	// and routes that lookup-by-rootPath compare the raw symlink path
	// against the canonical stored value and miss.
	if (typeof parsed.rootPath === "string" && parsed.rootPath) {
		try {
			const canonical = realpathSync(parsed.rootPath);
			if (canonical !== parsed.rootPath) patch.rootPath = canonical;
		} catch { /* path may not exist yet (negative-path tests); leave as-is */ }
	}
	// Belt-and-braces: still set acceptCanonical so the server accepts
	// any residual symlink in the rootPath chain (e.g. a parent the test
	// didn't canonicalize) instead of 400'ing.
	if (parsed.acceptCanonical === undefined) patch.acceptCanonical = true;
	if (Object.keys(patch).length === 0) return opts;
	return { ...opts, body: JSON.stringify({ ...parsed, ...patch }) };
}

/**
 * Append projectId as a query param when missing, for routes that read it from
 * the URL (workflow customize/override/PUT/DELETE on /:id). Returns the path
 * unchanged if it already carries projectId or no default project is registered.
 */
function needsHeadquartersConfigProjectId(path: string, method: string): boolean {
	const bare = path.split("?")[0];
	if (method === "GET" && /^\/api\/(tools|roles|sandbox-status)(\?|$)/.test(path)) return true;
	if (method === "POST" && /^\/api\/sandbox-image\/build(\?|$)/.test(path)) return true;
	if ((method === "GET" || method === "PUT") && /^\/api\/tools\/[^/]+$/.test(bare)) return true;
	if (method === "GET" && /^\/api\/tools\/[^/]+\/renderer$/.test(bare)) return true;
	if (method === "GET" && bare === "/api/ext/contributions") return true;
	if (method === "GET" && /^\/api\/ext\/packs\/[^/]+\/panels\/[^/]+$/.test(bare)) return true;
	if ((method === "POST" || method === "DELETE") && /^\/api\/tools\/[^/]+\/(customize|override)$/.test(bare)) return true;
	if (method === "POST" && bare === "/api/roles") return true;
	if ((method === "GET" || method === "PUT" || method === "DELETE") && /^\/api\/roles\/(?!assistant\/prompts(?:\/|$))[^/]+$/.test(bare)) return true;
	if ((method === "POST" || method === "DELETE") && /^\/api\/roles\/[^/]+\/(customize|override)$/.test(bare)) return true;
	if (method === "GET" && bare === "/api/tool-group-policies") return true;
	if (method === "PUT" && /^\/api\/tool-group-policies\/[^/]+$/.test(bare)) return true;
	return false;
}

async function maybeInjectProjectIdQuery(path: string, method: string): Promise<string> {
	// /api/workflows root GET also needs projectId now (returns [] without one).
	// /api/workflows/:id and /:id/customize|/override require projectId on every method.
	const rootGet = method === "GET" && WORKFLOWS_BODY_INJECT.test(path);
	const idRoute = WORKFLOWS_QUERY_INJECT.test(path) && (method === "GET" || method === "POST" || method === "PUT" || method === "DELETE");
	const hqDiscoveryRoute = needsHeadquartersConfigProjectId(path, method);
	if (!rootGet && !idRoute && !hqDiscoveryRoute) return path;
	if (/[?&]projectId=/.test(path)) return path;
	if (hqDiscoveryRoute) return path + (path.includes("?") ? "&" : "?") + "projectId=headquarters";
	const pid = await defaultProjectId();
	if (!pid) return path;
	return path + (path.includes("?") ? "&" : "?") + "projectId=" + encodeURIComponent(pid);
}

/**
 * Raw authenticated fetch — identical auth to `apiFetch` but does NOT auto-inject
 * the harness default projectId. Use this for tests that deliberately exercise
 * the 400-projectId-required path.
 */
export async function rawApiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	const method = (opts.method || "GET").toUpperCase();
	const resp = await fetch(`${base()}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
	await maybeAutoSeedWorkflows(path, method, opts.body as unknown, resp);
	return resp;
}

/**
 * Auto-seed inline workflows into newly-created E2E projects.
 *
 * Builtin workflow YAMLs were removed (follow-up A of the multi-repo &
 * components goal). Tests that POST a fresh project and then create
 * goals against it (workflowId defaults to "general") would otherwise
 * 400 because the new project has no workflows. We post-process the
 * 201 response from POST /api/projects and PUT a baseline workflow
 * block into the new project's config. Idempotent: skipped if the
 * caller already provided a `workflows` field in the request body.
 *
 * Marker `__e2e_seed_skip__` on the request body opts out (used by the
 * harness's own initial "default" project registration, which seeds
 * workflows itself with a known component name).
 */
async function maybeAutoSeedWorkflows(path: string, method: string, requestBody: unknown, response: Response): Promise<void> {
	if (method !== "POST" || path !== "/api/projects") return;
	if (!response.ok) return;
	let parsed: Record<string, unknown> | undefined;
	if (typeof requestBody === "string") {
		try { parsed = JSON.parse(requestBody); } catch { /* skip */ }
	} else if (requestBody && typeof requestBody === "object") {
		parsed = requestBody as Record<string, unknown>;
	}
	if (parsed?.workflows) return;
	if (parsed?.__e2e_seed_skip__) return;
	let projectId: string | undefined;
	try {
		const clone = response.clone();
		const json = await clone.json() as { id?: string };
		projectId = json?.id;
	} catch { return; }
	if (!projectId) return;
	// PUT only the workflows block. We must NOT touch the project's
	// `components` here — multi-repo tests register specific component
	// shapes in the create body and rely on them surviving. The workflow
	// validator runs at PUT time only when both `components` and
	// `workflows` are in the body, so omitting components is safe; the
	// workflow steps reference component name "test" which only exists
	// in the harness's default project. Multi-repo tests don't try to
	// run gate verification against this seeded workflow — they only
	// need the workflow IDs to resolve so goal creation succeeds.
	try {
		const { testWorkflows } = await import("./seed-workflows.js");
		await fetch(`${base()}/api/projects/${projectId}/config`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token()}`,
			},
			body: JSON.stringify({ workflows: testWorkflows() }),
		});
	} catch { /* best-effort */ }
}

/**
 * The OPERATOR-class Children REST endpoints guarded by the S1 authz check
 * (`src/server/auth/children-mutation-authz.ts`): `pause`, `resume`,
 * mutation `decision`, and `policy` (only when the PATCH body carries
 * EXCLUSIVELY the per-goal sub-goal opt-in fields `subgoalsAllowed` /
 * `maxNestingDepth` — see the split classifier in `nested-goal-routes.ts`).
 * These are the human-in-the-loop verbs the web UI drives, so a verified
 * `bobbit_session` cookie authorizes them. A node `apiFetch` carries no cookie,
 * so without one these would 403; we therefore auto-inject the cached signed
 * cookie. (Browser-initiated requests carry the cookie automatically and don't
 * need this.) Tests that deliberately exercise the agent/deny path use
 * `rawApiFetch` with explicit headers.
 *
 * NOTE: the ORCHESTRATION-class verbs (`spawn-child`, plan `PATCH`,
 * `integrate-child`, and `policy` carrying `divergencePolicy` /
 * `maxConcurrentChildren`) still require the team-lead secret. The cookie does
 * NOT bypass an orchestration check (it is mintable by any holder of the shared
 * admin token), so auto-injecting it would not authorize them — it is merely
 * harmless. Tests that drive orchestration must authenticate as the goal's
 * team-lead — see `seedTeamLeadHeader()` below. We include `policy` in the
 * auto-inject set because the common (subgoal-only) case is operator-class;
 * orchestration-class policy patches still need the secret regardless.
 */
const CHILDREN_MUTATION_PATH =
	/^\/api\/goals\/[^/]+\/(pause|resume|policy|mutation\/[^/]+\/decision)$/;

/**
 * Authorize an ORCHESTRATION-class Children mutation (`spawn-child`, plan
 * `PATCH`, `integrate-child`, `policy`) as the goal's team-lead.
 *
 * S1: orchestration authz no longer trusts the public `X-Bobbit-Spawning-
 * Session` header — it derives the AUTHENTIC caller by resolving the per-session
 * `X-Bobbit-Session-Secret` server-side (see `session-secret.ts`). So this seam
 * does two things: (1) registers a minimal team entry so `getTeamState` returns
 * the team-lead id, and (2) registers a capability secret in the gateway's
 * `SessionSecretStore` mapped to that same team-lead id. It returns BOTH headers
 * — the public spawning-session header (for `spawnedBySessionId` stamping) and
 * the secret (the actual auth credential). Production establishes the team-lead
 * via `TeamManager.startTeam` (which spawns a real session and injects its
 * secret); the mock E2E harness short-circuits both.
 *
 * Pass the harness GATEWAY object (which exposes `.teamManager` and
 * `.sessionManager`), e.g.:
 *
 *   await apiFetch(`/api/goals/${id}/spawn-child`, {
 *     method: "POST", body, headers: seedTeamLeadHeader(gateway, id),
 *   });
 *
 * Idempotent: reuses an already-established team-lead for the goal. Pass an
 * explicit `sessionId` when the spawnedBy-cascade assertions need a specific
 * team-lead identity.
 */
export function seedTeamLeadHeader(
	gateway: any,
	goalId: string,
	sessionId?: string,
): Record<string, string> {
	// Back-compat: callers historically passed `gateway.teamManager`. Accept
	// either the gateway (preferred — needed to reach the secret store) or a
	// bare teamManager.
	const teamManager = gateway?.teamManager ?? gateway;
	const secretStore = gateway?.sessionManager?.sessionSecretStore ?? gateway?.sessionSecretStore;
	const existing = teamManager?.getTeamState?.(goalId)?.teamLeadSessionId;
	const tl = (typeof existing === "string" && existing.trim())
		? existing.trim()
		: (sessionId && sessionId.trim() ? sessionId.trim() : `e2e-teamlead-${goalId}`);
	if (!existing) {
		// Reach into the in-memory team map (mirrors gate-verification-resume's
		// teamStore.put pattern). A minimal entry is enough for getTeamState to
		// return the team-lead id the authz check compares against.
		teamManager?.teams?.set?.(goalId, {
			goalId,
			teamLeadSessionId: tl,
			agents: [],
			maxConcurrent: 12,
		});
	}
	const headers: Record<string, string> = { "X-Bobbit-Spawning-Session": tl };
	// S1: register + send the capability secret that resolves to the team-lead.
	if (secretStore?.getOrCreateSecret) {
		headers["X-Bobbit-Session-Secret"] = secretStore.getOrCreateSecret(tl);
	}
	return headers;
}

/**
 * Lazily bootstrap a signed `bobbit_session` cookie for the human/UI operator
 * authz path. Cookie issuance requires an authenticated, browser-signaled
 * request, so this helper supplies the same Fetch Metadata as the web UI.
 * Cached per-port for worker isolation. Returns "" if (unexpectedly) no cookie
 * was issued, in which case we fall back to no extra header and let the call
 * fail loudly.
 */
const _humanCookieCache: Record<string, string> = {};
async function humanSessionCookie(): Promise<string> {
	const p = port();
	if (_humanCookieCache[p]) return _humanCookieCache[p];
	try {
		const resp = await fetch(`${base()}/api/goals`, {
			headers: {
				Authorization: `Bearer ${token()}`,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			},
		});
		const setCookies = (resp.headers as any).getSetCookie?.() as string[] | undefined
			?? (resp.headers.get("set-cookie") ? [resp.headers.get("set-cookie") as string] : []);
		const cookie = setCookies
			.map((c) => c.split(";")[0])
			.find((c) => c.startsWith("bobbit_session=")) ?? "";
		if (cookie) _humanCookieCache[p] = cookie;
		return cookie;
	} catch {
		return "";
	}
}

/**
 * For OPERATOR-class Children-mutation paths (pause / resume / mutation
 * decision — see CHILDREN_MUTATION_PATH), authenticate as the human operator
 * by adding the `bobbit_session` cookie — UNLESS the caller already supplied
 * its own cookie or a spawning-session / session-id header (those tests are
 * exercising a specific authz path and must be respected verbatim).
 *
 * Orchestration-class verbs are deliberately NOT covered here: the cookie does
 * not bypass orchestration authz, so they authenticate as the team-lead via
 * `seedTeamLeadHeader()` at the call site instead.
 */
async function withChildrenAuthzCookie(path: string, method: string, headers: Record<string, string>): Promise<Record<string, string>> {
	const bare = path.split("?")[0];
	// Child creation via `POST /api/goals` with a `parentGoalId` is now an
	// OPERATOR-class Children mutation (the proposal UI drives it; see the S1
	// authz block in server.ts). A node `apiFetch` carries no cookie, so child
	// creation would 403 without one. We can't see the body here (only the
	// path), so we cover ALL `POST /api/goals`; top-level goal creation ignores
	// the cookie, so injecting it is harmless. Tests exercising the agent/deny
	// path use `rawApiFetch` (which bypasses this) with explicit headers.
	const isChildCreate = method.toUpperCase() === "POST" && bare === "/api/goals";
	if (!CHILDREN_MUTATION_PATH.test(bare) && !isChildCreate) return headers;
	const hasExplicitAuth = Object.keys(headers).some((k) => {
		const lk = k.toLowerCase();
		if ((lk === "x-bobbit-spawning-session" || lk === "x-bobbit-session-id") && headers[k]) return true;
		if (lk === "cookie" && /bobbit_session=/.test(headers[k] || "")) return true;
		return false;
	});
	if (hasExplicitAuth) return headers;
	const cookie = await humanSessionCookie();
	return cookie ? { ...headers, Cookie: cookie } : headers;
}

/**
 * `/api/sessions/:id/orchestrate/*` routes (Orchestration Core) require the
 * caller to authenticate AS the owner via the unforgeable per-session secret
 * (see session-secret.ts). In production the agent subprocess sends its
 * BOBBIT_SESSION_SECRET; an in-process E2E test acts as the owner by resolving
 * the owner's secret from the gateway's SessionSecretStore. The in-process
 * harness registers the store here so apiFetch can auto-inject the header for
 * orchestrate paths. A test exercising the foreign-owner DENY path supplies its
 * own `X-Bobbit-Session-Secret` (a different session's secret), which suppresses
 * auto-injection so the 403 is genuinely observed.
 */
let _orchestrateSecretStore: { getOrCreateSecret(id: string): string } | undefined;
export function registerOrchestrateSecretStore(store: unknown): void {
	_orchestrateSecretStore = store && typeof (store as any).getOrCreateSecret === "function"
		? (store as { getOrCreateSecret(id: string): string })
		: undefined;
}
const ORCHESTRATE_PATH = /^\/api\/sessions\/([^/]+)\/orchestrate\//;
function maybeInjectOrchestrateSecret(path: string, headers: Record<string, string>): Record<string, string> {
	const m = ORCHESTRATE_PATH.exec(path.split("?")[0]);
	if (!m || !_orchestrateSecretStore) return headers;
	// Respect an explicit secret (foreign-owner deny-path tests).
	if (Object.keys(headers).some((k) => k.toLowerCase() === "x-bobbit-session-secret")) return headers;
	return { ...headers, "X-Bobbit-Session-Secret": _orchestrateSecretStore.getOrCreateSecret(decodeURIComponent(m[1])) };
}

/**
 * The goal `/team/{prompt,steer,abort,dismiss}` OWN-CHILD fallback (H3) requires
 * the AUTHENTIC caller — resolved from the per-session secret — to BE the
 * team-lead owner before it orchestrates the lead's PRIVATE team_delegate child
 * (mirrors `/orchestrate/*`). In production the team-lead's agent process sends
 * its BOBBIT_SESSION_SECRET (team/extension.ts). An in-process E2E test acts as
 * the team-lead by resolving the goal's team-lead session id and injecting its
 * secret. Tracked goal-member dismiss also uses this secret for team-lead-only
 * cleanup before TeamManager runs. A test exercising the FOREIGN-caller DENY
 * path supplies its OWN secret (suppresses injection); the NO-secret DENY path
 * uses `rawApiFetch` (which bypasses all injectors). Goal-MEMBER
 * prompt/steer/abort normal paths are unaffected.
 */
let _teamLeadResolver: ((goalId: string) => string | undefined) | undefined;
let _teamLeadSecretStore: { getOrCreateSecret(id: string): string } | undefined;
export function registerTeamLeadSecretSource(
	resolver: ((goalId: string) => string | undefined) | undefined,
	store?: unknown,
): void {
	_teamLeadResolver = resolver;
	_teamLeadSecretStore = store && typeof (store as any).getOrCreateSecret === "function"
		? (store as { getOrCreateSecret(id: string): string })
		: undefined;
}
const TEAM_OWNCHILD_PATH = /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/(?:prompt|steer|abort|dismiss)$/;
function maybeInjectTeamLeadSecret(path: string, headers: Record<string, string>): Record<string, string> {
	const m = TEAM_OWNCHILD_PATH.exec(path.split("?")[0]);
	if (!m || !_teamLeadResolver || !_teamLeadSecretStore) return headers;
	// Respect an explicit secret (foreign-caller deny-path tests).
	if (Object.keys(headers).some((k) => k.toLowerCase() === "x-bobbit-session-secret")) return headers;
	const lead = _teamLeadResolver(decodeURIComponent(m[1]));
	if (!lead) return headers;
	return { ...headers, "X-Bobbit-Session-Secret": _teamLeadSecretStore.getOrCreateSecret(lead) };
}

/** Authenticated REST fetch against the E2E gateway. Retries on transient TCP errors. */
export async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	const injected = maybeInjectAcceptCanonical(path, await maybeInjectProjectId(path, opts));
	const maxRetries = 4;
	const method = (injected.method || opts.method || "GET").toUpperCase();
	const finalPath = await maybeInjectProjectIdQuery(path, method);
	const authedHeaders = maybeInjectTeamLeadSecret(finalPath, maybeInjectOrchestrateSecret(finalPath, await withChildrenAuthzCookie(finalPath, method, {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token()}`,
		...(injected.headers as Record<string, string> || {}),
	})));
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			const resp = await fetch(`${base()}${finalPath}`, {
				...injected,
				headers: authedHeaders,
			});
			await maybeAutoSeedWorkflows(path, method, injected.body as unknown, resp);
			return resp;
		} catch (err: unknown) {
			const msg = err instanceof Error
				? [err.message, (err as any).cause?.message, (err as any).cause?.code].filter(Boolean).join(" ")
				: String(err);
			const isTransient = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR_SOCKET|fetch failed/i.test(msg);
			if (!isTransient || attempt === maxRetries - 1) throw err;
			// Increasing back-off: 250ms, 500ms, 1000ms
			await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
		}
	}
	throw new Error("apiFetch: unreachable");
}

type ProjectSummary = {
	id?: string;
	name?: string;
	rootPath?: string;
	hidden?: boolean;
};

type LiveProjectState =
	| { ok: true; status: number; projects: ProjectSummary[]; rawKind: string }
	| { ok: false; status?: number; body?: string; error?: string };

function safeJson(value: unknown): string {
	try { return JSON.stringify(value); } catch { return String(value); }
}

async function responseText(resp: Response): Promise<string> {
	try {
		const text = await resp.text();
		return text || "<empty>";
	} catch (err) {
		return `<failed to read body: ${err instanceof Error ? err.message : String(err)}>`;
	}
}

async function readLiveProjectState(): Promise<LiveProjectState> {
	try {
		const resp = await fetch(`${base()}/api/projects`, {
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token()}`,
			},
		});
		const text = await resp.text().catch(() => "<failed to read body>");
		if (!resp.ok) return { ok: false, status: resp.status, body: text };
		let parsed: unknown;
		try { parsed = text ? JSON.parse(text) : []; } catch {
			return { ok: false, status: resp.status, body: `invalid JSON: ${text}` };
		}
		const list = Array.isArray(parsed)
			? parsed
			: Array.isArray((parsed as any)?.projects)
				? (parsed as any).projects
				: undefined;
		if (!Array.isArray(list)) {
			return { ok: false, status: resp.status, body: `unexpected project list shape: ${text}` };
		}
		return {
			ok: true,
			status: resp.status,
			rawKind: Array.isArray(parsed) ? "array" : "object.projects",
			projects: list.map((p: any) => ({
				id: typeof p?.id === "string" ? p.id : undefined,
				name: typeof p?.name === "string" ? p.name : undefined,
				rootPath: typeof p?.rootPath === "string" ? p.rootPath : undefined,
				hidden: typeof p?.hidden === "boolean" ? p.hidden : undefined,
			})),
		};
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function formatLiveProjectState(state: LiveProjectState): string {
	if (!state.ok) {
		return safeJson({ ok: false, status: state.status, body: state.body, error: state.error });
	}
	return safeJson({ ok: true, status: state.status, rawKind: state.rawKind, projects: state.projects });
}

function canonicalPathForMatch(p: string): string {
	try { return realpathSync(p); } catch { return resolve(p); }
}

function pathContains(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function findProjectIdForCwd(state: LiveProjectState, cwdValue: string): string | undefined {
	if (!state.ok) return undefined;
	const cwd = canonicalPathForMatch(cwdValue);
	let best: { id: string; root: string } | undefined;
	for (const project of state.projects) {
		if (project.hidden || !project.id || !project.rootPath) continue;
		const root = canonicalPathForMatch(project.rootPath);
		if (!pathContains(root, cwd)) continue;
		if (!best || root.length > best.root.length) best = { id: project.id, root };
	}
	return best?.id;
}

async function projectIdForRequestCwd(cwdValue: unknown): Promise<string | undefined> {
	if (typeof cwdValue !== "string" || !cwdValue.trim()) return undefined;
	// Project registration and immediate session creation happen back-to-back in
	// several E2E specs. Under broad-suite contention, the first list request can
	// occasionally race the just-registered project becoming visible to this
	// helper; retry briefly before falling back to the harness default project.
	// Without this, worktree creation can incorrectly use default-project config
	// such as a deliberately stale `base_ref` from another test.
	for (let attempt = 0; attempt < 5; attempt++) {
		const state = await readLiveProjectState();
		const match = findProjectIdForCwd(state, cwdValue);
		if (match) return match;
		if (attempt < 4) await new Promise(r => setTimeout(r, 25));
	}
	return undefined;
}

async function seedHarnessDefaultProjectWorkflows(projectId: string, reason: string): Promise<void> {
	try {
		const { testWorkflows, TEST_DEFAULT_COMPONENT } = await import("./seed-workflows.js");
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token()}`,
		};
		let current: Record<string, any> = {};
		try {
			const cfgResp = await fetch(`${base()}/api/projects/${projectId}/config`, { headers });
			if (cfgResp.ok) current = await cfgResp.json();
		} catch { /* fall back to additive seed */ }
		const existingWorkflows = current.workflows && typeof current.workflows === "object" && !Array.isArray(current.workflows)
			? current.workflows as Record<string, unknown>
			: {};
		const workflows = { ...testWorkflows(), ...existingWorkflows };
		const existingComponents = Array.isArray(current.components) ? current.components : [];
		const componentNames = new Set(existingComponents.map((c: any) => c?.name).filter((name: unknown): name is string => typeof name === "string"));
		const components = componentNames.has(TEST_DEFAULT_COMPONENT.name)
			? existingComponents
			: [...existingComponents, TEST_DEFAULT_COMPONENT];
		const resp = await fetch(`${base()}/api/projects/${projectId}/config`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ components, workflows }),
		});
		if (!resp.ok) {
			throw new Error(`${resp.status} ${resp.statusText} body=${await responseText(resp)}`);
		}
	} catch (err) {
		throw new Error(
			`E2E default project workflow seed failed (${reason}): ` +
			`${err instanceof Error ? err.message : String(err)} port=${port()} bobbitDir=${bobbitDir()}`,
		);
	}
}

async function registerHarnessDefaultProject(reason: string): Promise<ProjectSummary> {
	const p = port();
	const request = { name: "default", rootPath: harnessDefaultProjectRoot(), upsert: true, acceptCanonical: true };
	let resp: Response;
	try {
		resp = await fetch(`${base()}/api/projects`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token()}`,
			},
			body: JSON.stringify(request),
		});
	} catch (err) {
		delete _defaultProjectIdCache[p];
		throw new Error(
			`E2E default project registration failed (${reason}): ${err instanceof Error ? err.message : String(err)} ` +
			`request=${safeJson(request)} port=${p} bobbitDir=${bobbitDir()}`,
		);
	}
	const text = await resp.text().catch(() => "<failed to read body>");
	if (resp.status < 200 || resp.status >= 300) {
		delete _defaultProjectIdCache[p];
		throw new Error(
			`E2E default project registration failed (${reason}): ${resp.status} ${resp.statusText} ` +
			`body=${text || "<empty>"} request=${safeJson(request)} port=${p} bobbitDir=${bobbitDir()}`,
		);
	}
	let project: ProjectSummary;
	try { project = JSON.parse(text) as ProjectSummary; } catch {
		delete _defaultProjectIdCache[p];
		throw new Error(
			`E2E default project registration returned invalid JSON (${reason}): body=${text || "<empty>"} ` +
			`request=${safeJson(request)} port=${p} bobbitDir=${bobbitDir()}`,
		);
	}
	if (!project?.id) {
		delete _defaultProjectIdCache[p];
		throw new Error(
			`E2E default project registration returned no id (${reason}): body=${text || "<empty>"} ` +
			`request=${safeJson(request)} port=${p} bobbitDir=${bobbitDir()}`,
		);
	}
	_defaultProjectIdCache[p] = project.id;
	await seedHarnessDefaultProjectWorkflows(project.id, reason);
	_defaultProjectWorkflowSeededCache[p] = project.id;
	return project;
}

async function requestDiagnosticContext(request: Record<string, unknown>): Promise<string> {
	const liveProjects = await readLiveProjectState();
	return `request=${safeJson(request)} port=${port()} base=${base()} bobbitDir=${bobbitDir()} ` +
		`cachedDefaultProjectId=${_defaultProjectIdCache[port()] ?? "<none>"} liveProjects=${formatLiveProjectState(liveProjects)}`;
}

/**
 * Look up the harness-registered "default" project id, re-registering it when
 * a shared worker was drained to zero projects or our cached id was deleted.
 *
 * The gateway harness (see gateway-harness.ts / in-process-harness.ts) registers
 * a single project named "default" at the server CWD after startup. The server
 * no longer auto-resolves a default, so API callers that omit projectId must
 * pass one explicitly. This helper fetches and caches the id per-port.
 *
 * NOTE on cache invalidation: tests like stories-goal-routing run
 * `forceDeleteAllProjects()` to exercise the zero-project path. Anything
 * cached here would then point at a deleted project and the next
 * `createSession()` would 500 with "Cannot resolve session store". To stay
 * robust under shared-worker harness reuse, every call re-checks the live
 * project list and re-derives the cache from the live "default" project;
 * the caller still gets O(1)-ish behaviour because /api/projects is
 * in-memory and dirt cheap.
 */
const _defaultProjectIdCache: Record<string, string> = {};
const _defaultProjectWorkflowSeededCache: Record<string, string> = {};

async function ensureHarnessDefaultProjectSeeded(projectId: string, reason: string): Promise<void> {
	const p = port();
	if (_defaultProjectWorkflowSeededCache[p] === projectId) return;
	await seedHarnessDefaultProjectWorkflows(projectId, reason);
	_defaultProjectWorkflowSeededCache[p] = projectId;
}

export async function defaultProjectId(): Promise<string | undefined> {
	const p = port();
	const state = await readLiveProjectState();
	if (!state.ok) {
		delete _defaultProjectIdCache[p];
		delete _defaultProjectWorkflowSeededCache[p];
		throw new Error(`defaultProjectId failed to list projects: ${formatLiveProjectState(state)} port=${p} bobbitDir=${bobbitDir()}`);
	}
	const visibleProjects = state.projects.filter(pr => !pr.hidden);
	const cachedId = _defaultProjectIdCache[p];
	if (cachedId && visibleProjects.some(pr => pr.id === cachedId && pr.name === "default")) {
		await ensureHarnessDefaultProjectSeeded(cachedId, "cached default project found in live list");
		return cachedId;
	}
	if (cachedId && !visibleProjects.some(pr => pr.id === cachedId)) {
		delete _defaultProjectWorkflowSeededCache[p];
		return (await registerHarnessDefaultProject(`cached project ${cachedId} missing from live list`)).id;
	}
	const match = visibleProjects.find(pr => pr.name === "default");
	if (match?.id) {
		_defaultProjectIdCache[p] = match.id;
		await ensureHarnessDefaultProjectSeeded(match.id, "existing default project found in live list");
		return match.id;
	}
	delete _defaultProjectIdCache[p];
	delete _defaultProjectWorkflowSeededCache[p];
	return (await registerHarnessDefaultProject(
		visibleProjects.length === 0 ? "live visible project list is empty" : "default project missing from live list",
	)).id;
}

export async function defaultProject(): Promise<{ id: string; rootPath: string; name?: string }> {
	const id = await defaultProjectId();
	if (!id) throw new Error(`defaultProject failed to resolve id port=${port()} bobbitDir=${bobbitDir()}`);
	const state = await readLiveProjectState();
	if (!state.ok) {
		throw new Error(`defaultProject failed to list projects: ${formatLiveProjectState(state)} port=${port()} bobbitDir=${bobbitDir()}`);
	}
	const project = state.projects.find(pr => pr.id === id && !pr.hidden);
	if (!project?.rootPath) {
		throw new Error(`defaultProject ${id} missing rootPath: ${formatLiveProjectState(state)} port=${port()} bobbitDir=${bobbitDir()}`);
	}
	return { id, rootPath: project.rootPath, name: project.name };
}

export async function defaultProjectRootPath(): Promise<string> {
	return (await defaultProject()).rootPath;
}

export async function defaultProjectStateDir(): Promise<string> {
	return projectStateDirForRoot(await defaultProjectRootPath());
}

async function projectRootForId(projectId: string): Promise<string | undefined> {
	const state = await readLiveProjectState();
	if (!state.ok) return undefined;
	return state.projects.find(pr => pr.id === projectId && !pr.hidden)?.rootPath;
}

async function defaultExecutionCwdForProject(projectId: string | undefined): Promise<string> {
	if (projectId) {
		const rootPath = await projectRootForId(projectId);
		if (rootPath) {
			const canonicalRoot = canonicalPathForMatch(rootPath);
			const canonicalDefaultRoot = canonicalPathForMatch(harnessDefaultProjectRoot());
			return canonicalRoot === canonicalDefaultRoot ? nonGitCwd() : rootPath;
		}
	}
	return nonGitCwd();
}

/**
 * Create a session via REST, return its ID. Defaults cwd to a non-git temp dir.
 *
 * Retries once on 500 to absorb a known Windows-only race where the server's
 * session-prompts directory briefly appears missing under heavy parallel
 * load even though the harness + scaffolder both created it. Real product
 * failures still surface via the second attempt.
 */
export async function createSession(opts?: { cwd?: string; goalId?: string; projectId?: string }): Promise<string> {
	const projectId = opts?.projectId || (await defaultProjectId());
	const body: Record<string, unknown> = {
		cwd: opts?.cwd || await defaultExecutionCwdForProject(projectId),
		goalId: opts?.goalId,
	};
	if (projectId) {
		body.projectId = projectId;
	}
	// Retry on transient server 500s. Under heavy parallel test load the
	// server occasionally fails session creation with a 500 (e.g. worktree
	// setup contention, disk latency, or the Windows FS race where the
	// session-prompts state dir hasn't been created yet). The request is a
	// clean POST with no side effect on 500, so retry is safe.
	//
	// Bumped from 3 to 5 attempts with backoff to absorb persistent FS
	// contention under heavy parallel browser load, and we now capture and
	// surface the server's final error body and live project context so a
	// failed retry tells us *why* instead of just "got 500".
	let resp: Response | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (resp.status !== 500 || attempt === 4) break;
		await responseText(resp).catch(() => "<ignored>");
		try {
			const { mkdirSync } = await import("node:fs");
			mkdirSync(join(bobbitDir(), "state", "session-prompts"), { recursive: true });
		} catch { /* best-effort */ }
		await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
	}
	if (resp!.status !== 201) {
		const finalBody = await responseText(resp!);
		throw new Error(
			`createSession expected 201, got ${resp!.status}. body=${finalBody}. ${await requestDiagnosticContext(body)}`,
		);
	}
	return (await resp!.json()).id;
}

/**
 * Register a project via REST. Canonicalizes `rootPath` and sets
 * `acceptCanonical: true` so the macOS /var → /private/var symlink
 * (or any other symlinked tmpdir) doesn't produce a 400 `symlink_root`.
 *
 * The default is upsert=false to mirror raw POST semantics. Pass
 * `upsert: true` for idempotent re-registration.
 *
 * Returns the created/existing project. Throws on any non-2xx response
 * with the server's error body included in the message — saves callers
 * from writing `expect(resp.status).toBe(201)` plus a generic message.
 *
 * Tests that deliberately exercise the symlink_root 400 path must call
 * `rawApiFetch("/api/projects", ...)` and construct the body themselves.
 */
export async function registerProject(opts: {
	name: string;
	rootPath: string;
	components?: Array<Record<string, unknown>>;
	workflows?: unknown;
	upsert?: boolean;
	config?: Record<string, unknown>;
	/**
	 * Marker that prevents the auto-seed-workflows helper from PUT-ing the
	 * baseline workflow block into the new project. Set `seedWorkflows: false`
	 * for tests that assert a zero-workflows project shape.
	 */
	seedWorkflows?: boolean;
	/**
	 * Extra fields merged into the request body verbatim (palette, color, etc).
	 */
	extra?: Record<string, unknown>;
}): Promise<{ id: string; rootPath: string; [k: string]: unknown }> {
	const body: Record<string, unknown> = {
		name: opts.name,
		rootPath: opts.rootPath,
	};
	if (opts.components) body.components = opts.components;
	if (opts.workflows !== undefined) body.workflows = opts.workflows;
	if (opts.upsert) body.upsert = true;
	if (opts.config) Object.assign(body, opts.config);
	if (opts.extra) Object.assign(body, opts.extra);
	if (opts.seedWorkflows === false) body.__e2e_seed_skip__ = true;
	// apiFetch's interceptor canonicalizes rootPath and adds acceptCanonical.
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (resp.status < 200 || resp.status >= 300) {
		let errBody: string;
		try { errBody = await resp.text(); } catch { errBody = "<no body>"; }
		throw new Error(`registerProject(${opts.name}) failed: ${resp.status} ${errBody}`);
	}
	return resp.json();
}

/** Delete a session (best-effort, for cleanup). */
export async function deleteSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Create a goal via REST, return the full goal object. Defaults cwd to a non-git temp dir. */
export async function createGoal(opts: {
	title: string;
	cwd?: string;
	spec?: string;
	team?: boolean;
	worktree?: boolean;
	workflowId?: string;
	autoStartTeam?: boolean;
	projectId?: string;
	subgoalsAllowed?: boolean;
	maxNestingDepth?: number;
}): Promise<{ id: string; [k: string]: unknown }> {
	// Default spec for tests that don't care about spec content. The server now
	// requires a non-placeholder spec (>=20 chars) before starting a team, so the
	// helper supplies a sensible default. Tests that exercise SPEC_REQUIRED call
	// apiFetch("/api/goals", ...) directly and bypass this helper.
	const defaultSpec = "E2E harness goal — spec autopopulated by createGoal() helper for tests that do not exercise spec content.";
	const body: Record<string, unknown> = { worktree: false, spec: defaultSpec, ...opts };
	if (!body.projectId) {
		// Auto-inject harness default projectId when caller didn't specify one.
		// Server prefers projectId over cwd. Tests that exercise the 400 path
		// call rawApiFetch("/api/goals", ...) and bypass this helper.
		body.projectId = await defaultProjectId();
	}
	if (!body.cwd) {
		body.cwd = await defaultExecutionCwdForProject(typeof body.projectId === "string" ? body.projectId : undefined);
	}
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (resp.status !== 201) {
		const finalBody = await responseText(resp);
		throw new Error(
			`createGoal expected 201, got ${resp.status}. body=${finalBody}. ${await requestDiagnosticContext(body)}`,
		);
	}
	return resp.json();
}

/** Delete a goal (best-effort, for cleanup). Server requires explicit `cascade` query param (returns 422 CASCADE_REQUIRED when omitted). Cleanup paths default to cascade=true so descendants are archived together. */
export async function deleteGoal(id: string, cascade = true): Promise<void> {
	await apiFetch(`/api/goals/${id}?cascade=${cascade ? "true" : "false"}`, { method: "DELETE" }).catch(() => {});
}

/** Start a team for a goal, returns the team lead session ID. */
export async function startTeam(goalId: string): Promise<string> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/start`, { method: "POST" });
	const data = await resp.json();
	if (resp.status >= 300) {
		throw new Error(`startTeam failed (${resp.status}): ${JSON.stringify(data)}`);
	}
	return data.sessionId;
}

/** Teardown a team (best-effort, for cleanup). Server returns 422 CASCADE_REQUIRED when `cascade` is omitted, so cleanup paths must always send it. */
export async function teardownTeam(goalId: string, cascade = true): Promise<void> {
	await apiFetch(`/api/goals/${goalId}/team/teardown?cascade=${cascade ? "true" : "false"}`, { method: "POST" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Shared WebSocket helpers
// ---------------------------------------------------------------------------

export interface WsMsg { type: string; [key: string]: any }

export interface WsConnection {
	ws: WebSocket;
	messages: WsMsg[];
	/** Wait for a message matching predicate. Checks already-received messages first. */
	waitFor: (pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	/**
	 * Wait for a message matching predicate at or after `fromIndex`.
	 * Pattern: `const idx = ws.messageCount(); await doAction(); await ws.waitForFrom(idx, pred);`
	 * This is race-safe: if the event fires before the waiter registers, it's still matched.
	 */
	waitForFrom: (fromIndex: number, pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	/** Current message count — use as cursor for waitForFrom. */
	messageCount: () => number;
	send: (msg: Record<string, unknown>) => void;
	close: () => void;
}

/** Connect & authenticate a WebSocket to a session. */
export function connectWs(sessionId: string): Promise<WsConnection> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase()}/ws/${sessionId}`);
		const messages: WsMsg[] = [];
		const waiters: Array<{ pred: (m: WsMsg) => boolean; res: (m: WsMsg) => void; rej: (e: Error) => void }> = [];

		ws.on("message", (raw) => {
			const msg: WsMsg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(msg)) {
					waiters[i].res(msg);
					waiters.splice(i, 1);
				}
			}
		});

		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: token() })));
		ws.on("error", reject);

		const iv = setInterval(() => {
			if (messages.some((m) => m.type === "auth_ok")) {
				clearInterval(iv);
				resolve({
					ws, messages,
					waitFor(pred, timeoutMs = 15_000) {
						const existing = messages.find(pred);
						if (existing) return Promise.resolve(existing);
						return new Promise((res, rej) => {
							const t = setTimeout(() => rej(new Error(`WS waitFor timed out (${timeoutMs}ms)`)), timeoutMs);
							waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); }, rej });
						});
					},
					waitForFrom(fromIndex, pred, timeoutMs = 15_000) {
						// Match messages at or after fromIndex. Use messageCount() to
						// capture the index BEFORE triggering an async action, then
						// waitForFrom(idx, ...) to wait for the resulting event.
						// Safe against race where event arrives before waiter registers.
						const existing = messages.slice(fromIndex).find(pred);
						if (existing) return Promise.resolve(existing);
						return new Promise((res, rej) => {
							const t = setTimeout(() => rej(new Error(`WS waitForFrom timed out (${timeoutMs}ms)`)), timeoutMs);
							waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); }, rej });
						});
					},
					messageCount: () => messages.length,
					send: (m) => ws.send(JSON.stringify(m)),
					close: () => ws.close(),
				});
			}
		}, 50);

		setTimeout(() => { clearInterval(iv); reject(new Error("WS auth timeout")); }, 10_000);
	});
}

/** Predicate: wait for a tool_execution_start event with the given tool name. */
export function toolStartPredicate(toolName: string): (m: WsMsg) => boolean {
	const lower = toolName.toLowerCase();
	return (m) =>
		m.type === "event" &&
		m.data?.type === "tool_execution_start" &&
		(m.data?.toolName || "").toLowerCase() === lower;
}

/** Predicate: wait for agent_end (turn finished). */
export function agentEndPredicate(): (m: WsMsg) => boolean {
	return (m) => m.type === "event" && m.data?.type === "agent_end";
}

/** Predicate: wait for session_status with a specific status. */
export function statusPredicate(status: string): (m: WsMsg) => boolean {
	return (m) => m.type === "session_status" && m.status === status;
}

/** Predicate: wait for a queue_update with a specific queue length. */
export function queueLenPredicate(len: number): (m: WsMsg) => boolean {
	return (m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === len;
}

/** Predicate: wait for event > message_end with a specific role. */
export function messageEndPredicate(role: string): (m: WsMsg) => boolean {
	return (m) => m.type === "event" && m.data?.type === "message_end" && m.data?.message?.role === role;
}

// ---------------------------------------------------------------------------
// WebSocket gate helpers — faster than REST polling for gate status changes
// ---------------------------------------------------------------------------

/**
 * Signal a gate via REST and wait for it to reach the target status via WebSocket.
 *
 * Race-safe: captures the WS message cursor BEFORE the signal, so re-signals
 * correctly wait for the NEW event instead of matching a stale one in the buffer.
 *
 * Usage:
 *   await signalAndWaitForGate(ws, goalId, "design-doc", { content: "..." }, "passed");
 */
export async function signalAndWaitForGate(
	conn: WsConnection,
	goalId: string,
	gateId: string,
	body: Record<string, unknown>,
	targetStatus: string | string[],
	timeoutMs = 15_000,
): Promise<WsMsg> {
	const statuses = Array.isArray(targetStatus) ? targetStatus : [targetStatus];
	const cursor = conn.messageCount();
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`signal ${gateId} failed: ${res.status} ${text}`);
	}
	return conn.waitForFrom(
		cursor,
		(m) => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === gateId && statuses.includes(m.status),
		timeoutMs,
	);
}

// ---------------------------------------------------------------------------
// Polling helpers (Category 1: infrastructure readiness)
// ---------------------------------------------------------------------------

/**
 * Poll the health endpoint until the server is ready.
 * Replaces fixed `setTimeout` startup sleeps.
 */
export async function waitForHealth(timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const resp = await fetch(`${base()}/api/health`, {
				headers: { Authorization: `Bearer ${token()}` },
			});
			if (resp.ok) return;
		} catch {
			// Server not yet listening
		}
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

/**
 * Poll a session's status until it matches the target.
 * Replaces fixed `setTimeout` waits and manual poll loops.
 */
/**
 * Poll a synchronous probe until it returns truthy. The poll interval
 * defaults to 25 ms which is short enough to keep the assertion timing
 * tight without burning CPU. Throws on timeout.
 */
export async function waitForCondition(
	probe: () => boolean,
	opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
	const { timeoutMs = 5_000, intervalMs = 25, message = "condition" } = opts;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (probe()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	if (!probe()) throw new Error(`Timed out (${timeoutMs}ms) waiting for ${message}`);
}

/**
 * Assert that a synchronous probe stays falsy for a fixed duration.
 * Used for negative assertions ("X must NOT happen within Yms").
 * Polls every `intervalMs` so we fail fast on the first violation
 * rather than waiting the full window.
 */
export async function assertStaysFalse(
	probe: () => boolean,
	opts: { durationMs: number; intervalMs?: number; message?: string },
): Promise<void> {
	const { durationMs, intervalMs = 25, message = "condition" } = opts;
	const end = Date.now() + durationMs;
	while (Date.now() < end) {
		if (probe()) throw new Error(`Unexpected: ${message} became true within ${durationMs}ms`);
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

export async function waitForSessionStatus(
	sessionId: string,
	targetStatus: string,
	timeoutMs = 15_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (resp.ok) {
				const data = await resp.json();
				if (data.status === targetStatus) return;
			}
		} catch {
			// Session may not exist yet
		}
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error(`Session ${sessionId} did not reach "${targetStatus}" within ${timeoutMs}ms`);
}
