import childProcess from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const customPromisify = Symbol.for("nodejs.util.promisify.custom");

/** Preserve Node's exec/execFile success and rejected-error output contract. */
export function preserveExecCustomPromisifier(original, profiledAsync) {
	if (!original[customPromisify]) return;
	profiledAsync[customPromisify] = function (...args) {
		return new Promise((resolve, reject) => {
			profiledAsync.call(this, ...args, (error, stdout, stderr) => {
				if (error) {
					error.stdout = stdout;
					error.stderr = stderr;
					reject(error);
				} else {
					resolve({ stdout, stderr });
				}
			});
		});
	};
}

export function observeChildProfileLifecycle(child, finish, timeoutMs = 0) {
	let settled = false;
	const settle = (result) => { if (settled) return; settled = true; finish(result); };
	child?.once?.("error", (error) => settle({ outcome: "error", errorCode: error?.code ? String(error.code) : undefined }));
	// `exit` is the process-runtime boundary. Waiting for `close` can lose an
	// otherwise complete interval when a worker exits while inherited stdio
	// remains open; retain close only as the defensive fallback.
	const settleExit = (code, signal) => settle({
		outcome: signal && timeoutMs > 0 ? "timeout" : code === 0 ? "ok" : "failed",
		exitCode: code,
		signal: signal ?? undefined,
	});
	child?.once?.("exit", settleExit);
	child?.once?.("close", settleExit);
}

