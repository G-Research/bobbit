import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI_PATH = join(REPO_ROOT, "src", "server", "cli.ts");
// Activated by the concurrently developed foundation branch after local merge.
const BASE_PATH_IMPLEMENTED = existsSync(join(REPO_ROOT, "src", "shared", "base-path.ts"));
const roots: string[] = [];

interface CliProcess {
	child: ChildProcessWithoutNullStreams;
	root: string;
	bobbitDir: string;
	output(): string;
	waitForExit(): Promise<number | null>;
}

function tempRoot(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `bobbit-base-path-${label}-`));
	roots.push(root);
	return root;
}

function cliEnv(root: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		BOBBIT_DIR: join(root, ".bobbit"),
		BOBBIT_SECRETS_DIR: join(root, "secrets"),
		BOBBIT_AGENT_DIR: join(root, "agent"),
		BOBBIT_NO_OPEN: "1",
		BOBBIT_SKIP_AIGW_DISCOVERY: "1",
		BOBBIT_SKIP_MCP: "1",
		BOBBIT_SKIP_WORKTREE_POOL: "1",
		BOBBIT_SKIP_TITLE_GEN: "1",
		BOBBIT_LLM_REVIEW_SKIP: "1",
		BOBBIT_TEST_NO_PUSH: "1",
		BOBBIT_TEST_NO_REMOTE: "1",
		BOBBIT_TEST_NO_EXTERNAL: "1",
		NODE_ENV: "test",
		...overrides,
	};
	for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
	return env;
}

function startCli(args: string[], envOverrides: Record<string, string | undefined> = {}): CliProcess {
	const root = tempRoot("cli");
	const bobbitDir = join(root, ".bobbit");
	mkdirSync(root, { recursive: true });
	let combined = "";
	const child = spawn(process.execPath, ["--import", "tsx", CLI_PATH, "--cwd", root, ...args], {
		cwd: REPO_ROOT,
		env: cliEnv(root, envOverrides),
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { combined += chunk; });
	child.stderr.on("data", (chunk: string) => { combined += chunk; });
	const exit = new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
	return { child, root, bobbitDir, output: () => combined, waitForExit: () => exit };
}

async function waitUntil(predicate: () => boolean, process: CliProcess, timeoutMs = 90_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		if (process.child.exitCode !== null) {
			throw new Error(`CLI exited before readiness with ${process.child.exitCode}:\n${process.output()}`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`Timed out waiting for CLI readiness:\n${process.output()}`);
}

async function stopCli(process: CliProcess): Promise<void> {
	if (process.child.exitCode !== null) return;
	process.child.kill("SIGTERM");
	const exited = await Promise.race([
		process.waitForExit().then(() => true),
		new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 10_000)),
	]);
	if (!exited && process.child.exitCode === null) {
		process.child.kill("SIGKILL");
		await process.waitForExit();
	}
}

function runInvalidCli(label: string, args: string[], overrides: Record<string, string | undefined> = {}) {
	const root = tempRoot(label);
	const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, "--cwd", root, ...args], {
		cwd: REPO_ROOT,
		env: cliEnv(root, overrides),
		encoding: "utf8",
		timeout: 45_000,
	});
	return { root, result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("actual base-path CLI startup", () => {
	it("runs the executable with an invalid env overridden by a valid flag and advertises only the mounted actual-port URL", async () => {
		const cli = startCli([
			"--host", "127.0.0.1",
			"--port", "0",
			"--no-tls",
			"--no-ui",
			"--base-path", "/team/cli",
		], { BOBBIT_BASE_PATH: "/unsafe%2fenv" });
		try {
			const gatewayUrlPath = join(cli.bobbitDir, "state", "gateway-url");
			await waitUntil(() => existsSync(gatewayUrlPath) && /Listening:\s+http:/.test(cli.output()), cli);

			const persisted = readFileSync(gatewayUrlPath, "utf8").trim();
			expect(persisted).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/team\/cli$/);
			const port = Number(new URL(persisted).port);
			expect(port).toBeGreaterThan(0);

			expect(cli.output()).toMatch(new RegExp(`Listening:\\s+http://127\\.0\\.0\\.1:${port}/team/cli`));
			expect(cli.output()).toMatch(/token auth(?:entication)? (?:is )?disabled/i);
			expect(cli.output()).not.toMatch(/Auth token:/i);
			expect(cli.output()).not.toMatch(/token grants full shell access/i);
			expect(cli.output()).not.toContain("?token=");

			const mountedHealth = await fetch(`${persisted}/api/health`);
			expect(mountedHealth.status).toBe(200);
			expect(await mountedHealth.json()).toMatchObject({ status: "ok" });
			const origin = new URL(persisted).origin;
			expect((await fetch(`${origin}/api/health`)).status).toBe(404);
			expect((await fetch(`${origin}/`, { redirect: "manual" })).status).toBe(404);
			const redirect = await fetch(`${origin}/team/cli?copied=1`, { redirect: "manual" });
			expect(redirect.status).toBe(301);
			expect(redirect.headers.get("location")).toBe("/team/cli/?copied=1");

			const stateNames = readdirSync(join(cli.bobbitDir, "state"));
			expect(stateNames.some((name) => /^gateway-url\..*tmp/i.test(name))).toBe(false);
		} finally {
			await stopCli(cli);
		}
	}, 120_000);

	it.each([
		{ label: "selected unsafe environment", args: ["--host", "127.0.0.1", "--port", "0", "--no-tls", "--no-ui"], env: { BOBBIT_BASE_PATH: "/bad%2fpath" } },
		{ label: "missing final flag value", args: ["--host", "127.0.0.1", "--port", "0", "--no-tls", "--no-ui", "--base-path"], env: {} },
		{ label: "next token is another option", args: ["--host", "127.0.0.1", "--port", "0", "--no-tls", "--no-ui", "--base-path", "--auth"], env: {} },
	])("rejects $label before state, token, listener, or opener side effects", ({ label, args, env }) => {
		const failed = runInvalidCli(label.replaceAll(" ", "-"), args, env);
		expect(failed.result.error, failed.output).toBeUndefined();
		expect(failed.result.status, failed.output).toBe(1);
		expect(failed.output).toMatch(/base[ -]?path/i);
		expect(existsSync(join(failed.root, ".bobbit", "state", "gateway-url"))).toBe(false);
		expect(existsSync(join(failed.root, "secrets", "token"))).toBe(false);
	}, 60_000);

	it("exports the same runCli boundary used by the executable for injected startup tests", async () => {
		const cliModule = await import("../../src/server/cli.js") as Record<string, unknown>;
		expect(typeof cliModule.runCli).toBe("function");
	});
});
