/**
 * Pinned regression: child-process spawns use `process.execPath`
 * (absolute path to the running node binary) instead of bare `"node"`.
 *
 * Live test (PR #409): the user reported a flood of harness logs
 * after every dev-server restart:
 *   [session-manager] Failed to restore "Coder: Cosmo Kramer" ...
 *   Error: spawn node ENOENT
 *     errno: -2, code: 'ENOENT', syscall: 'spawn node', path: 'node'
 * UI symptom: rows like "Coder: Cosmo Kramer", "Coder: Pretzel" sat
 * with status=terminated and the "Restart Agent" button kept failing
 * with the same ENOENT.
 *
 * Root cause: `_spawnProcess` in rpc-bridge.ts called
 * `spawn("node", [cliPath, ...args])`. `spawn` resolves a bare
 * command via the parent process's PATH. The harness-launched
 * gateway often has a sanitised PATH (npm scripts, nvm shims, brew
 * launcher) that doesn't include the directory containing node, so
 * the call fails with ENOENT.
 *
 * Fix: use `process.execPath` — the absolute path to the very node
 * binary executing the gateway. It's always resolvable, never
 * sanitised, and guaranteed to be a compatible node version.
 *
 * Same fix applied to two pre-gateway sites for consistency:
 *   - src/server/watchdog.ts (spawns the harness)
 *   - src/server/harness.ts  (spawns the gateway)
 *   - src/server/agent/rpc-bridge.ts (spawns the agent CLI) — THE bug
 *
 * The unit test is a source-grep guard: any new `spawn("node", …)`
 * call in src/server/ would fail the assertion. We make a narrow
 * exception for `tests/` since test harnesses run with proper PATH.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

describe("spawn() in src/server/ uses process.execPath, not bare 'node'", () => {
	it("THE bug regression: no `spawn(\"node\", ...)` calls in src/server/", () => {
		// rg: regex match on bare "node" string in spawn(). We allow
		// process.execPath (absolute path lookup) but reject "node".
		// Two patterns to catch: spawn("node", ...) and spawn('node', ...)
		let hits: string;
		try {
			hits = execSync(
				`rg -n --no-heading --color never 'spawn\\(["\\\']node["\\\'][, )]' src/server/ || true`,
				{ cwd: REPO, encoding: "utf8" },
			);
		} catch (err: any) {
			// rg exits 1 when no match — that's success here
			hits = "";
		}
		const lines = hits.split("\n").filter(l => l.trim().length > 0);
		assert.equal(lines.length, 0,
			`Found ${lines.length} bare-"node" spawn(s) in src/server/ — use process.execPath instead.\n${lines.join("\n")}`);
	});

	it("rpc-bridge.ts uses process.execPath for agent CLI spawn", () => {
		const out = execSync(
			`rg -n --no-heading --color never 'spawn\\(process\\.execPath' src/server/agent/rpc-bridge.ts || true`,
			{ cwd: REPO, encoding: "utf8" },
		);
		assert.ok(out.includes("spawn(process.execPath"),
			"rpc-bridge.ts must spawn the agent CLI via process.execPath");
	});

	it("harness.ts uses process.execPath for gateway spawn", () => {
		const out = execSync(
			`rg -n --no-heading --color never 'spawn\\(process\\.execPath' src/server/harness.ts || true`,
			{ cwd: REPO, encoding: "utf8" },
		);
		assert.ok(out.includes("spawn(process.execPath"),
			"harness.ts must spawn the gateway via process.execPath");
	});

	it("watchdog.ts uses process.execPath for harness spawn", () => {
		const out = execSync(
			`rg -n --no-heading --color never 'spawn\\(process\\.execPath' src/server/watchdog.ts || true`,
			{ cwd: REPO, encoding: "utf8" },
		);
		assert.ok(out.includes("spawn(process.execPath"),
			"watchdog.ts must spawn the harness via process.execPath");
	});
});
