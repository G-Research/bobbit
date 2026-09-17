#!/usr/bin/env node

/**
 * Prepare the authoritative packed-consumer fixture once inside an E2E run.
 *
 * The coordinator packs Bobbit, resolves a lock-free external consumer into a
 * run-owned npm cache, installs the emitted tarball strictly offline into an
 * immutable template, and atomically publishes a descriptor. Browser workers
 * only copy that template; they never run npm pack/install themselves.
 */
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ensureDistBuild } from "./ensure-dist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PACK_TIMEOUT_MS = 3 * 60_000;
const LOCK_RESOLUTION_TIMEOUT_MS = 5 * 60_000;
const CACHE_BATCH_TIMEOUT_MS = 3 * 60_000;
const OFFLINE_INSTALL_TIMEOUT_MS = 10 * 60_000;
const CACHE_BATCH_SIZE = 32;
const DESCRIPTOR_VERSION = 1;
const FIXTURE_DIRECTORY = "prepared-packed-consumer";
export const PACKED_CONSUMER_DESCRIPTOR_ENV = "BOBBIT_PACKED_CONSUMER_DESCRIPTOR";
// Hosted Windows may spend more than 10 seconds establishing the Job-backed
// ownership handshake under concurrent runner load. This deadline covers only
// process-tree ownership setup; command execution retains its separate budget.
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
	// ensureDistBuild() runs before production preparation, so the built lifecycle
	// primitive is available without coupling injected unit tests to dist.
	const spawnTreeUrl = pathToFileURL(join(options.repoRoot, "dist", "server", "agent", "spawn-tree.js")).href;
	const { spawnTracked } = await import(spawnTreeUrl);
	return spawnTracked(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
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
	maxOutputBytes = MAX_OUTPUT_BYTES,
	ownershipEstablishmentTimeoutMs = OWNERSHIP_ESTABLISHMENT_TIMEOUT_MS,
	treeExitTimeoutMs = TREE_EXIT_TIMEOUT_MS,
	repoRoot = REPO_ROOT,
	spawnOwned = defaultSpawnOwned,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	setCompletionTimer = setTimeout,
	clearCompletionTimer = clearTimeout,
} = {}) {
	if (!cwd) throw new Error("cwd is required");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
	if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("maxOutputBytes must be a positive number");
	if (!Number.isFinite(ownershipEstablishmentTimeoutMs) || ownershipEstablishmentTimeoutMs <= 0) {
		throw new Error("ownershipEstablishmentTimeoutMs must be a positive number");
	}
	if (!Number.isFinite(treeExitTimeoutMs) || treeExitTimeoutMs <= 0) throw new Error("treeExitTimeoutMs must be a positive number");

	const rendered = displayCommand(command, args);
	const tracked = await spawnOwned(command, args, { cwd, env, repoRoot });
	const child = tracked.child;
	const stdout = [];
	const stderr = [];
	let outputBytes = 0;
	let terminalError;
	let killRequested = false;
	let killError;
	let ownershipState = "pending";
	let ownershipTimer;
	let executionTimer;
	let completionTimer;
	let resolveKillRequested;
	let resolveCompletionTimeout;
	const killRequestedResult = new Promise(resolveKill => { resolveKillRequested = resolveKill; });
	const completionTimeoutResult = new Promise(resolveTimeout => { resolveCompletionTimeout = resolveTimeout; });
	const treeExit = { attempted: false, settled: false, verified: false, error: undefined };
	let treeExitResult;

	const startTreeExitVerification = () => {
		if (treeExitResult) return treeExitResult;
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
		if (killRequested) return;
		killRequested = true;
		armCompletionTimeout();
		resolveKillRequested();
		try {
			tracked.killTree("SIGKILL");
		} catch (error) {
			killError = error instanceof Error ? error : new Error(String(error));
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
	child.stdout?.on("data", collectStdout);
	child.stderr?.on("data", collectStderr);

	let closeSettled = false;
	let resolveCloseResult;
	const closeResult = new Promise(resolveClose => { resolveCloseResult = resolveClose; });
	const finishClose = result => {
		if (closeSettled) return;
		closeSettled = true;
		child.off("error", onError);
		child.off("close", onClose);
		resolveCloseResult(result);
	};
	const onError = error => finishClose({ spawnError: error, code: null, signal: null });
	const onClose = (code, signal) => finishClose({ code, signal });
	child.once("error", onError);
	child.once("close", onClose);

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
		executionTimer = setTimer(() => requestOwnedKill(new Error(`${rendered} timed out after ${timeoutMs}ms`)), timeoutMs);
	}

	const closed = { observed: false, code: null, signal: null, spawnError: undefined };
	let outputDetached = false;
	const detachOutputListeners = () => {
		if (outputDetached) return;
		outputDetached = true;
		child.stdout?.off("data", collectStdout);
		child.stderr?.off("data", collectStderr);
	};
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
	});
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

	if (completionTimedOut || !closed.observed) {
		const terminalContext = terminalError ? `${terminalError.message}\n` : "";
		throw new Error(`${terminalContext}${rendered} did not complete its process-tree shutdown within ${treeExitTimeoutMs}ms\n${diagnostic}`, { cause: terminalError });
	}
	if (!treeExit.verified) {
		throw new Error(`${rendered} closed without verified process-tree completion\n${diagnostic}`, { cause: treeExit.error ?? terminalError });
	}
	if (terminalError) throw new Error(`${terminalError.message}\n${diagnostic}`, { cause: terminalError });
	if (closed.spawnError) throw new Error(`Failed to spawn ${rendered}: ${closed.spawnError.message}\n${diagnostic}`, { cause: closed.spawnError });
	if (closed.signal || closed.code === null) throw new Error(`${rendered} terminated without an exit code\n${diagnostic}`);
	return { command, args: [...args], code: closed.code, stdout: stdoutText, stderr: stderrText };
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