const outDir = process.env.BOBBIT_V2_CHILD_PROFILE_DIR;
const hookOutDir = process.env.BOBBIT_V2_HOOK_PROFILE_DIR;
const profileDepth = Math.max(0, Number(process.env.BOBBIT_V2_CHILD_PROFILE_DEPTH) || 0);
// The preload is installed on the lane runner, Playwright coordinator, and
// Playwright workers. Workers record their direct children; those children
// inherit depth=3 and deliberately do not patch themselves, avoiding recursive
// instrumentation of agent probes and command fixtures.
if ((outDir || hookOutDir) && profileDepth < 3) {
	process.env.BOBBIT_V2_CHILD_PROFILE_DEPTH = String(profileDepth + 1);
	// At depth 2 this process is the Playwright worker. Keep its wrappers active
	// but restore descendant inheritance to the unprofiled environment: direct
	// child duration is already observed here, and recursively preloading command
	// and agent fixtures materially changes their startup behavior on Windows.
	if (profileDepth === 2) {
		process.env.NODE_OPTIONS = String(process.env.NODE_OPTIONS || "")
			.split(/\s+/)
			.filter((token) => token && !token.includes("child-process-profile-preload.mjs"))
			.join(" ");
		delete process.env.BOBBIT_V2_CHILD_PROFILE_DIR;
		delete process.env.BOBBIT_V2_CHILD_PROFILE_DEPTH;
		delete process.env.BOBBIT_V2_HOOK_PROFILE_DIR;
	}

	const writers = [];
	const createWriter = (directory, filename) => {
		if (!directory) return null;
		mkdirSync(directory, { recursive: true });
		const outFile = join(directory, filename);
		let buffered = [];
		const flush = () => {
			if (!buffered.length) return;
			const batch = buffered;
			buffered = [];
			try { appendFileSync(outFile, `${batch.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"); } catch { /* profiling must never change test behavior */ }
		};
		const write = (record) => {
			buffered.push(record);
			if (buffered.length >= 200) flush();
		};
		const writer = { write, flush };
		writers.push(writer);
		return writer;
	};

	const processWriter = createWriter(outDir, `process-${process.pid}.jsonl`);
	const hookWriter = createWriter(hookOutDir, `gateway-api-${process.pid}.jsonl`);
	const activeChildren = new Map();
	const pidAlive = (pid) => {
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try { process.kill(pid, 0); return true; }
		catch (error) { return error?.code === "EPERM"; }
	};
	const flushAll = () => { for (const writer of writers) writer.flush(); };
	const flushTimer = setInterval(flushAll, 250);
	flushTimer.unref?.();
	process.once("beforeExit", flushAll);
	process.once("exit", () => {
		clearInterval(flushTimer);
		const endedAt = Date.now();
		// A forced Playwright worker exit can happen after an MCP transport has
		// closed but before Node delivers the ChildProcess `exit` event. Preserve
		// the exact still-unsettled child identity and its last owner-side liveness
		// observation. The post-phase reporter performs the final liveness check;
		// owner termination alone is never treated as child completion.
		for (const { base, child } of activeChildren.values()) {
			processWriter?.write({
				type: "owner_child_liveness",
				id: base.id,
				ownerPid: process.pid,
				childPid: base.childPid,
				creationIdentity: base.creationIdentity,
				checkedAt: endedAt,
				alive: pidAlive(base.childPid),
				exitCode: child?.exitCode ?? undefined,
				signal: child?.signalCode ?? undefined,
			});
		}
		processWriter?.write({ type: "owner_end", ownerPid: process.pid, endedAt });
		hookWriter?.write({ type: "owner_end", ownerPid: process.pid, endedAt });
		flushAll();
	});

	if (processWriter) {
		let sequence = 0;
		const childTerminalFile = join(outDir, `child-terminal-${process.pid}.jsonl`);
		const executableName = (command) => {
			const text = String(command ?? "<unknown>").replace(/^['"]|['"]$/g, "");
			return basename(text).toLowerCase() || "<unknown>";
		};
		const begin = (api, command) => {
			const id = `${process.pid}:${++sequence}`;
			const startedAt = Date.now();
			const startPerf = performance.now();
			const executable = api === "exec" || api === "execSync"
				? executableName(process.env.ComSpec || (process.platform === "win32" ? "cmd.exe" : "/bin/sh"))
				: executableName(command);
			const base = {
				id,
				api,
				executable,
				ownerPid: process.pid,
				parentPid: process.ppid,
				startedAt,
				creationIdentity: `${id}:${startedAt}`,
			};
			let settled = false;
			processWriter.write({ type: "start", ...base });
			return {
				base,
				track(child) {
					if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
					base.childPid = child.pid;
					// This token is created before spawn and bound to this exact
					// ChildProcess object. A cooperating fixture receives the same token,
					// so its terminal record cannot be joined to another start even if the
					// operating system later reuses the PID.
					activeChildren.set(id, { base, child });
					processWriter.write({
						type: "child_identity",
						id,
						ownerPid: process.pid,
						childPid: child.pid,
						creationIdentity: base.creationIdentity,
					});
				},
				finish(result = {}) {
					if (settled) return;
					settled = true;
					activeChildren.delete(id);
					processWriter.write({
						type: "end",
						...base,
						endedAt: Date.now(),
						durationMs: Math.max(0, performance.now() - startPerf),
						...result,
					});
				},
			};
		};

		const withMockMcpTerminalEvidence = (args, lifecycle) => {
			const commandText = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].map(String).join(" ");
			if (!/mock-mcp-server\.mjs(?:[\s"']|$)/i.test(commandText)) return args;
			const optionsIndex = Array.isArray(args[1]) ? 2 : 1;
			const options = args[optionsIndex] && typeof args[optionsIndex] === "object" ? args[optionsIndex] : {};
			const cloned = [...args];
			cloned[optionsIndex] = {
				...options,
				env: {
					...(options.env ?? process.env),
					BOBBIT_V2_CHILD_TERMINAL_FILE: childTerminalFile,
					BOBBIT_V2_CHILD_TERMINAL_ID: lifecycle.base.id,
					BOBBIT_V2_CHILD_CREATION_IDENTITY: lifecycle.base.creationIdentity,
				},
			};
			return cloned;
		};
		const configuredTimeout = (args) => {
			for (const value of args.slice(1)) {
				if (value && typeof value === "object" && !Array.isArray(value) && Number(value.timeout) > 0) return Number(value.timeout);
			}
			return 0;
		};
		const wrapAsync = (name, commandIndex = 0) => {
			const original = childProcess[name];
			if (typeof original !== "function") return;
			const profiledAsync = function (...args) {
				const lifecycle = begin(name, args[commandIndex]);
				const timeoutMs = configuredTimeout(args);
				let child;
				const spawnArgs = name === "spawn" ? withMockMcpTerminalEvidence(args, lifecycle) : args;
				try { child = original.apply(this, spawnArgs); }
				catch (error) { lifecycle.finish({ outcome: "throw", errorCode: error?.code ? String(error.code) : undefined }); throw error; }
				lifecycle.track(child);
				observeChildProfileLifecycle(child, lifecycle.finish, timeoutMs);
				return child;
			};
			// Profiling must preserve Node's success and rejected-error output shape.
			preserveExecCustomPromisifier(original, profiledAsync);
			childProcess[name] = profiledAsync;
		};
		const wrapSync = (name, commandIndex = 0) => {
			const original = childProcess[name];
			if (typeof original !== "function") return;
			childProcess[name] = function profiledSync(...args) {
				const lifecycle = begin(name, args[commandIndex]);
				try {
					const result = original.apply(this, args);
					const status = result && typeof result === "object" && "status" in result ? result.status : 0;
					const timedOut = result?.error?.code === "ETIMEDOUT";
					lifecycle.finish({ outcome: timedOut ? "timeout" : status === 0 || status == null ? "ok" : "failed", exitCode: status ?? undefined, signal: result?.signal ?? undefined });
					return result;
				} catch (error) {
					lifecycle.finish({ outcome: error?.code === "ETIMEDOUT" ? "timeout" : "throw", exitCode: error?.status, signal: error?.signal, errorCode: error?.code ? String(error.code) : undefined });
					throw error;
				}
			};
		};

		wrapAsync("spawn");
		wrapAsync("exec");
		wrapAsync("execFile");
		wrapAsync("fork");
		wrapSync("spawnSync");
		wrapSync("execSync");
		wrapSync("execFileSync");
		syncBuiltinESMExports();
	}

	if (hookWriter && typeof globalThis.fetch === "function") {
		let hookSequence = 0;
		const originalFetch = globalThis.fetch;
		const loopbackRequest = (input) => {
			try {
				const url = new URL(typeof input === "string" || input instanceof URL ? input : input?.url);
				if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) || !/^\/api(?:\/|$)/.test(url.pathname)) return null;
				const configuredPort = process.env.E2E_PORT || (() => {
					try { return new URL(process.env.BOBBIT_GATEWAY_URL).port; } catch { return ""; }
				})();
				return configuredPort && url.port !== configuredPort ? null : url;
			} catch { return null; }
		};
		globalThis.fetch = async function profiledFetch(input, init) {
			const url = loopbackRequest(input);
			if (!url) return originalFetch.apply(this, arguments);
			const startedAt = Date.now();
			const startPerf = performance.now();
			const method = String(init?.method || input?.method || "GET").toUpperCase();
			try {
				const response = await originalFetch.apply(this, arguments);
				hookWriter.write({
					type: "gateway_api",
					id: `${process.pid}:${++hookSequence}`,
					ownerPid: process.pid,
					method,
					path: url.pathname,
					status: Number(response.status) || 0,
					startedAt,
					endedAt: Date.now(),
					durationMs: Math.max(0, performance.now() - startPerf),
				});
				return response;
			} catch (error) {
				hookWriter.write({
					type: "gateway_api",
					id: `${process.pid}:${++hookSequence}`,
					ownerPid: process.pid,
					method,
					path: url.pathname,
					status: 0,
					startedAt,
					endedAt: Date.now(),
					durationMs: Math.max(0, performance.now() - startPerf),
					outcome: "error",
					errorCode: error?.code ? String(error.code) : undefined,
				});
				throw error;
			}
		};
	}
}
