/**
 * Unit tests for `authorizeLspCwd` — the host-side cwd boundary check on
 * the `/api/lsp/*` route surface (security review 2026-05-15).
 *
 * The vulnerability the helper closes: `LspSupervisor.dispatch()` and
 * `resolveKey()` walk up from caller-supplied `cwd` with `findProjectRoot()`
 * and spawn an LSP server at the result. Without this check, anyone holding
 * a gateway bearer token could ask the gateway to spawn tsserver at `/etc/`
 * or any other host path.
 *
 * Pins:
 *   1. Absolute paths inside a registered project root/worktree are OK.
 *   2. Absolute paths inside the gateway repo are OK (covers the
 *      `tests/fixtures/lsp-ts` host fixture used by
 *      `tests/e2e/lsp.spec.ts` — keeping the legitimate E2E green is part
 *      of the goal's Definition of Done).
 *   3. Paths outside every authorized worktree are rejected with HTTP 403.
 *   4. Missing / non-absolute cwd is rejected with HTTP 400.
 *   5. Sandbox-scoped callers must resolve into THEIR project's
 *      sandbox-configured worktree — no other registered project is
 *      reachable, and host fixture paths are NOT a fallback.
 *   6. A sandbox scope pointing at a project without `sandbox: "docker"`
 *      fails closed (`sandbox_project_not_configured`).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { authorizeLspCwd, collectAuthorizedProjectRoots } from "../../src/server/lsp/authorize-cwd.ts";

type FakeCtx = {
	project: { id: string; name: string; rootPath: string };
	projectConfigStore: { get(key: string): unknown };
};

function makeCtx(opts: {
	id: string;
	rootPath: string;
	sandbox?: string;
	worktreeRoot?: string;
}): FakeCtx {
	const cfg: Record<string, unknown> = {};
	if (opts.sandbox !== undefined) cfg["sandbox"] = opts.sandbox;
	if (opts.worktreeRoot !== undefined) cfg["worktree_root"] = opts.worktreeRoot;
	return {
		project: { id: opts.id, name: opts.id, rootPath: opts.rootPath },
		projectConfigStore: { get: (k: string) => cfg[k] },
	};
}

function makePcm(ctxs: FakeCtx[]) {
	return { all: () => ctxs } as any;
}

const GATEWAY_ROOT = path.resolve("/tmp/bobbit-test/gateway-repo");
const PROJECT_A_ROOT = path.resolve("/tmp/bobbit-test/project-a");
const PROJECT_A_WT = path.resolve("/tmp/bobbit-test/project-a-wt");
const PROJECT_B_ROOT = path.resolve("/tmp/bobbit-test/project-b");

describe("authorizeLspCwd", () => {
	const ctxs = [
		makeCtx({ id: "proj-a", rootPath: PROJECT_A_ROOT, sandbox: "docker", worktreeRoot: PROJECT_A_WT }),
		makeCtx({ id: "proj-b", rootPath: PROJECT_B_ROOT }),
	];
	const pcm = makePcm(ctxs);
	const baseCtx = { projectContextManager: pcm, gatewayProjectRoot: GATEWAY_ROOT };

	test("accepts cwd inside a registered project root", () => {
		const r = authorizeLspCwd(path.join(PROJECT_A_ROOT, "src"), baseCtx);
		assert.equal(r.ok, true);
	});

	test("accepts cwd inside a registered project's worktree root", () => {
		const r = authorizeLspCwd(path.join(PROJECT_A_WT, "session-x/repo"), baseCtx);
		assert.equal(r.ok, true);
	});

	test("accepts cwd inside the gateway project root (covers host fixtures)", () => {
		const r = authorizeLspCwd(path.join(GATEWAY_ROOT, "tests/fixtures/lsp-ts"), baseCtx);
		assert.equal(r.ok, true);
	});

	test("rejects cwd outside every authorized worktree with 403", () => {
		const r = authorizeLspCwd("/etc", baseCtx);
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "cwd_outside_authorized_worktree");
		assert.equal(r.status, 403);
	});

	test("rejects a path that LOOKS LIKE a project root prefix but isn't (foo-attacker outside foo)", () => {
		const r = authorizeLspCwd(PROJECT_A_ROOT + "-attacker", baseCtx);
		assert.equal(r.ok, false);
	});

	test("rejects missing cwd with 400", () => {
		const r = authorizeLspCwd(undefined, baseCtx);
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "missing_cwd");
		assert.equal(r.status, 400);
	});

	test("rejects empty cwd with 400", () => {
		const r = authorizeLspCwd("", baseCtx);
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "missing_cwd");
	});

	test("rejects non-absolute cwd with 400", () => {
		const r = authorizeLspCwd("relative/path", baseCtx);
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "cwd_not_absolute");
		assert.equal(r.status, 400);
	});

	test("rejects non-string cwd with 400", () => {
		const r = authorizeLspCwd(42, baseCtx);
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "missing_cwd");
	});

	test("resolves traversal segments before matching", () => {
		// `<gw>/x/../etc` resolves to `<gw>/etc` which is inside the gateway
		// root and therefore authorized — the helper does NOT need to flag
		// `..` segments separately, just match the resolved path.
		const r = authorizeLspCwd(`${GATEWAY_ROOT}/x/../sub`, baseCtx);
		assert.equal(r.ok, true);

		// `<projectA>/../etc` resolves outside the project — must fail.
		const r2 = authorizeLspCwd(`${PROJECT_A_ROOT}/../../../etc`, baseCtx);
		assert.equal(r2.ok, false);
	});

	test("collectAuthorizedProjectRoots emits root + worktree for each project", () => {
		const roots = collectAuthorizedProjectRoots(pcm);
		const aRoots = roots.filter(r => r.projectId === "proj-a").map(r => r.root).sort();
		assert.deepEqual(aRoots, [PROJECT_A_ROOT, PROJECT_A_WT].sort());
		const bRoots = roots.filter(r => r.projectId === "proj-b").map(r => r.root).sort();
		// proj-b had no worktree_root config, so the helper synthesizes
		// `<rootPath>-wt`.
		assert.deepEqual(bRoots, [PROJECT_B_ROOT, PROJECT_B_ROOT + "-wt"].sort());
	});
});

describe("authorizeLspCwd — BOBBIT_LSP_AUTHORIZED_ROOTS escape hatch", () => {
	const ctxs = [makeCtx({ id: "proj-a", rootPath: PROJECT_A_ROOT })];
	const pcm = makePcm(ctxs);
	const FIXTURE = path.resolve("/tmp/bobbit-test/fixture-host-only");

	test("explicit extraAuthorizedRoots authorizes paths outside every project", () => {
		const r = authorizeLspCwd(FIXTURE + "/sub", {
			projectContextManager: pcm,
			gatewayProjectRoot: GATEWAY_ROOT,
			extraAuthorizedRoots: [FIXTURE],
		});
		assert.equal(r.ok, true);
	});

	test("env-var BOBBIT_LSP_AUTHORIZED_ROOTS is consulted when no explicit list passed", () => {
		const prev = process.env.BOBBIT_LSP_AUTHORIZED_ROOTS;
		process.env.BOBBIT_LSP_AUTHORIZED_ROOTS = `${FIXTURE},/another/path`;
		try {
			const r = authorizeLspCwd(FIXTURE, {
				projectContextManager: pcm,
				gatewayProjectRoot: GATEWAY_ROOT,
			});
			assert.equal(r.ok, true);
		} finally {
			if (prev === undefined) delete process.env.BOBBIT_LSP_AUTHORIZED_ROOTS;
			else process.env.BOBBIT_LSP_AUTHORIZED_ROOTS = prev;
		}
	});

	test("extras list is IGNORED for sandbox-scoped callers", () => {
		const sandboxCtxs = [makeCtx({ id: "proj-a", rootPath: PROJECT_A_ROOT, sandbox: "docker", worktreeRoot: PROJECT_A_WT })];
		const sandboxPcm = makePcm(sandboxCtxs);
		const r = authorizeLspCwd(FIXTURE, {
			projectContextManager: sandboxPcm,
			gatewayProjectRoot: GATEWAY_ROOT,
			extraAuthorizedRoots: [FIXTURE],
			sandboxScope: { projectId: "proj-a", goalIds: new Set(), sessionIds: new Set() },
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "sandbox_scope_project_mismatch");
	});

	test("non-absolute entries in the env list are ignored", () => {
		const prev = process.env.BOBBIT_LSP_AUTHORIZED_ROOTS;
		process.env.BOBBIT_LSP_AUTHORIZED_ROOTS = `relative-path,${FIXTURE}`;
		try {
			const r = authorizeLspCwd(FIXTURE, {
				projectContextManager: pcm,
				gatewayProjectRoot: GATEWAY_ROOT,
			});
			assert.equal(r.ok, true);
			// A path matching the bogus relative entry must NOT be authorized.
			const r2 = authorizeLspCwd("/relative-path/x", {
				projectContextManager: pcm,
				gatewayProjectRoot: GATEWAY_ROOT,
			});
			assert.equal(r2.ok, false);
		} finally {
			if (prev === undefined) delete process.env.BOBBIT_LSP_AUTHORIZED_ROOTS;
			else process.env.BOBBIT_LSP_AUTHORIZED_ROOTS = prev;
		}
	});
});

describe("authorizeLspCwd — sandbox scope (defense-in-depth)", () => {
	const ctxs = [
		makeCtx({ id: "proj-a", rootPath: PROJECT_A_ROOT, sandbox: "docker", worktreeRoot: PROJECT_A_WT }),
		makeCtx({ id: "proj-b", rootPath: PROJECT_B_ROOT }), // no sandbox
	];
	const pcm = makePcm(ctxs);

	function withScope(projectId: string) {
		return {
			projectContextManager: pcm,
			gatewayProjectRoot: GATEWAY_ROOT,
			sandboxScope: { projectId, goalIds: new Set<string>(), sessionIds: new Set<string>() },
		};
	}

	test("accepts cwd inside the scoped sandbox project's worktree", () => {
		const r = authorizeLspCwd(path.join(PROJECT_A_WT, "session-1"), withScope("proj-a"));
		assert.equal(r.ok, true);
	});

	test("rejects cwd inside the gateway repo (sandbox tokens cannot reach fixtures)", () => {
		const r = authorizeLspCwd(GATEWAY_ROOT, withScope("proj-a"));
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "sandbox_scope_project_mismatch");
		assert.equal(r.status, 403);
	});

	test("rejects cwd inside a DIFFERENT registered project's worktree", () => {
		const r = authorizeLspCwd(PROJECT_B_ROOT, withScope("proj-a"));
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "sandbox_scope_project_mismatch");
	});

	test("fails closed when the scope points at a project without sandbox: docker", () => {
		const r = authorizeLspCwd(PROJECT_B_ROOT, withScope("proj-b"));
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "sandbox_scope_project_mismatch");
	});

	test("fails closed when the scoped project is not registered at all", () => {
		const r = authorizeLspCwd(PROJECT_A_ROOT, withScope("missing-project"));
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "sandbox_project_not_configured");
		assert.equal(r.status, 403);
	});

	test("rejects malicious cwd outside any authorized worktree under sandbox scope too", () => {
		const r = authorizeLspCwd("/etc", withScope("proj-a"));
		assert.equal(r.ok, false);
	});
});
