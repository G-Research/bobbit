/**
 * Unit tests for the DECLARED-PERMISSION worker capability model
 * (src/server/extension-host/permission-grants.ts + module-host-worker.ts +
 * module-host-bootstrap.ts + the dispatcher threading), design
 * docs/design/extension-host-phase2.md §9.
 *
 * A pack manifest may OPT IN to `permissions: ["git", "fs", "net"]`; the grant is
 * server-resolved from the winning contribution (never caller-supplied) and
 * threaded into the confined worker. Default (no grant) is DENY-ALL — exactly the
 * pre-existing confinement (pinned by extension-host-module-isolation.test.ts).
 *
 * Pinned invariants:
 *   - `git` grant un-denies `child_process` so the pack can spawn the git binary;
 *     a pack declaring NOTHING cannot import child_process (denied).
 *   - The `git` grant is a CONSTRAINED, async-only git RUNNER, not general command
 *     execution: an async spawn of the `git` binary works with a bare-relative cwd
 *     resolving to the session workingDir; `spawnSync`/`execSync` are DENIED; and
 *     spawning a non-git command is rejected.
 *   - `fs` grant un-denies `node:fs` + a BARE RELATIVE fs path resolves under the
 *     session workingDir; without the grant the import is denied.
 *   - `net` grant restores `fetch`; without it `fetch` is stripped.
 *   - The granted worker's env carries ONLY PATH — no gateway token / secret.
 *   - Pack-root import containment is STILL enforced under a grant (a `../` walk
 *     out of the pack is rejected even with `fs`/`git` granted).
 *   - terminate-on-timeout KILLS a child spawned by a `git`-granted handler (a
 *     runaway git cannot outlive the wall-time cap).
 *   - A server module's `ctx.host.session` is READ-ONLY (no `postMessage`).
 *   - The grant is threaded end-to-end through ActionDispatcher from the resolved
 *     contribution.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ModuleHost, DENIED_BUILTINS, type InvokeRequest } from "../src/server/extension-host/module-host-worker.ts";
import { ActionError, ActionDispatcher, type ActionHandlerCtx, type ActionToolLocationResolver } from "../src/server/extension-host/action-dispatcher.ts";
import { deniedForGrants, normalizeGrants, keepNetworkGlobals, needsRealProcess } from "../src/server/extension-host/permission-grants.ts";
import { parsePermissions } from "../src/server/agent/tool-contributions.ts";

let tmp: string;
let seq = 0;

function writeModule(body: string): string {
	const file = path.join(tmp, `permmod-${seq++}.mjs`);
	fs.writeFileSync(file, body);
	return pathToFileURL(file).href;
}

const bareCtx = (): ActionHandlerCtx => ({
	host: {} as ActionHandlerCtx["host"],
	sessionId: "sess-1",
	toolUseId: "tu-1",
	tool: "demo_tool",
});

function req(
	url: string,
	member: string,
	ctx: ActionHandlerCtx,
	arg: unknown = {},
	opts: { packRoot?: string; permissions?: string[]; workingDir?: string } = {},
): InvokeRequest {
	return {
		url,
		packRoot: opts.packRoot ?? tmp,
		epoch: 0,
		exportKind: "actions",
		member,
		ctx,
		arg,
		permissions: opts.permissions,
		workingDir: opts.workingDir,
	};
}

/** A live process pid is alive iff `kill(pid, 0)` does not throw ESRCH. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-host-perm-"));
});
after(() => {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("permission-grants — pure grant logic", () => {
	it("normalizeGrants keeps only the recognized subset (lowercased, deduped)", () => {
		assert.deepEqual(normalizeGrants(["git", "GIT", "fs", "bogus", 7, "net"]), ["git", "fs", "net"]);
		assert.deepEqual(normalizeGrants(undefined), []);
		assert.deepEqual(normalizeGrants("git"), []);
	});

	it("deniedForGrants is the full deny-list when nothing is granted (deny-all default)", () => {
		assert.deepEqual(deniedForGrants(DENIED_BUILTINS, []), [...DENIED_BUILTINS]);
		assert.deepEqual(deniedForGrants(DENIED_BUILTINS, undefined), [...DENIED_BUILTINS]);
	});

	it("git un-denies child_process only; fs un-denies fs; net un-denies the network built-ins", () => {
		assert.ok(!deniedForGrants(DENIED_BUILTINS, ["git"]).includes("child_process"));
		assert.ok(deniedForGrants(DENIED_BUILTINS, ["git"]).includes("fs"), "git must NOT un-deny fs");
		assert.ok(!deniedForGrants(DENIED_BUILTINS, ["fs"]).includes("fs"));
		assert.ok(deniedForGrants(DENIED_BUILTINS, ["fs"]).includes("child_process"), "fs must NOT un-deny child_process");
		const net = deniedForGrants(DENIED_BUILTINS, ["net"]);
		for (const seg of ["net", "http", "https"]) assert.ok(!net.includes(seg), `net must un-deny ${seg}`);
		assert.ok(net.includes("child_process") && net.includes("fs"), "net must NOT un-deny fs/child_process");
	});

	it("keepNetworkGlobals / needsRealProcess reflect the grant set", () => {
		assert.equal(keepNetworkGlobals(["net"]), true);
		assert.equal(keepNetworkGlobals(["git"]), false);
		assert.equal(needsRealProcess(["git"]), true);
		assert.equal(needsRealProcess(["fs"]), true);
		assert.equal(needsRealProcess(["net"]), false);
		assert.equal(needsRealProcess([]), false);
	});

	it("parsePermissions parses the manifest key tolerantly", () => {
		assert.deepEqual(parsePermissions(["git", "fs", "net"], "t.yaml"), ["git", "fs", "net"]);
		assert.deepEqual(parsePermissions(["GIT", "exec", "fs"], "t.yaml"), ["git", "fs"]);
		assert.deepEqual(parsePermissions("git", "t.yaml"), []);
		assert.deepEqual(parsePermissions(undefined, "t.yaml"), []);
	});
});

describe("permission grant — default deny-all is UNCHANGED", () => {
	it("with NO grant: fetch is stripped, and child_process/fs imports are denied", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const probe = writeModule(`export const actions = { f: async () => typeof fetch };`);
			assert.equal(await mh.invoke(req(probe, "f", bareCtx())), "undefined");

			for (const builtin of ["node:child_process", "node:fs"]) {
				const url = writeModule(`export const actions = { evil: async () => { await import(${JSON.stringify(builtin)}); return "leaked"; } };`);
				await assert.rejects(
					() => mh.invoke(req(url, "evil", bareCtx())),
					(e) => e instanceof ActionError && /denied|confinement/i.test(e.message),
				);
			}
		} finally {
			mh.dispose();
		}
	});
});

describe("permission grant — git", () => {
	it("a pack declaring `git` can spawn the git binary", async () => {
		const mh = new ModuleHost({ timeoutMs: 15_000 });
		try {
			const url = writeModule(
				`import { spawn } from "node:child_process";\n` +
				`export const actions = { gitver: async () => new Promise((resolve, reject) => {\n` +
				`  const c = spawn("git", ["--version"]);\n` +
				`  let out = "";\n` +
				`  c.stdout.on("data", (d) => { out += d; });\n` +
				`  c.on("error", reject);\n` +
				`  c.on("close", (code) => resolve({ code, out: out.trim() }));\n` +
				`}) };`,
			);
			const r = (await mh.invoke(req(url, "gitver", bareCtx(), {}, { permissions: ["git"], workingDir: tmp }))) as { code: number; out: string };
			assert.equal(r.code, 0, "git --version should exit 0");
			assert.match(r.out, /git version/i, "git --version output should be captured");
		} finally {
			mh.dispose();
		}
	});

	it("a pack declaring NOTHING cannot import child_process (cannot spawn git)", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(`export const actions = { evil: async () => { await import("node:child_process"); return "leaked"; } };`);
			await assert.rejects(
				() => mh.invoke(req(url, "evil", bareCtx())), // no permissions
				(e) => e instanceof ActionError && /denied|confinement/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});

	it("an async git spawn with NO cwd defaults to the session workingDir (bare-relative resolution)", async () => {
		// `git hash-object <relative-file>` resolves the path against the process cwd
		// and works OUTSIDE a repo. The handler passes a BARE relative filename with
		// no `cwd` option → the runner must default cwd to `workingDir`, so git finds
		// the file written there (NOT in the worker's startup cwd).
		const dir = path.join(tmp, `git-cwd-${seq++}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "marker.txt"), "hello-relative\n");
		const mh = new ModuleHost({ timeoutMs: 15_000 });
		try {
			const url = writeModule(
				`import { spawn } from "node:child_process";\n` +
				`export const actions = { hash: async () => new Promise((resolve, reject) => {\n` +
				`  const c = spawn("git", ["hash-object", "marker.txt"]); /* no cwd → defaults to workingDir */\n` +
				`  let out = ""; c.stdout.on("data", (d) => { out += d; });\n` +
				`  c.on("error", reject);\n` +
				`  c.on("close", (code) => resolve({ code, out: out.trim() }));\n` +
				`}) };`,
			);
			const r = (await mh.invoke(req(url, "hash", bareCtx(), {}, { permissions: ["git"], workingDir: dir }))) as { code: number; out: string };
			assert.equal(r.code, 0, "git hash-object should resolve the bare-relative file under workingDir (exit 0)");
			assert.match(r.out, /^[0-9a-f]{40}$/, "git should print the blob SHA of the file under workingDir");
		} finally {
			mh.dispose();
		}
	});

	it("synchronous child-process APIs (spawnSync/execSync) are DENIED even with `git`", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			for (const api of ["spawnSync", "execSync"]) {
				const url = writeModule(
					`import * as cp from "node:child_process";\n` +
					`export const actions = { run: async () => cp.${api}("git", ["--version"]) };`,
				);
				await assert.rejects(
					() => mh.invoke(req(url, "run", bareCtx(), {}, { permissions: ["git"], workingDir: tmp })),
					(e) => e instanceof ActionError && /denied|confinement|synchronous/i.test(e.message),
					`${api} must be denied under the git grant`,
				);
			}
		} finally {
			mh.dispose();
		}
	});

	it("spawning a NON-git command is rejected (the git grant is not general exec)", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(
				`import { spawn } from "node:child_process";\n` +
				`export const actions = { evil: async () => spawn(${JSON.stringify(process.execPath)}, ["-e", "1"]) };`,
			);
			await assert.rejects(
				() => mh.invoke(req(url, "evil", bareCtx(), {}, { permissions: ["git"], workingDir: tmp })),
				(e) => e instanceof ActionError && /git binary|confinement/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});
});

describe("permission grant — fs", () => {
	it("an `fs` grant allows reading a file relative to the session working dir", async () => {
		const dir = path.join(tmp, `fs-pack-${seq++}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "data.txt"), "hello-from-cwd");
		// The entry module must live INSIDE the pack root (containment is enforced).
		// The grant points the process SHIM's cwd() at the session working dir; the
		// pack reads a file UNDER that cwd (node:path is not denied) — proving the
		// fs grant + the real cwd() work together.
		fs.writeFileSync(
			path.join(dir, "entry.mjs"),
			`import { readFileSync } from "node:fs";\n` +
			`import { join } from "node:path";\n` +
			`export const actions = { readit: async () => readFileSync(join(process.cwd(), "data.txt"), "utf8") };`,
		);
		const url = pathToFileURL(path.join(dir, "entry.mjs")).href;
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const r = await mh.invoke(req(url, "readit", bareCtx(), {}, { packRoot: dir, permissions: ["fs"], workingDir: dir }));
			assert.equal(r, "hello-from-cwd");
		} finally {
			mh.dispose();
		}
	});

	it("a BARE relative `fs.readFileSync(\"data.txt\")` reads from the session workingDir (not the startup cwd)", async () => {
		const dir = path.join(tmp, `fs-bare-${seq++}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "data.txt"), "bare-relative-from-workingdir");
		// The handler passes a BARE relative path (no process.cwd() join). Worker
		// threads cannot chdir(), so without the fs-rebase wrap this would resolve
		// against the worker's STARTUP cwd and fail; the grant rebases it onto
		// workingDir. Default-import form so the wrap reflects across module facades.
		fs.writeFileSync(
			path.join(dir, "entry.mjs"),
			`import fs from "node:fs";\n` +
			`export const actions = { readit: async () => fs.readFileSync("data.txt", "utf8") };`,
		);
		const url = pathToFileURL(path.join(dir, "entry.mjs")).href;
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const r = await mh.invoke(req(url, "readit", bareCtx(), {}, { packRoot: dir, permissions: ["fs"], workingDir: dir }));
			assert.equal(r, "bare-relative-from-workingdir");
		} finally {
			mh.dispose();
		}
	});

	it("without the `fs` grant the node:fs import is denied", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(`import { readFileSync } from "node:fs";\nexport const actions = { readit: async () => readFileSync("x", "utf8") };`);
			await assert.rejects(
				() => mh.invoke(req(url, "readit", bareCtx())),
				(e) => e instanceof ActionError && /denied|confinement/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});
});

describe("permission grant — net", () => {
	it("a `net` grant restores the `fetch` global (stripped by default)", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(`export const actions = { probe: async () => ({ fetch: typeof fetch, ws: typeof WebSocket }) };`);
			const granted = (await mh.invoke(req(url, "probe", bareCtx(), {}, { permissions: ["net"] }))) as Record<string, string>;
			assert.equal(granted.fetch, "function", "net grant restores fetch");
			assert.equal(granted.ws, "function", "net grant restores WebSocket");
			const denied = (await mh.invoke(req(url, "probe", bareCtx()))) as Record<string, string>;
			assert.equal(denied.fetch, "undefined", "default strips fetch");
		} finally {
			mh.dispose();
		}
	});
});

describe("permission grant — no secret leak", () => {
	it("a `git`-granted worker's env contains ONLY PATH — no gateway token / secret", async () => {
		const SECRET = "gw-token-" + Math.random().toString(36).slice(2);
		process.env.BOBBIT_TEST_GATEWAY_SECRET = SECRET;
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(
				`export const actions = { peek: async () => ({` +
				` secret: process.env.BOBBIT_TEST_GATEWAY_SECRET ?? null,` +
				` keys: Object.keys(process.env),` +
				` hasPath: typeof process.env.PATH === "string" }) };`,
			);
			const r = (await mh.invoke(req(url, "peek", bareCtx(), {}, { permissions: ["git"], workingDir: tmp }))) as { secret: string | null; keys: string[]; hasPath: boolean };
			assert.equal(r.secret, null, "the gateway secret must NOT be readable");
			assert.deepEqual(r.keys, ["PATH"], "the granted worker env exposes ONLY PATH");
			assert.equal(r.hasPath, true, "PATH is present so the git binary resolves");
		} finally {
			mh.dispose();
			delete process.env.BOBBIT_TEST_GATEWAY_SECRET;
		}
	});
});

describe("permission grant — pack-root containment STILL enforced under a grant", () => {
	it("a `../` import walk out of the pack root is rejected even with fs+git granted", async () => {
		const dir = path.join(tmp, `contain-pack-${seq++}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(tmp, `contain-outside-${seq}.mjs`), `export const x = "stolen";`);
		const url = pathToFileURL(path.join(dir, "entry.mjs")).href;
		fs.writeFileSync(path.join(dir, "entry.mjs"), `import { x } from "../contain-outside-${seq}.mjs";\nexport const actions = { run: async () => x };`);
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			await assert.rejects(
				() => mh.invoke(req(url, "run", bareCtx(), {}, { packRoot: dir, permissions: ["fs", "git"], workingDir: dir })),
				(e) => e instanceof ActionError && /escape|confinement/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});
});

