/*
 * Fixed, shell-free POSIX supervisor for spawnTracked.
 *
 * This program is launched only by spawn-tree.ts. Configured command bytes
 * arrive as JSON in a private environment envelope and are used solely as
 * argv by child_process.spawn; they are never parsed by a shell.
 */

import { execFileSync, spawn } from "node:child_process";
import { closeSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";

const PAYLOAD_ENV = "BOBBIT_POSIX_TREE_PAYLOAD";
const IDENTITY_FILE_ENV = "BOBBIT_POSIX_SENTINEL_IDENTITY_FILE";
const IDENTITY_NONCE_ENV = "BOBBIT_POSIX_SENTINEL_IDENTITY_NONCE";
const SIGNAL_WITNESS_ENV = "BOBBIT_POSIX_SENTINEL_TEST_SIGNAL_WITNESS_FD";
const SENTINEL_FLAG = "--bobbit-posix-tree-sentinel";
const SENTINEL_ARGUMENT_PREFIX = "bobbit-posix-sentinel:";
const INTERNAL_ENVIRONMENT = [PAYLOAD_ENV, IDENTITY_FILE_ENV, IDENTITY_NONCE_ENV, SIGNAL_WITNESS_ENV] as const;

type Payload = { file: string; args: string[]; stdioCount: number };
type SentinelIdentity = { pgid: number; startTokenKind: string; startToken: string };

function die(): never {
	process.exit(125);
}

function parsePayload(): Payload {
	try {
		const payload: unknown = JSON.parse(process.env[PAYLOAD_ENV] ?? "");
		if (!payload || typeof payload !== "object") return die();
		const { file, args, stdioCount } = payload as Partial<Payload>;
		if (typeof file !== "string" || !Array.isArray(args) || args.some(arg => typeof arg !== "string") || typeof stdioCount !== "number" || !Number.isSafeInteger(stdioCount) || stdioCount < 4) return die();
		return { file, args, stdioCount };
	} catch {
		return die();
	}
}

function inspectSelf(): SentinelIdentity | undefined {
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
			const closeParen = stat.lastIndexOf(")");
			const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
			const pgid = Number(fields[2]); // field 5; fields begin at state (field 3)
			const startToken = fields[19]; // field 22
			return Number.isFinite(pgid) && !!startToken ? { pgid, startTokenKind: "linux-proc-stat-22", startToken } : undefined;
		}
		if (process.platform === "darwin") {
			const nonce = process.env[IDENTITY_NONCE_ENV];
			if (!nonce || /[\s\0]/.test(nonce)) return undefined;
			const startToken = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
			const command = execFileSync("ps", ["-o", "command=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			const nonceArgument = `${SENTINEL_ARGUMENT_PREFIX}${nonce}`;
			return Number.isFinite(pgid) && !!startToken && command.trim().split(/\s+/).includes(nonceArgument)
				? { pgid, startTokenKind: "darwin-lstart-argv-nonce", startToken }
				: undefined;
		}
	} catch { /* unsupported or unavailable process inspection fails closed */ }
	return undefined;
}

function publishIdentity(): boolean {
	const file = process.env[IDENTITY_FILE_ENV];
	const nonce = process.env[IDENTITY_NONCE_ENV];
	if (!file && !nonce) return true;
	if (!file || !nonce) return false;
	const identity = inspectSelf();
	if (!identity) return false;
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ pid: process.pid, nonce, ...identity })}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, file);
		return true;
	} catch {
		try { rmSync(temporary, { force: true }); } catch { /* ignore failed cleanup */ }
		return false;
	}
}

function supervisorPath(): string {
	const entry = process.argv[1];
	if (!entry) return die();
	return entry;
}

function sentinelArgs(): string[] {
	const entry = supervisorPath();
	const nonceArgument = `${SENTINEL_ARGUMENT_PREFIX}${process.env[IDENTITY_NONCE_ENV] ?? ""}`;
	return entry.endsWith(".ts")
		? ["--import", createRequire(import.meta.url).resolve("tsx"), entry, SENTINEL_FLAG, nonceArgument]
		: [entry, SENTINEL_FLAG, nonceArgument];
}

function signalWitnessFd(): number | undefined {
	const value = process.env[SIGNAL_WITNESS_ENV];
	if (!value) return undefined;
	const fd = Number(value);
	return Number.isSafeInteger(fd) && fd >= 4 ? fd : die();
}

function payloadEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const name of INTERNAL_ENVIRONMENT) delete environment[name];
	return environment;
}

function runSentinel(): void {
	// Install this barrier before identity publication and FD-3 acknowledgement:
	// a host cancellation that races either must not strand a live payload without
	// the sentinel that owns its process group after root exit.
	const witnessFd = signalWitnessFd();
	for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) process.on(signal, () => {
		// Only the explicitly injected test FD observes this no-op handler. It is
		// absent in production and never becomes part of the payload environment.
		if (signal === "SIGTERM" && witnessFd != null) {
			try { writeSync(witnessFd, "."); } catch { /* test witness may have closed */ }
		}
	});
	if (!publishIdentity()) die();
	try {
		writeSync(3, ".");
		closeSync(3);
	} catch {
		die();
	}
	// The sentinel is the group member that survives root exit until the host's
	// final negative-PGID signal.
	setInterval(() => {}, 2_147_483_647);
}

function runSupervisor(): void {
	const payload = parsePayload();
	const witnessFd = signalWitnessFd();
	const sentinel = spawn(process.execPath, sentinelArgs(), {
		env: process.env,
		stdio: witnessFd == null ? ["ignore", "ignore", "ignore", 3] : ["ignore", "ignore", "ignore", 3, witnessFd],
	});
	// A failed sentinel never acknowledges FD 3. Let the host's ownership
	// barrier fail closed rather than running a payload without a durable group
	// member. Its spawn error is intentionally not forwarded to command stderr.
	sentinel.once("error", () => die());
	// Its process-group membership, not the supervisor's child-process handle,
	// is its lifetime authority. Unref lets the supervisor exit with the payload
	// while the sentinel retains the group for the host's final signal.
	sentinel.unref();
	try { closeSync(3); } catch { die(); }

	// FD 3 is exclusively the parent/sentinel readiness channel. Preserve every
	// caller-provided descriptor after it (for example a durable exit witness)
	// at its original shifted position without exposing FD 3 to the payload.
	// `/usr/bin/env --` is a fixed, shell-free execvp boundary on supported
	// POSIX hosts. It receives the configured executable only as a subsequent
	// argv element, avoiding an environment-tainted executable sink here.
	const child = spawn("/usr/bin/env", ["--", payload.file, ...payload.args], {
		env: payloadEnvironment(),
		stdio: ["inherit", "inherit", "inherit", "ignore", ...Array.from({ length: payload.stdioCount - 4 }, (_, index) => index + 4)],
	});
	let settled = false;
	const finish = (code: number | null, signal: NodeJS.Signals | null) => {
		if (settled) return;
		settled = true;
		if (signal) {
			// Preserve the payload's signal result. Setting a nonzero fallback first
			// prevents a blocked or otherwise undeliverable re-raise from returning a
			// false successful supervisor result.
			process.exitCode = 125;
			try { process.kill(process.pid, signal); } catch { process.exit(125); }
			return;
		}
		process.exit(code ?? 125);
	};
	child.once("error", () => finish(127, null));
	child.once("close", finish);
}

if (process.argv[2] === SENTINEL_FLAG) runSentinel();
else runSupervisor();

