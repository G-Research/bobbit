#!/usr/bin/env node

/**
 * Prepare the authoritative packed-consumer fixture once inside an E2E run.
 *
 * The coordinator packs Bobbit, resolves a lock-free external consumer into a
 * run-owned npm cache, installs the emitted tarball strictly offline into an
 * immutable template, and atomically publishes a descriptor. Browser workers
 * materialize that template; they never run npm pack/install themselves.
 */
import { existsSync, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import cacache from "cacache";
import { ensureDistBuild } from "./ensure-dist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DIST_BUILD_TIMEOUT_MS = 5 * 60_000;
const PACK_TIMEOUT_MS = 3 * 60_000;
const LOCK_RESOLUTION_TIMEOUT_MS = 5 * 60_000;
const CACHE_BATCH_TIMEOUT_MS = 3 * 60_000;
const OFFLINE_INSTALL_TIMEOUT_MS = 10 * 60_000;
// This bounds dist readiness plus the whole package-command sequence. Each
// owned command receives the absolute remaining preparation budget as its total
// lifetime, including ownership readiness. Tree shutdown proof remains bounded
// separately after that deadline fires.
export const PACKED_CONSUMER_PREPARATION_TIMEOUT_MS = 5 * 60_000;
const CACHE_BATCH_SIZE = 32;
const CACHE_WORKER_COUNT = 3;
const CACHE_TRANSFER_WORKER_COUNT = 8;
const CACHE_DISCOVERY_TIMEOUT_MS = 30_000;
const DESCRIPTOR_VERSION = 1;
const FIXTURE_DIRECTORY = "prepared-packed-consumer";
export const PACKED_CONSUMER_DESCRIPTOR_ENV = "BOBBIT_PACKED_CONSUMER_DESCRIPTOR";
// Hosted Windows may spend more than 10 seconds establishing the Job-backed
// ownership handshake under concurrent runner load. This remains a setup cap,
// but an optional command-wide deadline can expire sooner and includes setup.
export const OWNERSHIP_ESTABLISHMENT_TIMEOUT_MS = 30_000;
const TREE_EXIT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

function displayCommand(command, args) {
	return [command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}

function npmInvocation(env = process.env) {
	const candidates = [
		env.npm_execpath,
		join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
		resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	].filter(candidate => typeof candidate === "string" && candidate.length > 0);
	const cli = candidates.find(candidate => existsSync(candidate));
	if (!cli) throw new Error(`Unable to locate npm's JavaScript CLI beside ${process.execPath}`);
	return { command: process.execPath, argsPrefix: [cli] };
}

/** Remove npm-script/project state that an external consumer must not inherit. */
export function packedConsumerNpmEnv(cwd, baseEnv = process.env) {
	const env = { ...baseEnv };
	const projectScopedKeys = new Set([
		"npm_config_local_prefix",
		"npm_config_package_lock",
		"npm_config_shrinkwrap",
		"npm_config_workspace",
		"npm_config_workspaces",
		"npm_config_include_workspace_root",
		"npm_config_ignore_scripts",
		"npm_config_omit",
		"npm_config_include",
		"npm_config_optional",
		"npm_config_audit_level",
		"npm_config_dry_run",
	]);
	for (const key of Object.keys(env)) {
		const lower = key.toLowerCase();
		if (projectScopedKeys.has(lower) || lower.startsWith("npm_package_") || lower.startsWith("npm_lifecycle_")) {
			delete env[key];
		}
	}
	delete env.INIT_CWD;
	delete env.init_cwd;
	env.INIT_CWD = cwd;
	return env;
}

function isolatedNpmEnv(cwd, cacheDir, baseEnv) {
	const env = packedConsumerNpmEnv(cwd, baseEnv);
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "npm_config_cache") delete env[key];
	}
	env.npm_config_cache = cacheDir;
	return env;
}