describe("permission grant — terminate-on-timeout kills a spawned child (blast-radius)", () => {
	it("a child spawned by a `git`-granted handler is KILLED when the worker times out", async () => {
		// The handler spawns a long-lived GIT child (`git hash-object --stdin` blocks
		// reading stdin forever), reports its pid to the parent via the host store,
		// then hangs → the wall-time cap fires, the worker is terminated, and the
		// parent must KILL the still-running tracked child (it is a child of the MAIN
		// process, which worker.terminate() does NOT reap).
		let recordedPid: number | undefined;
		const host = {
			version: 1,
			contractVersion: 1,
			capabilities: { callRoute: false, session: false, store: true, has: (n: string) => n === "store" },
			store: {
				put: async (k: string, v: unknown) => { if (k === "pid") recordedPid = v as number; },
				get: async () => null,
				list: async () => [],
			},
			session: { readTranscript: async () => ({}), readToolCall: async () => null },
		} as unknown as ActionHandlerCtx["host"];
		const ctx: ActionHandlerCtx = { host, sessionId: "s", toolUseId: "t", tool: "demo_tool" };

		// Generous wall-cap (the handler hangs forever, so the 504 still fires exactly
		// at the cap): worker startup + git spawn + the `store.put("pid")` MessagePort
		// round-trip must reliably complete BEFORE the cap even under a loaded full-suite
		// run. 800ms raced on CI; 3s is a ~10x margin over the normal <300ms path.
		const mh = new ModuleHost({ timeoutMs: 3000 });
		try {
			const url = writeModule(
				`import { spawn } from "node:child_process";\n` +
				`export const actions = { spawnHang: async (ctx) => {\n` +
				`  const c = spawn("git", ["hash-object", "--stdin"]); /* blocks reading stdin */\n` +
				`  await ctx.host.store.put("pid", c.pid);\n` +
				`  await new Promise(() => {}); /* hang → timeout */\n` +
				`} };`,
			);
			await assert.rejects(
				() => mh.invoke(req(url, "spawnHang", ctx, {}, { permissions: ["git"], workingDir: tmp })),
				(e) => e instanceof ActionError && e.status === 504,
			);
			assert.equal(typeof recordedPid, "number", "the handler reported the spawned child's pid before hanging");
			// Poll for the kill to take effect (terminate + kill are fire-and-forget).
			const pid = recordedPid as number;
			let alive = true;
			for (let i = 0; i < 60 && alive; i++) {
				alive = isAlive(pid);
				if (alive) await new Promise((r) => setTimeout(r, 50));
			}
			assert.equal(alive, false, `the spawned child (pid ${pid}) must be killed when the worker is terminated`);
		} finally {
			mh.dispose();
		}
	});
});

