import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { awaitableRm, pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, "src", "server", "cli.ts");
const BUILT_CLI_ENTRY = join(REPO_ROOT, "dist", "server", "cli.js");
const MOUNT = "/team/cli-smoke";
const SHELL_MARKER = "EXECUTABLE_CLI_MOUNT_SMOKE";
const ASSET_MARKER = "EXECUTABLE_CLI_STATIC_ASSET_OK";

interface ExitResult {
	code: number | null;
	signal: NodeJS.Signals | null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ExitResult> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolveExit, reject) => {
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			clearTimeout(timer);
			resolveExit({ code, signal });
		};
		const timer = setTimeout(() => {
			child.off("close", onClose);
			reject(new Error(`executable CLI did not terminate within ${timeoutMs}ms`));
		}, timeoutMs);
		child.once("close", onClose);
	});
}

async function forceStop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGKILL");
	await waitForExit(child, 5_000);
}

function listen(server: Server): Promise<number> {
	return new Promise((resolvePort, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("port guard did not publish a TCP address"));
				return;
			}
			resolvePort(address.port);
		});
	});
}

function close(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolveClose, reject) => {
		server.close((error) => error ? reject(error) : resolveClose());
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("executable CLI root and nested base-path smoke", () => {
	it("prints only the package version and exits before all gateway side effects", async () => {
		const packageMetadata = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
			version: string;
			bin: { bobbit: string };
		};
		expect(packageMetadata.bin.bobbit).toBe("dist/server/cli.js");
		const packageBinEntry = resolve(REPO_ROOT, packageMetadata.bin.bobbit);
		expect(packageBinEntry).toBe(BUILT_CLI_ENTRY);
		expect(existsSync(packageBinEntry), "the package bin target must be built before executable coverage").toBe(true);

		const root = mkdtempSync(join(tmpdir(), "bobbit-cli-version-"));
		const projectRoot = join(root, "project");
		const headquartersDir = join(root, "headquarters");
		const secretsTrapParent = join(root, "secrets-trap");
		const agentTrapParent = join(root, "agent-trap");
		const secretsDir = join(secretsTrapParent, "secrets");
		const agentDir = join(agentTrapParent, "agent");
		mkdirSync(projectRoot, { recursive: true });
		// Any token or agent-dir initialization turns these regular-file parents into
		// a deterministic ENOTDIR failure instead of silently touching host state.
		writeFileSync(secretsTrapParent, "token access is forbidden\n", "utf8");
		writeFileSync(agentTrapParent, "agent initialization is forbidden\n", "utf8");

		const portGuard = createServer((socket) => socket.destroy());
		const guardedPort = await listen(portGuard);
		const childEnv: NodeJS.ProcessEnv = {
			...process.env,
			BOBBIT_DIR: headquartersDir,
			BOBBIT_SECRETS_DIR: secretsDir,
			BOBBIT_AGENT_DIR: agentDir,
			BOBBIT_PI_DIR: join(root, "legacy-headquarters"),
			PI_CODING_AGENT_DIR: join(root, "pi-agent"),
			BOBBIT_TEST_NO_EXTERNAL: "1",
			BOBBIT_TEST_NO_REMOTE: "1",
			PI_OFFLINE: "1",
			NODE_ENV: "production",
		};
		delete childEnv.BOBBIT_BASE_PATH;
		delete childEnv.BOBBIT_NO_OPEN;

		const startedAt = performance.now();
		const child = spawn(process.execPath, [
			packageBinEntry,
			"--version",
			"--cwd", projectRoot,
			"--host", "127.0.0.1",
			"--port", String(guardedPort),
			"--no-tls",
			"--no-ui",
		], {
			cwd: projectRoot,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

		try {
			const exit = await waitForExit(child, 5_000);
			const elapsedMs = performance.now() - startedAt;
			expect(exit).toEqual({ code: 0, signal: null });
			expect(elapsedMs, "--version must terminate promptly without starting a long-lived gateway").toBeLessThan(5_000);
			expect(stdout).toBe(`v${packageMetadata.version}\n`);
			expect(stderr).toBe("");
			expect(portGuard.listening, "the CLI must not replace or disturb the occupied gateway port").toBe(true);
			for (const forbiddenPath of [
				join(projectRoot, ".bobbit"),
				headquartersDir,
				secretsDir,
				agentDir,
				join(root, "legacy-headquarters"),
				join(root, "pi-agent"),
			]) {
				expect(existsSync(forbiddenPath), `--version created forbidden Bobbit state: ${forbiddenPath}`).toBe(false);
			}
		} finally {
			await forceStop(child);
			await close(portGuard);
			const cleanup = await awaitableRm(root, { maxAttempts: 3, backoffMs: 50 });
			expect(cleanup.removed, `isolated CLI version cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
		}
	});

	it("binds an ephemeral mounted gateway, persists its URL, serves it, and exits cleanly", async () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-cli-mount-smoke-"));
		const projectRoot = join(root, "project");
		const staticDir = join(root, "static");
		const headquartersDir = join(root, "headquarters");
		mkdirSync(join(staticDir, "assets"), { recursive: true });
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(staticDir, "index.html"), [
			"<!doctype html>",
			"<html><head>",
			'<script>window.__BOBBIT_BASE_PATH__ = "";</script>',
			'<script type="module" src="/assets/smoke.js"></script>',
			`</head><body>${SHELL_MARKER}</body></html>`,
		].join("\n"), "utf8");
		writeFileSync(join(staticDir, "assets", "smoke.js"), `${ASSET_MARKER}\n`, "utf8");

		const childEnv: NodeJS.ProcessEnv = {
			...process.env,
			BOBBIT_DIR: headquartersDir,
			BOBBIT_SECRETS_DIR: join(root, "secrets"),
			BOBBIT_AGENT_DIR: join(root, "agent"),
			BOBBIT_NO_OPEN: "1",
			BOBBIT_SKIP_AIGW_DISCOVERY: "1",
			BOBBIT_SKIP_MCP: "1",
			BOBBIT_SKIP_TITLE_GEN: "1",
			BOBBIT_SKIP_WORKTREE_POOL: "1",
			BOBBIT_TEST_NO_EXTERNAL: "1",
			BOBBIT_TEST_NO_REMOTE: "1",
			NODE_ENV: "test",
		};
		delete childEnv.BOBBIT_BASE_PATH;

		const child = spawn(process.execPath, [
			"--import", "tsx",
			CLI_ENTRY,
			"--cwd", projectRoot,
			"--host", "127.0.0.1",
			"--port", "0",
			"--no-tls",
			"--static", staticDir,
			"--base-path", MOUNT,
		], {
			cwd: REPO_ROOT,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

		try {
			const gatewayUrlPath = join(headquartersDir, "state", "gateway-url");
			const persistedUrl = await pollUntil(() => {
				if (child.exitCode !== null || child.signalCode !== null) {
					throw new Error(`CLI exited before publishing its gateway URL (${child.exitCode ?? child.signalCode})\n${output}`);
				}
				if (!existsSync(gatewayUrlPath)) return "";
				const value = readFileSync(gatewayUrlPath, "utf8").trim();
				const parsed = new URL(value);
				return parsed.port && parsed.port !== "0" ? value : "";
			}, { timeoutMs: 15_000, intervalMs: 50, label: "executable CLI persisted mounted URL" });

			const parsed = new URL(persistedUrl);
			expect(parsed.protocol).toBe("http:");
			expect(parsed.hostname).toBe("127.0.0.1");
			expect(parsed.port).toMatch(/^\d+$/);
			expect(parsed.port).not.toBe("0");
			expect(parsed.pathname).toBe(MOUNT);
			expect(parsed.search).toBe("");
			expect(parsed.hash).toBe("");
			expect(readFileSync(gatewayUrlPath, "utf8")).toBe(persistedUrl);

			await pollUntil(() => output.includes(`Listening:  ${persistedUrl}`)
				&& output.includes("Token authentication is disabled on this loopback bind."), {
				timeoutMs: 5_000,
				intervalMs: 25,
				label: "truthful executable CLI startup banner",
			});
			expect(output).toMatch(new RegExp(`Listening:\\s+${escapeRegExp(persistedUrl)}`));
			expect(output).toContain("Any local process can access the gateway. Use --auth to require the token.");
			expect(output).not.toMatch(/Auth token:/i);
			expect(output).not.toMatch(/token grants full shell access/i);
			expect(output).not.toContain("?token=");

			const health = await fetch(`${persistedUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
			expect(health.status).toBe(200);
			expect(await health.json()).toMatchObject({ status: "ok", localhost: true });

			const shell = await fetch(`${persistedUrl}/`, { signal: AbortSignal.timeout(5_000) });
			expect(shell.status).toBe(200);
			const shellText = await shell.text();
			expect(shellText).toContain(SHELL_MARKER);
			expect(shellText).toContain(`window.__BOBBIT_BASE_PATH__ = ${JSON.stringify(MOUNT)}`);
			expect(shellText).toContain(`src="${MOUNT}/assets/smoke.js"`);

			const asset = await fetch(`${persistedUrl}/assets/smoke.js`, { signal: AbortSignal.timeout(5_000) });
			expect(asset.status).toBe(200);
			expect(await asset.text()).toBe(`${ASSET_MARKER}\n`);

			const shutdown = await fetch(`${persistedUrl}/api/shutdown`, {
				method: "POST",
				signal: AbortSignal.timeout(5_000),
			});
			expect(shutdown.status).toBe(200);
			expect(await shutdown.json()).toEqual({ status: "shutting down" });
			expect(await waitForExit(child, 5_000)).toEqual({ code: 0, signal: null });
		} finally {
			await forceStop(child);
			const cleanup = await awaitableRm(root, { maxAttempts: 3, backoffMs: 50 });
			expect(cleanup.removed, `isolated CLI state cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
		}
	});

	it.skipIf(process.platform === "win32")("starts the built CLI through an npm-style POSIX bin symlink", async () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-cli-symlink-smoke-"));
		const projectRoot = join(root, "project");
		const headquartersDir = join(root, "headquarters");
		const binDir = join(root, "node_modules", ".bin");
		const cliLink = join(binDir, "bobbit");
		mkdirSync(projectRoot, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		expect(existsSync(BUILT_CLI_ENTRY), "built CLI is required for the packaged entrypoint smoke").toBe(true);
		symlinkSync(BUILT_CLI_ENTRY, cliLink, "file");

		const childEnv: NodeJS.ProcessEnv = {
			...process.env,
			BOBBIT_DIR: headquartersDir,
			BOBBIT_SECRETS_DIR: join(root, "secrets"),
			BOBBIT_AGENT_DIR: join(root, "agent"),
			BOBBIT_NO_OPEN: "1",
			BOBBIT_SKIP_AIGW_DISCOVERY: "1",
			BOBBIT_SKIP_MCP: "1",
			BOBBIT_SKIP_TITLE_GEN: "1",
			BOBBIT_SKIP_WORKTREE_POOL: "1",
			BOBBIT_TEST_NO_EXTERNAL: "1",
			BOBBIT_TEST_NO_REMOTE: "1",
			NODE_ENV: "test",
		};
		delete childEnv.BOBBIT_BASE_PATH;

		const child = spawn(cliLink, [
			"--cwd", projectRoot,
			"--host", "127.0.0.1",
			"--port", "0",
			"--no-tls",
			"--no-ui",
		], {
			cwd: REPO_ROOT,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

		try {
			const gatewayUrlPath = join(headquartersDir, "state", "gateway-url");
			const persistedUrl = await pollUntil(() => {
				if (child.exitCode !== null || child.signalCode !== null) {
					throw new Error(`symlinked CLI exited before publishing its gateway URL (${child.exitCode ?? child.signalCode})\n${output}`);
				}
				if (!existsSync(gatewayUrlPath)) return "";
				const value = readFileSync(gatewayUrlPath, "utf8").trim();
				const parsed = new URL(value);
				return parsed.port && parsed.port !== "0" ? value : "";
			}, { timeoutMs: 15_000, intervalMs: 50, label: "symlinked built CLI persisted root URL" });

			const parsed = new URL(persistedUrl);
			expect(parsed.protocol).toBe("http:");
			expect(parsed.hostname).toBe("127.0.0.1");
			expect(parsed.port).toMatch(/^\d+$/);
			expect(parsed.port).not.toBe("0");
			expect(parsed.pathname).toBe("/");
			expect(readFileSync(gatewayUrlPath, "utf8")).toBe(persistedUrl);

			const health = await fetch(`${persistedUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
			expect(health.status).toBe(200);
			expect(await health.json()).toMatchObject({ status: "ok", localhost: true });

			const shutdown = await fetch(`${persistedUrl}/api/shutdown`, {
				method: "POST",
				signal: AbortSignal.timeout(5_000),
			});
			expect(shutdown.status).toBe(200);
			expect(await shutdown.json()).toEqual({ status: "shutting down" });
			expect(await waitForExit(child, 5_000)).toEqual({ code: 0, signal: null });
			expect(output).toMatch(new RegExp(`Listening:\\s+${escapeRegExp(persistedUrl)}`));
		} finally {
			await forceStop(child);
			const cleanup = await awaitableRm(root, { maxAttempts: 3, backoffMs: 50 });
			expect(cleanup.removed, `isolated symlinked CLI cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
		}
	});
});
