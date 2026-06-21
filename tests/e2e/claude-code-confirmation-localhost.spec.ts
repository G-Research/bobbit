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

test("localhost browser operator confirmation succeeds but bearer/token cookie bootstrap cannot self-confirm", async () => {
	const envSnapshot: Record<string, string | undefined> = {};
	for (const key of MUTATED_ENV_KEYS) envSnapshot[key] = process.env[key];
	const bobbitDir = join(tmpdir(), `bobbit-local-confirm-${process.pid}-${Date.now()}`);
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
			forceAuth: false,
			agentCliPath: MOCK_AGENT,
		});
		const port = await gw.start();
		const base = `http://127.0.0.1:${port}`;
		const patch = { "claudeCode.executablePath": join(tmpdir(), `local-confirm-${process.pid}`) };
		const cookieFrom = async (resp: Response): Promise<string> => {
			const cookie = resp.headers.get("set-cookie")?.split(";")[0];
			if (!cookie) throw new Error("expected Set-Cookie");
			return cookie;
		};
		const expectConfirmationRejected = async (cookie: string): Promise<void> => {
			const resp = await fetch(`${base}/api/preferences/claude-code/confirmation`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			expect(resp.status).toBe(403);
		};

		const bearerHealthCookie = await cookieFrom(await fetch(`${base}/api/health`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			},
		}));
		await expectConfirmationRejected(bearerHealthCookie);

		const tokenQueryCookie = await cookieFrom(await fetch(`${base}/api/health?token=${encodeURIComponent(token)}`));
		await expectConfirmationRejected(tokenQueryCookie);

		const operatorCookie = await cookieFrom(await fetch(`${base}/api/health`));
		const confirmation = await fetch(`${base}/api/preferences/claude-code/confirmation`, {
			method: "POST",
			headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		expect(confirmation.status).toBe(200);
		const confirmationToken = (await confirmation.json()).confirmationToken;
		expect(confirmationToken).toBeTruthy();
		const update = await fetch(`${base}/api/preferences`, {
			method: "PUT",
			headers: { Cookie: operatorCookie, "Content-Type": "application/json", "X-Bobbit-Operator-Confirmation": confirmationToken },
			body: JSON.stringify(patch),
		});
		expect(update.status).toBe(200);
		const prefs = await (await fetch(`${base}/api/preferences`, { headers: { Cookie: operatorCookie } })).json();
		expect(prefs["claudeCode.executablePath"]).toBe(patch["claudeCode.executablePath"]);
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