describe("server-module host surface — session is READ-ONLY (no postMessage)", () => {
	it("ctx.host.session exposes readTranscript/readToolCall but NOT postMessage", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(
				`export const actions = { probe: async (ctx) => ({\n` +
				`  readTranscript: typeof ctx.host.session.readTranscript,\n` +
				`  readToolCall: typeof ctx.host.session.readToolCall,\n` +
				`  postMessage: typeof ctx.host.session.postMessage,\n` +
				`}) };`,
			);
			const r = (await mh.invoke(req(url, "probe", bareCtx()))) as Record<string, string>;
			assert.equal(r.readTranscript, "function", "reads stay available");
			assert.equal(r.readToolCall, "function", "reads stay available");
			assert.equal(r.postMessage, "undefined", "postMessage must be ABSENT from a server module's session surface");
		} finally {
			mh.dispose();
		}
	});
});

describe("permission grant — threaded end-to-end through ActionDispatcher", () => {
	function writeTool(baseDir: string, groupDir: string, actionsJs: string): void {
		const dir = path.join(baseDir, groupDir);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "actions.mjs"), actionsJs);
	}
	function resolver(baseDir: string, groupDir: string, permissions?: string[]): ActionToolLocationResolver {
		return {
			resolveToolLocation: (name) => (name === "perm_tool" ? { baseDir, groupDir, actionsModule: "actions.mjs", permissions } : undefined),
		};
	}
	const ctx = (workingDir?: string): ActionHandlerCtx => ({ host: {} as ActionHandlerCtx["host"], sessionId: "s", toolUseId: "t", tool: "perm_tool", workingDir });

	it("a resolved `git` permission lets the dispatched handler import child_process", async () => {
		const base = path.join(tmp, `disp-git-${seq++}`);
		writeTool(base, "demo", `import { spawn } from "node:child_process";\nexport const actions = { ok: async () => typeof spawn };`);
		const d = new ActionDispatcher(resolver(base, "demo", ["git"]), { rate: null, timeoutMs: 15_000 });
		const r = await d.dispatch("perm_tool", "ok", ctx(tmp), {});
		assert.equal(r, "function", "the git grant threaded through the dispatcher un-denies child_process");
	});

	it("the SAME handler is denied child_process when the contribution declares no permission", async () => {
		const base = path.join(tmp, `disp-none-${seq++}`);
		writeTool(base, "demo", `import { spawn } from "node:child_process";\nexport const actions = { ok: async () => typeof spawn };`);
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null, timeoutMs: 10_000 });
		await assert.rejects(
			() => d.dispatch("perm_tool", "ok", ctx(tmp), {}),
			(e) => e instanceof ActionError && /denied|confinement/i.test(e.message),
		);
	});
});
