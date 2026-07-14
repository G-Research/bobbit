import childProcess from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const outDir = process.env.BOBBIT_V2_CHILD_PROFILE_DIR;
const profileDepth = Math.max(0, Number(process.env.BOBBIT_V2_CHILD_PROFILE_DEPTH) || 0);
// The preload is installed on the lane runner, Vitest coordinator, and Vitest
// workers. Workers record their direct command/Git/Node children; those children
// inherit depth=3 and deliberately do not patch themselves, avoiding recursive
// instrumentation of agent probes and command fixtures.
process.env.BOBBIT_V2_CHILD_PROFILE_DEPTH = String(profileDepth + 1);
if (outDir && profileDepth < 3) {
	// At depth 2 this process is the Vitest worker. Keep its wrappers active but
	// restore descendant inheritance to the unprofiled environment: direct child
	// duration is already observed here, and recursively preloading command/agent
	// fixtures materially changes their startup behavior on Windows.
	if (profileDepth === 2) {
		process.env.NODE_OPTIONS = String(process.env.NODE_OPTIONS || "")
			.split(/\s+/)
			.filter((token) => token && !token.includes("child-process-profile-preload.mjs"))
			.join(" ");
		delete process.env.BOBBIT_V2_CHILD_PROFILE_DIR;
		delete process.env.BOBBIT_V2_CHILD_PROFILE_DEPTH;
	}
	mkdirSync(outDir, { recursive: true });
	const outFile = join(outDir, `process-${process.pid}.jsonl`);
	let sequence = 0;
	let buffered = [];
	let flushed = false;

	const executableName = (command) => {
		const text = String(command ?? "<unknown>").replace(/^['"]|['"]$/g, "");
		return basename(text).toLowerCase() || "<unknown>";
	};
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
	process.once("exit", () => {
		if (flushed) return;
		write({ type: "owner_end", ownerPid: process.pid, endedAt: Date.now() });
		flushed = true;
		flush();
	});
	const begin = (api, command) => {
		const id = `${process.pid}:${++sequence}`;
		const startedAt = Date.now();
		const startPerf = performance.now();
		const executable = api === "exec" || api === "execSync"
			? executableName(process.env.ComSpec || (process.platform === "win32" ? "cmd.exe" : "/bin/sh"))
			: executableName(command);
		const base = { id, api, executable, ownerPid: process.pid, parentPid: process.ppid, startedAt };
		write({ type: "start", ...base });
		return (result = {}) => write({ type: "end", ...base, endedAt: Date.now(), durationMs: Math.max(0, performance.now() - startPerf), ...result });
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
		childProcess[name] = function profiledAsync(...args) {
			const finish = begin(name, args[commandIndex]);
			const timeoutMs = configuredTimeout(args);
			let child;
			try { child = original.apply(this, args); }
			catch (error) { finish({ outcome: "throw", errorCode: error?.code ? String(error.code) : undefined }); throw error; }
			let settled = false;
			const settle = (result) => { if (settled) return; settled = true; finish(result); };
			child?.once?.("error", (error) => settle({ outcome: "error", errorCode: error?.code ? String(error.code) : undefined }));
			child?.once?.("close", (code, signal) => settle({ outcome: signal && timeoutMs > 0 ? "timeout" : code === 0 ? "ok" : "failed", exitCode: code, signal: signal ?? undefined }));
			return child;
		};
	};
	const wrapSync = (name, commandIndex = 0) => {
		const original = childProcess[name];
		if (typeof original !== "function") return;
		childProcess[name] = function profiledSync(...args) {
			const finish = begin(name, args[commandIndex]);
			try {
				const result = original.apply(this, args);
				const status = result && typeof result === "object" && "status" in result ? result.status : 0;
				const timedOut = result?.error?.code === "ETIMEDOUT";
				finish({ outcome: timedOut ? "timeout" : status === 0 || status == null ? "ok" : "failed", exitCode: status ?? undefined, signal: result?.signal ?? undefined });
				return result;
			} catch (error) {
				finish({ outcome: error?.code === "ETIMEDOUT" ? "timeout" : "throw", exitCode: error?.status, signal: error?.signal, errorCode: error?.code ? String(error.code) : undefined });
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