function compatibleRegistryTarballs(lock, {
	platform = process.platform,
	arch = process.arch,
	libc = runtimeLibc(platform),
} = {}) {
	const urls = new Set();
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
		urls.add(resolved);
	}
	return urls;
}

export function lockedTarballsMissingFromRepository(consumerLock, repositoryLock, runtime = {}) {
	const required = compatibleRegistryTarballs(consumerLock, runtime);
	const alreadyCached = compatibleRegistryTarballs(repositoryLock, runtime);
	return [...required].filter(url => !alreadyCached.has(url)).sort();
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
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
		...(cause === undefined ? {} : {
			cause: cause instanceof Error
				? { name: cause.name, message: cause.message, stack: cause.stack }
				: { message: String(cause) },
		}),
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

/**
 * Build one immutable packed-consumer template and publish its descriptor only
 * after the actual tarball, lockfile, and installed dependency tree exist.
 */
export async function preparePackedConsumerFixture({
	repoRoot = REPO_ROOT,
	runRoot,
	baseEnv = process.env,
	ensureDist = () => ensureDistBuild({ repoRoot }),
	runCommand = runOwnedCommand,
	resolveNpm = npmInvocation,
	runtime,
} = {}) {
	if (!runRoot) throw new Error("preparePackedConsumerFixture requires runRoot");
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

	await measured("build", () => ensureDist());
	const packageManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const packageName = packageManifest.name;
	if (typeof packageName !== "string" || packageName.length === 0) throw new Error("package.json must declare a package name");
	const repositoryLock = readPackageLock(join(repoRoot, "package-lock.json"), "repository package-lock.json");
	const nodeTypesVersion = repositoryLock.packages?.["node_modules/@types/node"]?.version;
	const npm = resolveNpm(baseEnv);
	const commands = [];

	try {
		await Promise.all([
			mkdir(packDir, { recursive: true }),
			mkdir(resolverDir, { recursive: true }),
			mkdir(templateDir, { recursive: true }),
			mkdir(cacheDir, { recursive: true }),
			mkdir(consumersDir, { recursive: true }),
		]);
		const consumerManifest = cleanConsumerManifest(nodeTypesVersion);
		await Promise.all([writeManifest(resolverDir, consumerManifest), writeManifest(templateDir, consumerManifest)]);

		const packArgs = [...npm.argsPrefix, "pack", "--ignore-scripts", "--json", "--pack-destination", packDir];
		const packCommand = await measured("pack", async () => {
			const result = await runCommand(npm.command, packArgs, { cwd: repoRoot, env: baseEnv, timeoutMs: PACK_TIMEOUT_MS, repoRoot });
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
				timeoutMs: LOCK_RESOLUTION_TIMEOUT_MS,
				repoRoot,
			});
			commands.push(result);
			requireSuccess(result);
			return result;
		});
		const consumerLock = readPackageLock(join(resolverDir, "package-lock.json"), "generated consumer package-lock.json");
		const selectedTarballs = [...compatibleRegistryTarballs(consumerLock, runtime)].sort();
		console.log(`[packed-consumer] cache: populating ${selectedTarballs.length} compatible dependency tarballs`);
		for (let offset = 0; offset < selectedTarballs.length; offset += CACHE_BATCH_SIZE) {
			const batch = selectedTarballs.slice(offset, offset + CACHE_BATCH_SIZE);
			const result = await measured(`cache batch ${Math.floor(offset / CACHE_BATCH_SIZE) + 1}/${Math.ceil(selectedTarballs.length / CACHE_BATCH_SIZE)}`, () =>
				runCommand(npm.command, [...npm.argsPrefix, "cache", "add", "--cache", cacheDir, ...batch], {
					cwd: resolverDir,
					env: resolverEnv,
					timeoutMs: CACHE_BATCH_TIMEOUT_MS,
					repoRoot,
				}),
			);
			commands.push(result);
			requireSuccess(result);
		}

		const templateEnv = isolatedNpmEnv(templateDir, cacheDir, baseEnv);
		const installArgs = [
			...npm.argsPrefix,
			"install",
			"--offline",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--cache", cacheDir,
			tarballPath,
		];
		const installCommand = await measured("offline template install", async () => {
			const result = await runCommand(npm.command, installArgs, {
				cwd: templateDir,
				env: templateEnv,
				timeoutMs: OFFLINE_INSTALL_TIMEOUT_MS,
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

/** Copy the installed template into a unique, mutable, run-owned consumer. */
export async function materializePackedConsumerFixture(descriptor, {
	coordinatorRunRoot,
	name = "consumer",
	copy = cp,
} = {}) {
	const validated = validateDescriptor(descriptor, coordinatorRunRoot);
	const safeName = String(name).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "consumer";
	const consumerDir = join(validated.consumersDir, `${safeName}-${process.pid}-${randomUUID()}`);
	assertOwnedPath(resolve(coordinatorRunRoot), consumerDir, "consumerDir");
	await mkdir(validated.consumersDir, { recursive: true });
	await copy(validated.templateDir, consumerDir, { recursive: true, force: false, errorOnExist: true });
	return { consumerDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	console.error("This module is prepared by scripts/testing-v2/run-e2e-v2.mjs; standalone cache prewarming was removed.");
	process.exitCode = 1;
}