async function defaultSpawnOwned(command, args, options) {
	options.signal?.throwIfAborted();
	let spawnTreePath = join(options.repoRoot, "dist", "server", "agent", "spawn-tree.js");
	if (!existsSync(spawnTreePath)) {
		// A clean checkout has no dist primitive yet. Bootstrap the exact source
		// implementation into the retained fixture root using Node's built-in
		// erasable-TypeScript support; do not launch an unowned compiler first.
		if (!options.ownershipBootstrapRoot) {
			throw new Error("Owned command startup requires an ownershipBootstrapRoot when dist is absent");
		}
		const bootstrapDir = join(options.ownershipBootstrapRoot, "ownership-bootstrap");
		await mkdir(bootstrapDir, { recursive: true });
		spawnTreePath = join(bootstrapDir, "spawn-tree.ts");
		if (!existsSync(spawnTreePath)) {
			const sourcePath = join(options.repoRoot, "src", "server", "agent", "spawn-tree.ts");
			const clockUrl = pathToFileURL(join(options.repoRoot, "src", "server", "clock.ts")).href;
			const source = await readFile(sourcePath, "utf8");
			const rewritten = source.replace('from "../clock.js"', `from ${JSON.stringify(clockUrl)}`);
			if (rewritten === source) throw new Error(`Unable to bind the source process-tree clock import in ${sourcePath}`);
			await writeFile(spawnTreePath, rewritten, { flag: "wx" });
		}
	}
	const { spawnTracked } = await import(pathToFileURL(spawnTreePath).href);
	// The command-wide deadline is armed before bootstrap/import. This final
	// synchronous check is the no-late-spawn boundary: once aborted, no child may
	// be created after async setup eventually returns.
	options.signal?.throwIfAborted();
	const tracked = spawnTracked(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	// Expose ownership in the same turn as child creation. A caller can then
	// terminate and join the tree even when this async factory is wrapped or its
	// returned promise is delayed after spawn.
	options.onSpawned?.(tracked);
	return tracked;
}

export function isCompleteOwnedCommandShutdown(shutdown) {
	return shutdown?.ownershipState === "established"
		&& shutdown.rootCloseObserved === true
		&& shutdown.treeExitAttempted === true
		&& shutdown.treeExitSettled === true
		&& shutdown.treeExitVerified === true
		&& shutdown.completionTimedOut === false;
}

export class OwnedCommandError extends Error {
	constructor(message, { cause, command, args, cwd, shutdown } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "OwnedCommandError";
		this.command = command;
		this.args = args ? [...args] : [];
		this.cwd = cwd;
		this.shutdown = Object.freeze({ ...shutdown });
	}
}

function commandDiagnostic({ rendered, cwd, child, ownershipState, killRequested, killError, closed, treeExit, treeExitTimeoutMs, stdout, stderr }) {
	const rootClose = closed.observed
		? `code=${closed.code ?? "null"}, signal=${closed.signal ?? "none"}`
		: `not observed within ${treeExitTimeoutMs}ms after termination request`;
	let treeExitDiagnostic = "verification not started";
	if (treeExit.attempted) {
		if (!treeExit.settled) treeExitDiagnostic = `verification did not complete within ${treeExitTimeoutMs}ms`;
		else if (treeExit.error) treeExitDiagnostic = `verification failed: ${treeExit.error.message}`;
		else treeExitDiagnostic = treeExit.verified ? "verified complete" : "not verified";
	}
	return [
		`command: ${rendered}`,
		`cwd: ${cwd}`,
		`pid: ${child.pid ?? "unavailable"}`,
		`ownership: ${ownershipState}`,
		`tree termination requested: ${killRequested ? "yes (SIGKILL)" : "no"}${killError ? `; request failed: ${killError.message}` : ""}`,
		`root close: ${rootClose}`,
		`tree exit: ${treeExitDiagnostic}`,
		`stdout:\n${stdout}`,
		`stderr:\n${stderr}`,
	].join("\n");
}

/**
 * Run a shell-free command whose whole process tree is owned. Timeout/overflow
 * requests one owned-tree kill, then joins both root close and the tracked
 * tree-completion barrier before returning diagnostics.
 */
export async function runOwnedCommand(command, args, {
	cwd,
	env = process.env,
	timeoutMs,
	totalTimeoutMs,
	maxOutputBytes = MAX_OUTPUT_BYTES,
	ownershipEstablishmentTimeoutMs = OWNERSHIP_ESTABLISHMENT_TIMEOUT_MS,
	treeExitTimeoutMs = TREE_EXIT_TIMEOUT_MS,
	repoRoot = REPO_ROOT,
	ownershipBootstrapRoot,
	spawnOwned = defaultSpawnOwned,
	now = () => performance.now(),
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	setCompletionTimer = setTimeout,
	clearCompletionTimer = clearTimeout,
} = {}) {
	if (!cwd) throw new Error("cwd is required");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
	if (totalTimeoutMs !== undefined && (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0)) {
		throw new Error("totalTimeoutMs must be a positive number when provided");
	}
	if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("maxOutputBytes must be a positive number");
	if (!Number.isFinite(ownershipEstablishmentTimeoutMs) || ownershipEstablishmentTimeoutMs <= 0) {
		throw new Error("ownershipEstablishmentTimeoutMs must be a positive number");
	}
	if (!Number.isFinite(treeExitTimeoutMs) || treeExitTimeoutMs <= 0) throw new Error("treeExitTimeoutMs must be a positive number");

	const rendered = displayCommand(command, args);
	const totalStartedAt = now();
	const spawnAbort = new AbortController();
	const stdout = [];
	const stderr = [];
	let outputBytes = 0;
	let terminalError;
	let tracked;
	let child;
	let killRequested = false;
	let killError;
	let ownershipState = "pending";
	let ownershipTimer;
	let executionTimer;
	let totalTimer;
	let completionTimer;
	let resolveKillRequested;
	let resolveSpawnDeadline;
	let resolveCompletionTimeout;
	const killRequestedResult = new Promise(resolveKill => { resolveKillRequested = resolveKill; });
	const spawnDeadlineResult = new Promise(resolveDeadline => { resolveSpawnDeadline = resolveDeadline; });
	const completionTimeoutResult = new Promise(resolveTimeout => { resolveCompletionTimeout = resolveTimeout; });
	const treeExit = { attempted: false, settled: false, verified: false, error: undefined };
	let treeExitResult;
	let closeSettled = false;
	let resolveCloseResult;
	const closeResult = new Promise(resolveClose => { resolveCloseResult = resolveClose; });
	let outputDetached = false;

	const startTreeExitVerification = () => {
		if (treeExitResult) return treeExitResult;
		if (!tracked) throw new Error("Cannot verify a process tree before its owned handle is exposed");
		treeExit.attempted = true;
		treeExitResult = (async () => {
			try {
				const verified = await tracked.waitForTreeExit(treeExitTimeoutMs);
				treeExit.settled = true;
				treeExit.verified = verified === true;
			} catch (error) {
				treeExit.settled = true;
				treeExit.error = error instanceof Error ? error : new Error(String(error));
			}
		})();
		return treeExitResult;
	};
	const armCompletionTimeout = () => {
		if (completionTimer !== undefined) return;
		completionTimer = setCompletionTimer(() => resolveCompletionTimeout(), treeExitTimeoutMs);
	};
	const requestOwnedKill = (error) => {
		if (!terminalError) terminalError = error;
		if (!tracked || killRequested) return;
		killRequested = true;
		armCompletionTimeout();
		resolveKillRequested();
		try {
			tracked.killTree("SIGKILL");
		} catch (killFailure) {
			killError = killFailure instanceof Error ? killFailure : new Error(String(killFailure));
		} finally {
			startTreeExitVerification();
		}
	};
	const collect = (target, chunk) => {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (outputBytes + buffer.byteLength > maxOutputBytes) {
			requestOwnedKill(new Error(`${rendered} exceeded the ${maxOutputBytes}-byte output limit`));
			return;
		}
		outputBytes += buffer.byteLength;
		target.push(buffer);
	};
	const collectStdout = chunk => collect(stdout, chunk);
	const collectStderr = chunk => collect(stderr, chunk);
	const detachOutputListeners = () => {
		if (outputDetached || !child) return;
		outputDetached = true;
		child.stdout?.off("data", collectStdout);
		child.stderr?.off("data", collectStderr);
	};
	const finishClose = result => {
		if (closeSettled) return;
		closeSettled = true;
		child?.off("error", onError);
		child?.off("close", onClose);
		resolveCloseResult(result);
	};
	const onError = error => finishClose({ spawnError: error, code: null, signal: null });
	const onClose = (code, signal) => finishClose({ code, signal });
	const exposeSpawned = candidate => {
		if (tracked && tracked !== candidate) {
			throw new Error(`${rendered} spawn factory exposed more than one owned process tree`);
		}
		if (tracked) return tracked;
		if (!candidate?.child || typeof candidate.killTree !== "function" || typeof candidate.waitForTreeExit !== "function") {
			throw new Error(`${rendered} spawn factory exposed an invalid owned process-tree handle`);
		}
		tracked = candidate;
		child = candidate.child;
		child.stdout?.on("data", collectStdout);
		child.stderr?.on("data", collectStderr);
		child.once("error", onError);
		child.once("close", onClose);
		if (terminalError) requestOwnedKill(terminalError);
		return tracked;
	};
	const closed = { observed: false, code: null, signal: null, spawnError: undefined };
	const observedCloseResult = closeResult.then(result => {
		closed.observed = true;
		closed.code = result.code;
		closed.signal = result.signal;
		closed.spawnError = result.spawnError;
		detachOutputListeners();
		if (executionTimer !== undefined) {
			clearTimer(executionTimer);
			executionTimer = undefined;
		}
		if (totalTimer !== undefined) {
			clearTimer(totalTimer);
			totalTimer = undefined;
		}
	});
	const deadlineError = totalTimeoutMs === undefined
		? undefined
		: new Error(`${rendered} exceeded its ${totalTimeoutMs}ms total deadline (including ownership readiness)`);
	if (deadlineError) {
		const remainingMs = totalTimeoutMs - Math.max(0, now() - totalStartedAt);
		const expire = () => {
			if (!terminalError) terminalError = deadlineError;
			spawnAbort.abort(deadlineError);
			requestOwnedKill(deadlineError);
			resolveSpawnDeadline();
		};
		if (remainingMs <= 0) expire();
		else totalTimer = setTimer(expire, remainingMs);
	}

	let spawnFailure;
	if (!spawnAbort.signal.aborted) {
		// Convert both branches to values before racing. If the absolute deadline
		// wins, a bootstrap/import/custom factory may remain pending indefinitely;
		// its eventual rejection is still observed and cannot become unhandled.
		let spawnInvocation;
		try {
			spawnInvocation = Promise.resolve(spawnOwned(command, args, {
				cwd,
				env,
				repoRoot,
				ownershipBootstrapRoot,
				signal: spawnAbort.signal,
				onSpawned: exposeSpawned,
			}));
		} catch (error) {
			spawnInvocation = Promise.reject(error);
		}
		const spawnSettlement = spawnInvocation.then(
			returned => {
				try {
					// Keep observing a late return even after the deadline race has
					// settled. Factories should expose at creation, but a returned
					// handle is still captured and terminated rather than abandoned.
					exposeSpawned(returned);
					return { status: "fulfilled", returned };
				} catch (error) {
					return { status: "rejected", error };
				}
			},
			error => ({ status: "rejected", error }),
		);
		const spawnBoundary = deadlineError
			? await Promise.race([
				spawnSettlement,
				spawnDeadlineResult.then(() => ({ status: "deadline" })),
			])
			: await spawnSettlement;
		if (spawnBoundary.status === "rejected") {
			spawnFailure = spawnBoundary.error instanceof Error
				? spawnBoundary.error
				: new Error(String(spawnBoundary.error));
		}
	}
	if (!tracked) {
		if (totalTimer !== undefined) clearTimer(totalTimer);
		ownershipState = terminalError ? "not spawned before deadline" : "spawn failed";
		const cause = terminalError ?? spawnFailure ?? new Error(`Failed to spawn ${rendered}`);
		const shutdown = Object.freeze({
			ownershipState,
			killRequested: false,
			rootCloseObserved: false,
			rootExitCode: null,
			rootSignal: null,
			treeExitAttempted: false,
			treeExitSettled: false,
			treeExitVerified: false,
			completionTimedOut: false,
		});
		throw new OwnedCommandError(
			`${cause.message}\ncommand: ${rendered}\ncwd: ${cwd}\npid: unavailable\nownership: ${ownershipState}\ntree termination requested: no\ntree exit: not applicable (no child created)`,
			{ cause, command, args, cwd, shutdown },
		);
	}
	if (spawnFailure) {
		requestOwnedKill(new Error(`${rendered} spawn factory failed after exposing its owned process tree`, { cause: spawnFailure }));
	}

	const ownershipTimeoutError = new Error(`${rendered} ownership readiness timed out after ${ownershipEstablishmentTimeoutMs}ms`);
	const terminationDuringOwnership = Symbol("termination-during-ownership");
	try {
		await Promise.race([
			tracked.ownershipReady,
			new Promise((_, reject) => {
				ownershipTimer = setTimer(() => reject(ownershipTimeoutError), ownershipEstablishmentTimeoutMs);
			}),
			killRequestedResult.then(() => { throw terminationDuringOwnership; }),
		]);
		ownershipState = "established";
	} catch (error) {
		if (error === terminationDuringOwnership) {
			ownershipState = "termination requested before readiness";
		} else {
			ownershipState = error === ownershipTimeoutError ? "timed out" : "failed";
			requestOwnedKill(error === ownershipTimeoutError
				? ownershipTimeoutError
				: new Error(`${rendered} did not establish process-tree ownership`, { cause: error }));
		}
	} finally {
		if (ownershipTimer !== undefined) clearTimer(ownershipTimer);
	}
	if (!terminalError) {
		const totalRemainingMs = totalTimeoutMs === undefined
			? Number.POSITIVE_INFINITY
			: totalTimeoutMs - Math.max(0, now() - totalStartedAt);
		if (totalRemainingMs <= 0) {
			requestOwnedKill(new Error(`${rendered} exceeded its ${totalTimeoutMs}ms total deadline (including ownership readiness)`));
		} else if (timeoutMs < totalRemainingMs) {
			executionTimer = setTimer(() => requestOwnedKill(new Error(`${rendered} timed out after ${timeoutMs}ms`)), timeoutMs);
		}
	}

	let completionTimedOut = false;
	const firstBoundary = await Promise.race([
		observedCloseResult.then(() => "close"),
		killRequestedResult.then(() => "kill"),
	]);
	if (firstBoundary === "close") {
		startTreeExitVerification();
		armCompletionTimeout();
	}
	const completionResult = Promise.all([observedCloseResult, startTreeExitVerification()]);
	completionTimedOut = await Promise.race([
		completionResult.then(() => false),
		completionTimeoutResult.then(() => true),
	]);

	child.off("error", onError);
	child.off("close", onClose);
	detachOutputListeners();
	if (executionTimer !== undefined) clearTimer(executionTimer);
	if (totalTimer !== undefined) clearTimer(totalTimer);
	if (completionTimer !== undefined) clearCompletionTimer(completionTimer);
	const stdoutText = Buffer.concat(stdout).toString("utf8");
	const stderrText = Buffer.concat(stderr).toString("utf8");
	const diagnostic = commandDiagnostic({
		rendered,
		cwd,
		child,
		ownershipState,
		killRequested,
		killError,
		closed,
		treeExit,
		treeExitTimeoutMs,
		stdout: stdoutText,
		stderr: stderrText,
	});

	const shutdown = {
		ownershipState,
		killRequested,
		rootCloseObserved: closed.observed,
		rootExitCode: closed.code,
		rootSignal: closed.signal,
		treeExitAttempted: treeExit.attempted,
		treeExitSettled: treeExit.settled,
		treeExitVerified: treeExit.verified === true,
		completionTimedOut,
	};
	const ownedCommandError = (message, cause) => new OwnedCommandError(message, {
		cause,
		command,
		args,
		cwd,
		shutdown,
	});
	if (completionTimedOut || !closed.observed) {
		const terminalContext = terminalError ? `${terminalError.message}\n` : "";
		throw ownedCommandError(
			`${terminalContext}${rendered} did not complete its process-tree shutdown within ${treeExitTimeoutMs}ms\n${diagnostic}`,
			terminalError,
		);
	}
	if (!treeExit.verified) {
		throw ownedCommandError(
			`${rendered} closed without verified process-tree completion\n${diagnostic}`,
			treeExit.error ?? terminalError,
		);
	}
	if (terminalError) throw ownedCommandError(`${terminalError.message}\n${diagnostic}`, terminalError);
	if (closed.spawnError) throw ownedCommandError(`Failed to spawn ${rendered}: ${closed.spawnError.message}\n${diagnostic}`, closed.spawnError);
	if (closed.signal || closed.code === null) throw ownedCommandError(`${rendered} terminated without an exit code\n${diagnostic}`);
	return {
		command,
		args: [...args],
		code: closed.code,
		stdout: stdoutText,
		stderr: stderrText,
		shutdown: Object.freeze(shutdown),
	};
}

function requireSuccess(result) {
	if (result.code === 0) return;
	throw new Error(`${displayCommand(result.command, result.args)} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function parsePackResult(stdout, expectedPackageName) {
	let parsed;
	try { parsed = JSON.parse(stdout); } catch (error) {
		throw new Error(`npm pack emitted malformed JSON: ${error.message}`, { cause: error });
	}
	if (!Array.isArray(parsed) || parsed.length !== 1) {
		throw new Error(`npm pack must report exactly one result, received ${JSON.stringify(parsed)}`);
	}
	const entry = parsed[0];
	if (!entry || typeof entry !== "object" || entry.name !== expectedPackageName ||
		typeof entry.filename !== "string" || entry.filename.length === 0 || basename(entry.filename) !== entry.filename) {
		throw new Error(`npm pack reported an invalid result: ${JSON.stringify(entry)}`);
	}
	return { entry, report: parsed };
}

function readPackageLock(path, label) {
	let parsed;
	try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
		throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || parsed.lockfileVersion !== 3 ||
		!parsed.packages || typeof parsed.packages !== "object" || Array.isArray(parsed.packages)) {
		throw new Error(`${label} must be a package-lock v3 document with a packages object`);
	}
	return parsed;
}

function assertPackedArtifactLock(lock, packageName, resolverDir, tarballPath) {
	const rootSpec = lock.packages?.[""]?.dependencies?.[packageName];
	const installedSpec = lock.packages?.[`node_modules/${packageName}`]?.resolved;
	for (const [label, spec] of [["root dependency", rootSpec], ["installed package", installedSpec]]) {
		if (typeof spec !== "string" || !spec.startsWith("file:")) {
			throw new Error(`Generated consumer lock ${label} for ${packageName} must be a file: reference`);
		}
		let lockedPath;
		try { lockedPath = resolve(resolverDir, decodeURIComponent(spec.slice("file:".length))); } catch (error) {
			throw new Error(`Generated consumer lock ${label} for ${packageName} has an invalid file: reference`, { cause: error });
		}
		if (lockedPath !== resolve(tarballPath)) {
			throw new Error(`Generated consumer lock ${label} for ${packageName} does not resolve to the emitted tarball`);
		}
	}
}

function allowsRuntime(values, actual, field, location) {
	if (values === undefined) return true;
	const list = typeof values === "string" ? [values] : values;
	if (!Array.isArray(list) || list.some(value => typeof value !== "string" || value.length === 0)) {
		throw new Error(`${location} has an invalid ${field} constraint`);
	}
	if (!actual) return false;
	if (list.length === 1 && list[0] === "any") return true;
	let negated = 0;
	let matched = false;
	for (const value of list) {
		const denied = value.startsWith("!");
		const expected = denied ? value.slice(1) : value;
		if (denied) {
			negated++;
			if (actual === expected) return false;
		} else if (actual === expected) matched = true;
	}
	return matched || negated === list.length;
}

function runtimeLibc(platform = process.platform) {
	if (platform !== "linux") return undefined;
	const report = process.report?.getReport?.();
	return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function compatibleRegistryArtifacts(lock, {
	platform = process.platform,
	arch = process.arch,
	libc = runtimeLibc(platform),
} = {}) {
	const artifacts = new Map();
	for (const [location, entry] of Object.entries(lock.packages)) {
		if (!location || !entry || typeof entry !== "object") continue;
		const resolved = entry.resolved;
		if (typeof resolved !== "string" || !/^https:\/\//.test(resolved)) continue;
		if (typeof entry.version !== "string" || entry.version.length === 0) {
			throw new Error(`${location} has a registry tarball without an exact version`);
		}
		if (!allowsRuntime(entry.os, platform, "os", location) ||
			!allowsRuntime(entry.cpu, arch, "cpu", location) ||
			!allowsRuntime(entry.libc, libc, "libc", location)) continue;
		const integrity = typeof entry.integrity === "string" && entry.integrity.length > 0
			? entry.integrity
			: undefined;
		const identity = integrity ? `integrity:${integrity}` : `url:${resolved}`;
		if (!artifacts.has(identity)) artifacts.set(identity, { resolved, integrity });
	}
	return [...artifacts.values()].sort((left, right) =>
		(left.integrity ?? left.resolved).localeCompare(right.integrity ?? right.resolved) ||
		left.resolved.localeCompare(right.resolved));
}

function compatibleRegistryTarballs(lock, runtime = {}) {
	return new Set(compatibleRegistryArtifacts(lock, runtime).map(artifact => artifact.resolved));
}

export function lockedTarballsMissingFromRepository(consumerLock, repositoryLock, runtime = {}) {
	const required = compatibleRegistryTarballs(consumerLock, runtime);
	const alreadyCached = compatibleRegistryTarballs(repositoryLock, runtime);
	return [...required].filter(url => !alreadyCached.has(url)).sort();
}

const DEFAULT_CONTENT_CACHE = Object.freeze({
	hasContent: (cache, integrity) => cacache.get.hasContent(cache, integrity),
	createReadStream: (cache, integrity) => cacache.get.stream.byDigest(cache, integrity),
	createWriteStream: (cache, key, options) => cacache.put.stream(cache, key, options),
});

function cacheMiss(error) {
	return error?.code === "ENOENT" || error?.code === "EINTEGRITY";
}

function transferKey(artifact) {
	return `packed-consumer:${artifact.resolved}`;
}

async function transferArtifact({
	artifact,
	sourceContentCache,
	destinationContentCache,
	contentCache,
	remainingPreparationMs,
	setTimer,
	clearTimer,
}) {
	let sourceHit;
	try {
		sourceHit = await contentCache.hasContent(sourceContentCache, artifact.integrity);
	} catch (error) {
		if (cacheMiss(error)) return false;
		throw error;
	}
	if (!sourceHit) return false;
	const remainingMs = remainingPreparationMs(`cache transfer ${artifact.integrity}`);
	const abort = new AbortController();
	const timer = setTimer(() => abort.abort(new Error(
		`Packed-consumer cache transfer exceeded the preparation deadline for ${artifact.resolved}`,
	)), remainingMs);
	let source;
	let destination;
	try {
		source = contentCache.createReadStream(sourceContentCache, artifact.integrity);
		destination = contentCache.createWriteStream(
			destinationContentCache,
			transferKey(artifact),
			{ integrity: artifact.integrity },
		);
		await pipeline(source, destination, { signal: abort.signal });
		remainingPreparationMs(`post-transfer verification ${artifact.integrity}`);
		return true;
	} catch (error) {
		if (!abort.signal.aborted && cacheMiss(error)) return false;
		throw error;
	} finally {
		clearTimer(timer);
		// pipeline() normally destroys both streams itself. These calls also fence
		// adapters that reject before attaching the whole chain.
		source?.destroy?.();
		destination?.destroy?.();
	}
}

async function transferAvailableArtifacts({
	artifacts,
	sourceContentCache,
	destinationContentCache,
	contentCache,
	remainingPreparationMs,
	setTimer,
	clearTimer,
}) {
	const transferable = artifacts.filter(artifact => artifact.integrity);
	const missing = [];
	let transferredCount = 0;
	const failures = new Array(transferable.length);
	let nextIndex = 0;
	let stopAdmission = false;
	const worker = async () => {
		while (!stopAdmission) {
			const index = nextIndex++;
			if (index >= transferable.length) return;
			try {
				const transferred = await transferArtifact({
					artifact: transferable[index],
					sourceContentCache,
					destinationContentCache,
					contentCache,
					remainingPreparationMs,
					setTimer,
					clearTimer,
				});
				if (transferred) transferredCount++;
				else missing.push(transferable[index]);
			} catch (error) {
				failures[index] = error;
				stopAdmission = true;
			}
		}
	};
	await Promise.allSettled(Array.from(
		{ length: Math.min(CACHE_TRANSFER_WORKER_COUNT, transferable.length) },
		() => worker(),
	));
	const observed = failures.filter(error => error !== undefined);
	if (observed.length > 0) {
		throw new AggregateError(observed, "Packed-consumer cache transfer failed");
	}
	const noIntegrity = artifacts.filter(artifact => !artifact.integrity);
	return {
		fallbackArtifacts: [...missing, ...noIntegrity].sort((left, right) => left.resolved.localeCompare(right.resolved)),
		transferredCount,
		missingDigestCount: missing.length,
		noIntegrityCount: noIntegrity.length,
	};
}

async function verifyDestinationArtifacts(artifacts, destinationContentCache, contentCache, remainingPreparationMs) {
	const missing = [];
	for (const artifact of artifacts) {
		if (!artifact.integrity) continue;
		remainingPreparationMs(`destination digest verification ${artifact.integrity}`);
		let present;
		try {
			present = await contentCache.hasContent(destinationContentCache, artifact.integrity);
		} catch (error) {
			if (!cacheMiss(error)) throw error;
		}
		remainingPreparationMs(`post-destination digest verification ${artifact.integrity}`);
		if (!present) missing.push(`${artifact.resolved} (${artifact.integrity})`);
	}
	if (missing.length > 0) {
		throw new Error(`Packed-consumer isolated cache is missing required digests after transfer/fetch:\n${missing.join("\n")}`);
	}
}

function ambientCacheFromOutput(stdout) {
	const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	if (lines.length !== 1 || !isAbsolute(lines[0])) {
		throw new Error(`npm config get cache must return one absolute path, received ${JSON.stringify(stdout)}`);
	}
	return resolve(lines[0]);
}

function isStrictChild(root, candidate) {
	const child = relative(resolve(root), resolve(candidate));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertOwnedPath(runRoot, candidate, label) {
	if (!isStrictChild(runRoot, candidate)) throw new Error(`${label} must be a strict child of the E2E run root`);
}

async function measured(label, operation) {
	const start = Date.now();
	console.log(`[packed-consumer] ${label}: started`);
	try {
		const result = await operation();
		console.log(`[packed-consumer] ${label}: completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
		return result;
	} catch (error) {
		console.error(`[packed-consumer] ${label}: failed after ${((Date.now() - start) / 1000).toFixed(1)}s`);
		throw error;
	}
}

function cleanConsumerManifest(nodeTypesVersion) {
	return {
		name: "bobbit-inline-theme-clean-consumer",
		version: "1.0.0",
		private: true,
		...(nodeTypesVersion ? { overrides: { "@types/node": nodeTypesVersion } } : {}),
	};
}

async function writeManifest(directory, manifest) {
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function errorEvidence(error) {
	if (!(error instanceof Error)) return { message: String(error) };
	const cause = error.cause;
	const owned = error instanceof OwnedCommandError ? {
		command: error.command,
		args: error.args,
		cwd: error.cwd,
		shutdown: error.shutdown,
	} : {};
	const aggregate = error instanceof AggregateError ? {
		errors: [...error.errors].map(errorEvidence),
	} : {};
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
		...owned,
		...aggregate,
		...(cause === undefined ? {} : { cause: errorEvidence(cause) }),
	};
}

async function retainPreparationFailure({ fixtureRoot, commands, error }) {
	const evidencePath = join(fixtureRoot, "preparation-failure.json");
	const evidence = {
		status: "failed",
		fixtureRoot,
		failedAt: new Date().toISOString(),
		error: errorEvidence(error),
		commands,
	};
	try {
		await mkdir(fixtureRoot, { recursive: true });
		await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
	} catch (evidenceError) {
		throw new AggregateError(
			[error, evidenceError],
			`Packed-consumer preparation failed and failure evidence could not be written at ${evidencePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const retained = new Error(
		`Packed-consumer preparation failed; retained partial fixture and command evidence at ${evidencePath}: ${error instanceof Error ? error.message : String(error)}`,
		{ cause: error },
	);
	retained.fixtureRoot = fixtureRoot;
	retained.evidencePath = evidencePath;
	retained.commands = commands;
	throw retained;
}

/** Ensure dist under the same preparation deadline and owned-tree boundary. */
export async function ensurePackedConsumerDist({
	repoRoot,
	baseEnv,
	npm,
	fixtureRoot,
	commands,
	runCommand,
	remainingPreparationMs,
	ensureDistBuildFn = ensureDistBuild,
}) {
	return ensureDistBuildFn({
		repoRoot,
		lockWaitMs: remainingPreparationMs("dist build lock"),
		runBuild: async () => {
			const args = [...npm.argsPrefix, "run", "build"];
			const totalTimeoutMs = remainingPreparationMs("npm run build");
			const result = await runCommand(npm.command, args, {
				cwd: repoRoot,
				env: baseEnv,
				timeoutMs: Math.min(DIST_BUILD_TIMEOUT_MS, totalTimeoutMs),
				totalTimeoutMs,
				repoRoot,
				ownershipBootstrapRoot: fixtureRoot,
			});
			commands.push(result);
			requireSuccess(result);
		},
	});
}

/**
 * Build one immutable packed-consumer template and publish its descriptor only
 * after the actual tarball, lockfile, and installed dependency tree exist.
 */
export async function preparePackedConsumerFixture({
	repoRoot = REPO_ROOT,
	runRoot,
	baseEnv = process.env,
	ensureDist,
	runCommand = runOwnedCommand,
	resolveNpm = npmInvocation,
	runtime,
	contentCache = DEFAULT_CONTENT_CACHE,
	preparationTimeoutMs = PACKED_CONSUMER_PREPARATION_TIMEOUT_MS,
	now = () => performance.now(),
	setTimer = setTimeout,
	clearTimer = clearTimeout,
} = {}) {
	if (!runRoot) throw new Error("preparePackedConsumerFixture requires runRoot");
	if (!Number.isFinite(preparationTimeoutMs) || preparationTimeoutMs <= 0) {
		throw new Error("preparationTimeoutMs must be a positive number");
	}
	const preparationStartedAt = now();
	let latestNow = preparationStartedAt;
	const remainingPreparationMs = (label) => {
		latestNow = Math.max(latestNow, now());
		const elapsedMs = latestNow - preparationStartedAt;
		const remainingMs = preparationTimeoutMs - elapsedMs;
		if (remainingMs <= 0) {
			throw new Error(`Packed-consumer preparation deadline exhausted before ${label} after ${Math.round(elapsedMs)}ms (limit ${preparationTimeoutMs}ms)`);
		}
		return Math.ceil(remainingMs);
	};
	const commandDeadline = (label, commandTimeoutMs) => {
		const totalTimeoutMs = remainingPreparationMs(label);
		return {
			timeoutMs: Math.min(commandTimeoutMs, totalTimeoutMs),
			totalTimeoutMs,
		};
	};
	const absoluteRunRoot = resolve(runRoot);
	const fixtureRoot = join(absoluteRunRoot, FIXTURE_DIRECTORY);
	const packDir = join(fixtureRoot, "pack");
	// Template and materialized consumers stay at the same directory depth so
	// npm's saved relative file: reference to the real tarball remains valid.
	const preparationDir = join(fixtureRoot, "preparation");
	const resolverDir = join(preparationDir, "resolver");
	const templateDir = join(preparationDir, "template");
	const cacheDir = join(fixtureRoot, "npm-cache");
	const consumersDir = join(fixtureRoot, "materialized");
	const descriptorPath = join(fixtureRoot, "descriptor.json");
	for (const [label, candidate] of Object.entries({ fixtureRoot, packDir, preparationDir, resolverDir, templateDir, cacheDir, consumersDir, descriptorPath })) {
		assertOwnedPath(absoluteRunRoot, candidate, label);
	}
	if (existsSync(fixtureRoot)) throw new Error(`Packed-consumer fixture was already prepared at ${fixtureRoot}`);

	const commands = [];
	try {
		await Promise.all([
			mkdir(packDir, { recursive: true }),
			mkdir(resolverDir, { recursive: true }),
			mkdir(templateDir, { recursive: true }),
			mkdir(cacheDir, { recursive: true }),
			mkdir(consumersDir, { recursive: true }),
		]);
		const npm = resolveNpm(baseEnv);
		await measured("build", async () => {
			if (ensureDist) {
				const totalTimeoutMs = remainingPreparationMs("dist build");
				await ensureDist({
					timeoutMs: totalTimeoutMs,
					totalTimeoutMs,
					fixtureRoot,
					commands,
					runCommand,
				});
			} else {
				await ensurePackedConsumerDist({
					repoRoot,
					baseEnv,
					npm,
					fixtureRoot,
					commands,
					runCommand,
					remainingPreparationMs,
				});
			}
			remainingPreparationMs("post-build preparation");
		});
		const packageManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
		const packageName = packageManifest.name;
		if (typeof packageName !== "string" || packageName.length === 0) throw new Error("package.json must declare a package name");
		const repositoryLock = readPackageLock(join(repoRoot, "package-lock.json"), "repository package-lock.json");
		const nodeTypesVersion = repositoryLock.packages?.["node_modules/@types/node"]?.version;
		const consumerManifest = cleanConsumerManifest(nodeTypesVersion);
		// Seed Arborist with the checkout's exact graph. npm remains authoritative:
		// it prunes this lock to the minimal external manifest and adds the emitted
		// tarball rather than solving the complete graph online from an empty lock.
		await Promise.all([
			writeManifest(resolverDir, consumerManifest),
			writeManifest(templateDir, consumerManifest),
			copyFile(join(repoRoot, "package-lock.json"), join(resolverDir, "package-lock.json")),
		]);

		const packArgs = [...npm.argsPrefix, "pack", "--ignore-scripts", "--json", "--pack-destination", packDir];
		const packCommand = await measured("pack", async () => {
			const result = await runCommand(npm.command, packArgs, {
				cwd: repoRoot,
				env: baseEnv,
				...commandDeadline("npm pack", PACK_TIMEOUT_MS),
				repoRoot,
			});
			commands.push(result);
			requireSuccess(result);
			return result;
		});
		const { entry: packEntry, report: packReport } = parsePackResult(packCommand.stdout, packageName);
		const tarballPath = resolve(packDir, packEntry.filename);
		assertOwnedPath(absoluteRunRoot, tarballPath, "tarballPath");
		const tarball = await stat(tarballPath).catch(() => undefined);
		if (!tarball?.isFile()) throw new Error(`npm pack did not create ${tarballPath}`);

		const resolverEnv = isolatedNpmEnv(resolverDir, cacheDir, baseEnv);
		const resolveArgs = [
			...npm.argsPrefix,
			"install",
			"--package-lock-only",
			"--offline",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--cache", cacheDir,
			tarballPath,
		];
		const resolveCommand = await measured("resolve lock", async () => {
			const result = await runCommand(npm.command, resolveArgs, {
				cwd: resolverDir,
				env: resolverEnv,
				...commandDeadline("npm lock resolution", LOCK_RESOLUTION_TIMEOUT_MS),
				repoRoot,
			});
			commands.push(result);
			requireSuccess(result);
			return result;
		});
		const resolverManifestPath = join(resolverDir, "package.json");
		const resolverLockPath = join(resolverDir, "package-lock.json");
		const consumerLock = readPackageLock(resolverLockPath, "generated consumer package-lock.json");
		assertPackedArtifactLock(consumerLock, packageName, resolverDir, tarballPath);
		// `npm install --package-lock-only <tarball>` records the exact local
		// tarball spec in both package.json and package-lock.json. Stage those
		// outputs into the same-depth template so `npm ci` only materializes that
		// resolved graph. Leaving the template manifest empty makes npm 11 solve
		// the full dependency graph a second time and caused the 600-second Windows hang.
		await Promise.all([
			copyFile(resolverManifestPath, join(templateDir, "package.json")),
			copyFile(resolverLockPath, join(templateDir, "package-lock.json")),
		]);
		const discoveryArgs = [...npm.argsPrefix, "config", "get", "cache"];
		const discoveryCommand = await measured("ambient cache discovery", async () => {
			const result = await runCommand(npm.command, discoveryArgs, {
				cwd: repoRoot,
				env: packedConsumerNpmEnv(repoRoot, baseEnv),
				...commandDeadline("ambient npm cache discovery", CACHE_DISCOVERY_TIMEOUT_MS),
				repoRoot,
			});
			commands.push(result);
			requireSuccess(result);
			return result;
		});
		const ambientCacheDir = ambientCacheFromOutput(discoveryCommand.stdout);
		if (ambientCacheDir === resolve(cacheDir) || ambientCacheDir === resolve(fixtureRoot) || isStrictChild(fixtureRoot, ambientCacheDir)) {
			throw new Error(`Ambient npm cache must lie outside the packed-consumer fixture: ${ambientCacheDir}`);
		}
		const sourceContentCache = join(ambientCacheDir, "_cacache");
		const destinationContentCache = join(cacheDir, "_cacache");
		assertOwnedPath(absoluteRunRoot, destinationContentCache, "destinationContentCache");

		const selectedArtifacts = compatibleRegistryArtifacts(consumerLock, runtime);
		console.log(`[packed-consumer] cache: selectively transferring ${selectedArtifacts.filter(artifact => artifact.integrity).length} exact digests from ${ambientCacheDir}`);
		const transferResult = await measured("cache transfer", () => transferAvailableArtifacts({
			artifacts: selectedArtifacts,
			sourceContentCache,
			destinationContentCache,
			contentCache,
			remainingPreparationMs,
			setTimer,
			clearTimer,
		}));
		console.log(`[packed-consumer] cache transfer: ${transferResult.transferredCount} hits, ${transferResult.missingDigestCount} digest misses, ${transferResult.noIntegrityCount} no-integrity fallbacks`);
		const fallbackUrls = [...new Set(transferResult.fallbackArtifacts.map(artifact => artifact.resolved))].sort();
		const cacheBatches = [];
		for (let offset = 0; offset < fallbackUrls.length; offset += CACHE_BATCH_SIZE) {
			cacheBatches.push(fallbackUrls.slice(offset, offset + CACHE_BATCH_SIZE));
		}
		console.log(`[packed-consumer] cache: fetching ${fallbackUrls.length} exact misses in ${cacheBatches.length} batches`);
		const cacheResults = new Array(cacheBatches.length);
		const cacheFailures = new Array(cacheBatches.length);
		let nextBatchIndex = 0;
		let stopAdmission = false;
		const cacheWorker = async () => {
			while (!stopAdmission) {
				// JavaScript runs this claim without an await, so workers cannot claim
				// the same batch. A failure closes admission before this point can run again.
				const batchIndex = nextBatchIndex++;
				if (batchIndex >= cacheBatches.length) return;
				const batch = cacheBatches[batchIndex];
				try {
					const result = await measured(`cache batch ${batchIndex + 1}/${cacheBatches.length}`, () =>
						runCommand(npm.command, [...npm.argsPrefix, "cache", "add", "--cache", cacheDir, ...batch], {
							cwd: resolverDir,
							env: resolverEnv,
							// Calculate this at admission, not while partitioning, so all
							// children share the unchanged absolute preparation deadline.
							...commandDeadline(`npm cache batch ${batchIndex + 1}`, CACHE_BATCH_TIMEOUT_MS),
							repoRoot,
						}),
					);
					cacheResults[batchIndex] = result;
					requireSuccess(result);
				} catch (error) {
					cacheFailures[batchIndex] = error;
					stopAdmission = true;
					return;
				}
			}
		};
		await Promise.allSettled(
			Array.from({ length: Math.min(CACHE_WORKER_COUNT, cacheBatches.length) }, () => cacheWorker()),
		);
		// Evidence is stable even when commands completed out of order.
		for (const result of cacheResults) if (result !== undefined) commands.push(result);
		const failedCacheBatches = cacheFailures
			.map((error, index) => error === undefined ? undefined : { error, index })
			.filter(Boolean);
		if (failedCacheBatches.length > 0) {
			throw new AggregateError(
				failedCacheBatches.map(failure => failure.error),
				`npm cache population failed for ${failedCacheBatches.map(failure => `batch ${failure.index + 1}`).join(", ")}`,
			);
		}
		await measured("cache verification", () => verifyDestinationArtifacts(
			selectedArtifacts,
			destinationContentCache,
			contentCache,
			remainingPreparationMs,
		));
		remainingPreparationMs("post-cache verification");

		const templateEnv = isolatedNpmEnv(templateDir, cacheDir, baseEnv);
		const installArgs = [
			...npm.argsPrefix,
			"ci",
			"--offline",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--cache", cacheDir,
		];
		const installCommand = await measured("offline template install", async () => {
			const result = await runCommand(npm.command, installArgs, {
				cwd: templateDir,
				env: templateEnv,
				...commandDeadline("offline npm ci", OFFLINE_INSTALL_TIMEOUT_MS),
				repoRoot,
			});
			commands.push(result);
			requireSuccess(result);
			return result;
		});

		const [templateLock, templateModules] = await Promise.all([
			stat(join(templateDir, "package-lock.json")).catch(() => undefined),
			stat(join(templateDir, "node_modules")).catch(() => undefined),
		]);
		if (!templateLock?.isFile() || !templateModules?.isDirectory()) {
			throw new Error("Offline packed-consumer template validation failed: package-lock.json or node_modules is missing");
		}

		const descriptor = {
			version: DESCRIPTOR_VERSION,
			runRoot: absoluteRunRoot,
			fixtureRoot,
			templateDir,
			consumersDir,
			tarballPath,
			cacheDir,
			descriptorPath,
			packageName,
			packEntry,
			packReport,
			commands,
			preparedAt: new Date().toISOString(),
		};
		const temporaryDescriptor = `${descriptorPath}.tmp-${process.pid}-${randomUUID()}`;
		await writeFile(temporaryDescriptor, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
		remainingPreparationMs("descriptor publication");
		await rename(temporaryDescriptor, descriptorPath);
		console.log(`[packed-consumer] descriptor: ${descriptorPath}`);
		return descriptor;
	} catch (error) {
		// The coordinator retains failed run roots. Keep this partial fixture too:
		// deleting it here used a second retry algorithm, could hide cleanup errors,
		// and discarded the exact npm command evidence needed to diagnose failures.
		await retainPreparationFailure({ fixtureRoot, commands, error });
	}
}

function assertMatchingPath(actual, expected, label) {
	if (resolve(actual) !== resolve(expected)) {
		throw new Error(`Prepared packed-consumer ${label} does not match the authoritative E2E run layout`);
	}
}

function validateDescriptor(descriptor, coordinatorRunRoot) {
	if (!coordinatorRunRoot) throw new Error("Prepared packed-consumer validation requires the authoritative coordinator run root");
	if (!descriptor || typeof descriptor !== "object" || descriptor.version !== DESCRIPTOR_VERSION) {
		throw new Error("Prepared packed-consumer descriptor has an unsupported format");
	}
	for (const key of ["runRoot", "fixtureRoot", "templateDir", "consumersDir", "tarballPath", "cacheDir", "descriptorPath", "packageName"]) {
		if (typeof descriptor[key] !== "string" || descriptor[key].length === 0) throw new Error(`Prepared packed-consumer descriptor is missing ${key}`);
	}
	if (!descriptor.packEntry || typeof descriptor.packEntry !== "object" || typeof descriptor.packEntry.filename !== "string" || descriptor.packEntry.filename.length === 0) {
		throw new Error("Prepared packed-consumer descriptor is missing packEntry.filename");
	}

	const runRoot = resolve(coordinatorRunRoot);
	assertMatchingPath(descriptor.runRoot, runRoot, "declared run root");
	for (const key of ["fixtureRoot", "templateDir", "consumersDir", "tarballPath", "cacheDir", "descriptorPath"]) {
		assertOwnedPath(runRoot, descriptor[key], key);
	}

	const fixtureRoot = join(runRoot, FIXTURE_DIRECTORY);
	assertMatchingPath(descriptor.fixtureRoot, fixtureRoot, "fixture root");
	assertMatchingPath(descriptor.templateDir, join(fixtureRoot, "preparation", "template"), "template path");
	assertMatchingPath(descriptor.consumersDir, join(fixtureRoot, "materialized"), "consumer root");
	assertMatchingPath(descriptor.cacheDir, join(fixtureRoot, "npm-cache"), "cache path");
	assertMatchingPath(descriptor.descriptorPath, join(fixtureRoot, "descriptor.json"), "descriptor path");
	const packRoot = join(fixtureRoot, "pack");
	assertOwnedPath(packRoot, descriptor.tarballPath, "tarballPath");
	assertMatchingPath(descriptor.tarballPath, join(packRoot, descriptor.packEntry.filename), "tarball path");
	return descriptor;
}

export async function readPreparedPackedConsumerDescriptor(descriptorPath, coordinatorRunRoot) {
	if (!coordinatorRunRoot) throw new Error("readPreparedPackedConsumerDescriptor requires the authoritative coordinator run root");
	const runRoot = resolve(coordinatorRunRoot);
	assertOwnedPath(runRoot, descriptorPath, "descriptorPath");
	assertMatchingPath(descriptorPath, join(runRoot, FIXTURE_DIRECTORY, "descriptor.json"), "input descriptor path");
	const parsed = JSON.parse(await readFile(descriptorPath, "utf8"));
	const descriptor = validateDescriptor(parsed, runRoot);
	assertMatchingPath(descriptor.descriptorPath, descriptorPath, "descriptor path");
	return descriptor;
}

/** Materialize the installed template into a unique, mutable, run-owned consumer. */
export async function materializePackedConsumerFixture(descriptor, {
	coordinatorRunRoot,
	name = "consumer",
	mode = "copy",
	copy = cp,
	move = rename,
} = {}) {
	const validated = validateDescriptor(descriptor, coordinatorRunRoot);
	if (mode !== "copy" && mode !== "consume") {
		throw new Error(`Unsupported packed-consumer materialization mode: ${mode}`);
	}
	const safeName = String(name).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "consumer";
	const consumerDir = join(validated.consumersDir, `${safeName}-${process.pid}-${randomUUID()}`);
	assertOwnedPath(resolve(coordinatorRunRoot), consumerDir, "consumerDir");
	await mkdir(validated.consumersDir, { recursive: true });
	if (mode === "consume") {
		// The template and destination have equal depth below the same run-owned
		// fixture root. Rename is therefore atomic and preserves ../../pack lock refs.
		await move(validated.templateDir, consumerDir);
	} else {
		await copy(validated.templateDir, consumerDir, { recursive: true, force: false, errorOnExist: true });
	}
	return { consumerDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	console.error("This module is prepared by scripts/testing-v2/run-e2e-v2.mjs; standalone cache prewarming was removed.");
	process.exitCode = 1;
}
