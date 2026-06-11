/**
 * Detached Node bg-runner helper — the persistent host mechanism used on a
 * Windows host WITHOUT Git Bash (where the POSIX shell wrapper cannot run).
 * See `docs/design/persistent-bg-processes.md` §4.1.1.
 *
 * It provides full persistence parity with the POSIX wrapper:
 *   - runs the user command via the resolved shell,
 *   - owns each spool with a bounded ring (in-place truncate, restart-independent),
 *   - writes `processPid` (its own pid, which roots the child tree) + the
 *     per-spawn nonce to the pidfile,
 *   - writes the REAL child exit code to the status file on the child's `exit`.
 *
 * The gateway spawns this script detached (`process.execPath` + this file,
 * `detached:true` + `unref()`) so it survives a gateway restart; the gateway
 * re-attaches by tailing the spool + reading the status exactly as for the
 * shell wrapper — this path is indistinguishable downstream.
 *
 * Logic lives in the exported {@link runBgRunner} so unit tests can drive it
 * with a fake child (no real OS process).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface BgRunnerOptions {
	shell: string;
	shellArgs: string[];
	command: string;
	outSpool: string;
	errSpool: string;
	statusFile: string;
	pidFile: string;
	nonce: string;
	/** combined per-process byte cap; each spool is trimmed to this many bytes */
	maxBytes: number;
}

/** Append a chunk to a spool, then trim in place (same inode) to the last `keep` bytes. */
function appendBounded(spool: string, chunk: Buffer, keep: number): void {
	try {
		fs.appendFileSync(spool, chunk);
		const size = fs.statSync(spool).size;
		if (size > keep) {
			// Read the retained tail and rewrite in place (O_TRUNC, same inode).
			const fd = fs.openSync(spool, "r");
			try {
				const buf = Buffer.alloc(keep);
				const read = fs.readSync(fd, buf, 0, keep, size - keep);
				fs.writeFileSync(spool, buf.subarray(0, read));
			} finally {
				fs.closeSync(fd);
			}
		}
	} catch {
		// Best-effort — spool is an explicitly lossy last-N ring.
	}
}

/** Synchronously trim a spool in place (same inode) to the last `keep` bytes. */
function trimToCap(spool: string, keep: number): void {
	try {
		const size = fs.statSync(spool).size;
		if (size > keep) {
			const fd = fs.openSync(spool, "r");
			try {
				const buf = Buffer.alloc(keep);
				const read = fs.readSync(fd, buf, 0, keep, size - keep);
				fs.writeFileSync(spool, buf.subarray(0, read));
			} finally {
				fs.closeSync(fd);
			}
		}
	} catch {
		// Best-effort — spool is an explicitly lossy last-N ring.
	}
}

/**
 * Run the user command, spooling output and capturing the real exit code.
 * @param spawnImpl injectable spawn (tests pass a fake EventEmitter-backed child).
 * @returns the spawned child (so tests can drive its events).
 */
export function runBgRunner(
	opts: BgRunnerOptions,
	spawnImpl: (shell: string, args: string[]) => ChildProcess = (shell, args) =>
		nodeSpawn(shell, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env }),
): ChildProcess {
	const keep = opts.maxBytes;
	try { fs.mkdirSync(path.dirname(opts.outSpool), { recursive: true }); } catch { /* ignore */ }

	const child = spawnImpl(opts.shell, [...opts.shellArgs, opts.command]);

	// processPid = this helper's pid (roots the child tree → taskkill /T works).
	try { fs.writeFileSync(opts.pidFile, `${process.pid}\n${opts.nonce}\n`); } catch { /* ignore */ }

	child.stdout?.on("data", (c: Buffer) => appendBounded(opts.outSpool, Buffer.from(c), keep));
	child.stderr?.on("data", (c: Buffer) => appendBounded(opts.errSpool, Buffer.from(c), keep));

	const writeStatus = (code: number) => {
		try { fs.writeFileSync(opts.statusFile, `${code}\n`); } catch { /* ignore */ }
	};
	child.on("exit", (code, signal) => {
		// Final SYNCHRONOUS trim (Fix 1) before the status write: a fast chatty
		// burst can exit before any append-time trim leaves the spool bounded, so
		// guarantee ≤maxBytes on disk the instant the command finishes.
		trimToCap(opts.outSpool, keep);
		trimToCap(opts.errSpool, keep);
		// Real exit code; if killed by signal, encode as 128+signo (POSIX convention).
		const n = typeof code === "number" ? code : (signal ? 128 : 1);
		writeStatus(n);
	});
	child.on("error", () => writeStatus(127));

	return child;
}

function parseArgv(argv: string[]): BgRunnerOptions {
	// argv: --shell <s> --shell-args <json> --command <c> --out <p> --err <p>
	//       --status <p> --pid <p> --nonce <n> --max-bytes <n>
	const m = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) m.set(argv[i], argv[i + 1]);
	return {
		shell: m.get("--shell") ?? "/bin/sh",
		shellArgs: JSON.parse(m.get("--shell-args") ?? '["-c"]'),
		command: m.get("--command") ?? "",
		outSpool: m.get("--out") ?? "",
		errSpool: m.get("--err") ?? "",
		statusFile: m.get("--status") ?? "",
		pidFile: m.get("--pid") ?? "",
		nonce: m.get("--nonce") ?? "",
		maxBytes: parseInt(m.get("--max-bytes") ?? "524288", 10),
	};
}

// CLI entrypoint — only when invoked directly as a script.
const isMain = (() => {
	try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
	catch { return false; }
})();
if (isMain) {
	const opts = parseArgv(process.argv.slice(2));
	runBgRunner(opts);
}

/** Resolve the compiled helper script path, relative to this module. */
export function bgRunnerHelperPath(): string {
	return fileURLToPath(new URL("./bg-runner.js", import.meta.url));
}
