/**
 * Spawn an LSP child + wire JSON-RPC. Sandbox-aware via SandboxLspBridge.
 *
 * Used by language adapters under `clients/`. Adapters call `start()` to
 * launch + initialize, then drive the returned `connection` directly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from "vscode-jsonrpc/lib/node/main.js";

import type { SandboxLspBridge } from "./client.js";

const STDERR_RING_BYTES = 64 * 1024;

export interface LspProcessOpts {
	worktreePath: string;
	command: string;       // resolved absolute binary or node script
	args: string[];
	sandbox?: SandboxLspBridge;
}

export interface LspProcess {
	connection: MessageConnection;
	child: ChildProcess;
	stderrTail(): string;
	stop(graceful: boolean): Promise<void>;
}

const localRequire = createRequire(import.meta.url);

/**
 * Resolve typescript-language-server CLI script (.mjs) from the gateway
 * `node_modules`. Falls back to the bin script.
 */
export function resolveTypescriptLanguageServer(): { node: string; cliMjs: string } | null {
	try {
		const cliMjs = localRequire.resolve("typescript-language-server/lib/cli.mjs");
		return { node: process.execPath, cliMjs };
	} catch { /* fall through */ }
	return null;
}

export function resolvePyrightLangserver(): { node: string; cliMjs: string } | null {
	try {
		// pyright ships `langserver.index.js` / `pyright-langserver.js`. Best-effort.
		const cliMjs = localRequire.resolve("pyright/langserver.index.js");
		return { node: process.execPath, cliMjs };
	} catch {
		try {
			const cliMjs = localRequire.resolve("pyright/dist/pyright-langserver.js");
			return { node: process.execPath, cliMjs };
		} catch { return null; }
	}
}

export async function spawnLspChild(opts: LspProcessOpts): Promise<LspProcess> {
	let child: ChildProcess;
	// Sandbox bridge is best-effort: when no container exists for this
	// worktree (host-only sessions, fixture tests, sandbox not yet started),
	// fall back to a host-side spawn rather than throwing. This keeps the
	// supervisor working uniformly across sandboxed and non-sandboxed
	// worktrees within the same gateway.
	const cid = opts.sandbox?.containerIdForWorktree(opts.worktreePath) ?? null;
	if (opts.sandbox && cid) {
		const containerCwd = opts.sandbox.toContainerPath(opts.worktreePath);
		child = opts.sandbox.spawn({
			containerId: cid,
			cmd: [opts.command, ...opts.args],
			cwd: containerCwd,
		});
	} else {
		child = spawn(opts.command, opts.args, {
			cwd: opts.worktreePath,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
	}

	if (!child.stdout || !child.stdin) throw new Error("LSP child has no stdio");

	// Ring-buffer stderr for crash diagnostics
	const tail: Buffer[] = [];
	let tailBytes = 0;
	child.stderr?.on("data", (b: Buffer) => {
		tail.push(b);
		tailBytes += b.length;
		while (tailBytes > STDERR_RING_BYTES && tail.length > 1) {
			const head = tail.shift()!;
			tailBytes -= head.length;
		}
	});

	const connection = createMessageConnection(
		new StreamMessageReader(child.stdout),
		new StreamMessageWriter(child.stdin),
	);
	connection.listen();

	const stderrTail = () => Buffer.concat(tail).toString("utf-8");

	const stop = async (graceful: boolean) => {
		if (graceful) {
			try {
				await Promise.race([
					connection.sendRequest("shutdown"),
					new Promise(r => setTimeout(r, 1500)),
				]);
				try { connection.sendNotification("exit"); } catch { /* ignore */ }
			} catch { /* ignore */ }
		}
		try { connection.dispose(); } catch { /* ignore */ }
		try { child.kill("SIGTERM"); } catch { /* ignore */ }
		await new Promise(r => setTimeout(r, 50));
		if (!child.killed) {
			try { child.kill("SIGKILL"); } catch { /* ignore */ }
		}
	};

	return { connection, child, stderrTail, stop };
}
