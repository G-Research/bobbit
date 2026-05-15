/**
 * LSP request authorization — host-side cwd boundary check.
 *
 * `/api/lsp/*` accepts a `cwd` from the request body/query and hands it to
 * `LspSupervisor`, which uses `findProjectRoot()` to walk up from there to
 * locate a tsconfig/package.json. Without an authorization check, any
 * caller holding a gateway bearer token (admin or sandbox-scoped, if the
 * sandbox guard ever changes) can ask the gateway to spawn an LSP server
 * outside of an authorized project worktree.
 *
 * This module resolves the set of authorized cwd prefixes from:
 *   - every registered project's `rootPath` and worktree root
 *     (`worktree_root` config or `<rootPath>-wt` default),
 *   - the gateway's own project root (covers dev fixtures used by the
 *     e2e `tests/e2e/lsp.spec.ts` suite — see Definition of Done).
 *
 * For sandbox-scoped callers (defense-in-depth — the sandbox guard
 * currently blocks `/api/lsp/*` entirely), the cwd MUST resolve inside the
 * scoped project's own worktree. Reaching the LSP supervisor through a
 * sandbox token is itself a misconfiguration, so we fail closed.
 *
 * Pinned by `tests/lsp/authorize-cwd.spec.ts` (unit) and
 * `tests/e2e/lsp-auth.spec.ts` (e2e regression for malicious cwd).
 */
import path from "node:path";
import type { ProjectContextManager } from "../agent/project-context-manager.js";
import type { SandboxScope } from "../auth/sandbox-token.js";

export interface AuthorizeCwdContext {
	projectContextManager: ProjectContextManager;
	gatewayProjectRoot: string;
	sandboxScope?: SandboxScope | undefined;
	/**
	 * Operator/test-only escape hatch. Comma- or colon-separated absolute
	 * paths that are also accepted as authorized worktree roots. When unset
	 * the helper reads from `BOBBIT_LSP_AUTHORIZED_ROOTS` instead.
	 *
	 * Intended use: the API LSP E2Es (`tests/e2e/lsp.spec.ts`) point the
	 * supervisor at a host fixture under `tests/fixtures/lsp-ts/` that is
	 * NOT registered as a Bobbit project. The harness sets this env var to
	 * keep the legitimate, admin-Bearer test surface working without
	 * reintroducing the arbitrary-cwd hole for sandbox/agent callers.
	 */
	extraAuthorizedRoots?: string[] | undefined;
}

function parseEnvRoots(): string[] {
	const raw = process.env.BOBBIT_LSP_AUTHORIZED_ROOTS;
	if (!raw) return [];
	return raw
		.split(/[,:]/)
		.map(s => s.trim())
		.filter(s => s.length > 0 && path.isAbsolute(s))
		.map(s => path.resolve(s));
}

export type AuthorizeCwdReason =
	| "missing_cwd"
	| "cwd_not_absolute"
	| "cwd_outside_authorized_worktree"
	| "sandbox_scope_project_mismatch"
	| "sandbox_project_not_configured";

export interface AuthorizeCwdOk { ok: true; cwd: string; }
export interface AuthorizeCwdFail {
	ok: false;
	reason: AuthorizeCwdReason;
	message: string;
	/** HTTP status the route handler should return. */
	status: number;
}

interface ProjectRoot {
	projectId: string;
	root: string;
	/** True iff this project is opted into the docker sandbox. */
	sandboxConfigured: boolean;
}

/**
 * Enumerate every authorized project worktree prefix the gateway is willing
 * to spawn an LSP server inside. Returns one entry per (project, root) pair —
 * for each project we add both the source `rootPath` and its worktree root
 * (cwd of session worktrees lives inside the latter).
 */
export function collectAuthorizedProjectRoots(
	pcm: ProjectContextManager,
): ProjectRoot[] {
	const out: ProjectRoot[] = [];
	const seen = new Set<string>();
	for (const ctx of pcm.all()) {
		const projectId = ctx.project.id ?? ctx.project.name;
		const cfg = ctx.projectConfigStore;
		const sandboxConfigured =
			(cfg as unknown as { get?(k: string): string | undefined })?.get?.("sandbox") === "docker";
		const rootPath = path.resolve(ctx.project.rootPath);
		const configuredWorktreeRoot =
			(cfg as unknown as { get?(k: string): string | undefined })?.get?.("worktree_root");
		const worktreeRoot = path.resolve(configuredWorktreeRoot ?? rootPath + "-wt");
		for (const r of [rootPath, worktreeRoot]) {
			const k = `${projectId}::${r}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push({ projectId, root: r, sandboxConfigured });
		}
	}
	return out;
}

function within(child: string, parent: string): boolean {
	if (child === parent) return true;
	return child.startsWith(parent + path.sep);
}

/**
 * Validate that `rawCwd` is an absolute path inside an authorized worktree.
 *
 * For sandbox-scoped callers the cwd MUST belong to the scoped project's
 * own worktree (sandbox-configured projects only). For admin/cookie
 * callers the cwd must lie inside any registered project's root/worktree
 * root, or inside the gateway repo (fixtures).
 */
export function authorizeLspCwd(
	rawCwd: unknown,
	ctx: AuthorizeCwdContext,
): AuthorizeCwdOk | AuthorizeCwdFail {
	if (typeof rawCwd !== "string" || rawCwd.length === 0) {
		return {
			ok: false, reason: "missing_cwd", status: 400,
			message: "cwd is required",
		};
	}
	if (!path.isAbsolute(rawCwd)) {
		return {
			ok: false, reason: "cwd_not_absolute", status: 400,
			message: "cwd must be an absolute path",
		};
	}
	const cwd = path.resolve(rawCwd);
	const roots = collectAuthorizedProjectRoots(ctx.projectContextManager);

	// Sandbox-scoped callers: must resolve into the scoped project's own
	// sandbox-configured worktree. Anything else fails closed.
	if (ctx.sandboxScope) {
		const projectId = ctx.sandboxScope.projectId;
		const scopedRoots = roots.filter(r => r.projectId === projectId);
		if (scopedRoots.length === 0) {
			return {
				ok: false, reason: "sandbox_project_not_configured", status: 403,
				message: "sandbox project has no registered worktree",
			};
		}
		const sandboxOk = scopedRoots.some(r => r.sandboxConfigured && within(cwd, r.root));
		if (!sandboxOk) {
			return {
				ok: false, reason: "sandbox_scope_project_mismatch", status: 403,
				message: "cwd is outside the sandbox project's worktree",
			};
		}
		return { ok: true, cwd };
	}

	// Admin/cookie callers — gateway repo (covers fixtures) OR any
	// registered project's worktree root. The extra-roots escape hatch is
	// admin-only by construction: sandbox-scoped callers were resolved
	// above before any extra root is consulted.
	const gatewayRoot = path.resolve(ctx.gatewayProjectRoot);
	if (within(cwd, gatewayRoot)) return { ok: true, cwd };
	for (const r of roots) {
		if (within(cwd, r.root)) return { ok: true, cwd };
	}
	const extras = (ctx.extraAuthorizedRoots ?? parseEnvRoots())
		.filter(r => path.isAbsolute(r))
		.map(r => path.resolve(r));
	for (const r of extras) {
		if (within(cwd, r)) return { ok: true, cwd };
	}
	return {
		ok: false,
		reason: "cwd_outside_authorized_worktree",
		status: 403,
		message:
			"cwd is outside every authorized project worktree (registered project or gateway repo)",
	};
}
