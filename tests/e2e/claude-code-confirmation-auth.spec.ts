import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");

const MUTATED_ENV_KEYS = [
	"BOBBIT_DIR",
	"BOBBIT_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"BOBBIT_SKIP_MCP",
	"NODE_ENV",
	"BOBBIT_SKIP_AIGW_DISCOVERY",
	"BOBBIT_SKIP_TITLE_GEN",
	"BOBBIT_SKIP_WORKTREE_POOL",
] as const;

/**
 * QA-LOG 2026-07-04 Finding 1: with --auth enabled (forceAuth), the operator
 * confirmation flow was structurally broken — operator-capable cookies were
 * only minted by the credential-free localhost /api/health bootstrap, which
 * never runs in auth mode, so every confirmation mint 403'd.
 *
 * This spec pins the auth-mode elevation path (POST /api/auth/operator-elevate)
 * end-to-end AND the negative security properties: session-bound headers,
 * implicit bearer-minted cookies, and raw token REST calls must NOT gain
 * operator capability. The no-auth path is pinned separately by
 * claude-code-confirmation-localhost.spec.ts.
 */
test("auth-mode browser can elevate to operator and complete the confirmation flow; token/session-bound callers cannot", async () => {
	const envSnapshot: Record<string, string | undefined> = {};
	for (const key of MUTATED_ENV_KEYS) envSnapshot[key] = process.env[key];
	const bobbitDir = join(tmpdir(), `bobbit-auth-confirm-${process.pid}-${Date.now()}`);
	const agentDir = join(bobbitDir, "agent");
	mkdirSync(join(bobbitDir, "state"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");
	writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
	process.env.BOBBIT_DIR = bobbitDir;
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.NODE_ENV = "test";
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_SKIP_TITLE_GEN = "1";
	process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";

	let gw: any;
	try {
		const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
		const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
		const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
		const { createGateway } = await import("../../dist/server/server.js");
		setProjectRoot(bobbitDir);
		scaffoldBobbitDir(bobbitDir);
		const token = loadOrCreateToken();
		gw = createGateway({
			host: "127.0.0.1",
			port: 0,
			portExplicit: true,
			authToken: token,
			defaultCwd: bobbitDir,
			forceAuth: true, // --auth mode: the localhost cookie bootstrap never runs
			agentCliPath: MOCK_AGENT,
		});
		const port = await gw.start();
		const base = `http://127.0.0.1:${port}`;
		const patch = { "claudeCode.executablePath": join(tmpdir(), `auth-confirm-${process.pid}`) };
		const cookieFrom = (resp: Response): string | undefined =>
			resp.headers.get("set-cookie")?.split(";")[0] || undefined;
		const mintConfirmation = (headers: Record<string, string>): Promise<Response> =>
			fetch(`${base}/api/preferences/claude-code/confirmation`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify(patch),
			});

		// ── Negative: implicit cookies minted to bearer API traffic are NOT operator-capable.
		const bearerResp = await fetch(`${base}/api/preferences`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(bearerResp.status).toBe(200);
		const apiCookie = cookieFrom(bearerResp);
		expect(apiCookie).toBeTruthy();
		expect((await mintConfirmation({ Cookie: apiCookie! })).status).toBe(403);

		// ── Negative: elevation without any credential is rejected by the auth layer.
		expect((await fetch(`${base}/api/auth/operator-elevate`, { method: "POST" })).status).toBe(401);

		// ── Negative: session-bound callers cannot elevate, even with the admin token.
		const sessionBoundElevate = await fetch(`${base}/api/auth/operator-elevate`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Bobbit-Session-Id": "some-session" },
		});
		expect(sessionBoundElevate.status).toBe(403);
		const sessionBoundCookie = cookieFrom(sessionBoundElevate);
		if (sessionBoundCookie) {
			// Any cookie incidentally minted by the auth layer must still be non-operator.
			expect((await mintConfirmation({ Cookie: sessionBoundCookie })).status).toBe(403);
		}

		// ── Negative: an existing (non-operator) cookie alone cannot elevate — the
		// explicit admin token is required in auth mode.
		const cookieOnlyElevate = await fetch(`${base}/api/auth/operator-elevate`, {
			method: "POST",
			headers: { Cookie: apiCookie! },
		});
		expect(cookieOnlyElevate.status).toBe(403);

		// ── Happy path: browser (has admin token from the tokenized URL) elevates,
		// upgrading its preview/API cookie to an operator-capable one.
		const elevate = await fetch(`${base}/api/auth/operator-elevate`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, Cookie: apiCookie! },
		});
		expect(elevate.status).toBe(200);
		expect(await elevate.json()).toMatchObject({ ok: true, operator: true });
		const operatorCookie = cookieFrom(elevate);
		expect(operatorCookie).toBeTruthy();
		expect(operatorCookie).not.toBe(apiCookie);

		// ── Negative: even with the operator cookie, a request that carries an
		// Authorization header is treated as API traffic and cannot mint.
		expect((await mintConfirmation({ Cookie: operatorCookie!, Authorization: `Bearer ${token}` })).status).toBe(403);

		// Cookie-only mint succeeds now.
		const confirmation = await mintConfirmation({ Cookie: operatorCookie! });
		expect(confirmation.status).toBe(200);
		const confirmationToken = (await confirmation.json()).confirmationToken;
		expect(confirmationToken).toBeTruthy();

		// ── Negative: raw token REST writes of sensitive prefs still 403 without a permit.
		const rawTokenPut = await fetch(`${base}/api/preferences`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		expect(rawTokenPut.status).toBe(403);
		expect(await rawTokenPut.json()).toMatchObject({ confirmationRequired: true });

		// ── Happy path: gated PUT with the permit persists the value.
		const update = await fetch(`${base}/api/preferences`, {
			method: "PUT",
			headers: { Cookie: operatorCookie!, "Content-Type": "application/json", "X-Bobbit-Operator-Confirmation": confirmationToken },
			body: JSON.stringify(patch),
		});
		expect(update.status).toBe(200);
		const prefs = await (await fetch(`${base}/api/preferences`, { headers: { Cookie: operatorCookie! } })).json();
		expect(prefs["claudeCode.executablePath"]).toBe(patch["claudeCode.executablePath"]);

		// ── Negative: permits are single-use — replay is refused.
		const replay = await fetch(`${base}/api/preferences`, {
			method: "PUT",
			headers: { Cookie: operatorCookie!, "Content-Type": "application/json", "X-Bobbit-Operator-Confirmation": confirmationToken },
			body: JSON.stringify(patch),
		});
		expect(replay.status).toBe(403);
	} finally {
		if (gw) await gw.shutdown().catch(() => undefined);
		for (const key of MUTATED_ENV_KEYS) {
			const prev = envSnapshot[key];
			if (prev === undefined) delete process.env[key];
			else process.env[key] = prev;
		}
		if (existsSync(bobbitDir)) rmSync(bobbitDir, { recursive: true, force: true });
		try {
			const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
			setProjectRoot(PROJECT_ROOT);
		} catch { /* ignore */ }
	}
});
