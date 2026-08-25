#!/usr/bin/env node

/**
 * Populate the inherited npm cache for the authoritative packed-consumer E2E.
 *
 * A lock-driven `npm ci` caches its exact artifacts, but a fresh consumer with
 * no lockfile also needs registry packuments and may select additional tarballs.
 * This preparation installs the real Bobbit tarball online once, with lifecycle
 * scripts disabled, into a disposable consumer. The E2E remains a distinct,
 * fresh, strict-offline install with its full publication assertions.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureDistBuild } from "./ensure-dist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PACK_TIMEOUT_MS = 3 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
export const OWNERSHIP_ESTABLISHMENT_TIMEOUT_MS = 10_000;
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
	if (!cli) {
		throw new Error(`Unable to locate npm's JavaScript CLI beside ${process.execPath}`);
	}
	return { command: process.execPath, argsPrefix: [cli] };
}

/**
 * Remove only npm-script/project state that could make the empty consumer
 * inherit Bobbit's package-lock=false or workspace/lifecycle configuration.
 * Cache, registry, authentication, proxy, certificate, and user config remain
 * inherited from the workflow environment.
 */
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
	// npm sets dependency lifecycle INIT_CWD from this value. Prewarm disables
	// scripts, but retaining normal consumer semantics prevents ambient leakage.
	env.INIT_CWD = cwd;
	return env;
}

async function defaultSpawnOwned(command, args, options) {
	// ensureDistBuild() runs before this path, so the built lifecycle primitive is
	// available without coupling injected unit tests to a pre-existing dist tree.
	const spawnTreeUrl = pathToFileURL(join(options.repoRoot, "dist", "server", "agent", "spawn-tree.js")).href;
	const { spawnTracked } = await import(spawnTreeUrl);
	return spawnTracked(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
}

/**
 * Run a shell-free command whose whole process tree is owned. The ownership
 * handshake has its own setup deadline and is joined before the execution
 * deadline starts. Timeout/overflow requests one final owned kill, and every
 * outcome requires verified tree completion before it can be returned or thrown.
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
} = {}) {
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
	let ownershipTimer;
	let executionTimer;

	const requestOwnedKill = (error) => {
		if (!terminalError) terminalError = error;
		if (killRequested) return;
		killRequested = true;
		tracked.killTree("SIGKILL");
	};
	const collect = (target, chunk) => {
		if (terminalError) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		outputBytes += buffer.byteLength;
		if (outputBytes > maxOutputBytes) {
			requestOwnedKill(new Error(`${rendered} exceeded the ${maxOutputBytes}-byte output limit`));
			return;
		}
		target.push(buffer);
	};
	const collectStdout = chunk => collect(stdout, chunk);
	const collectStderr = chunk => collect(stderr, chunk);
	child.stdout?.on("data", collectStdout);
	child.stderr?.on("data", collectStderr);

	let closeSettled = false;
	const closeResult = new Promise(resolveClose => {
		const finishClose = result => {
			if (closeSettled) return;
			closeSettled = true;
			child.off("error", onError);
			child.off("close", onClose);
			resolveClose(result);
		};
		const onError = error => finishClose({ spawnError: error, code: null, signal: null });
		const onClose = (code, signal) => finishClose({ code, signal });
		child.once("error", onError);
		child.once("close", onClose);
	});

	const ownershipTimeoutError = new Error(
		`${rendered} ownership readiness timed out after ${ownershipEstablishmentTimeoutMs}ms`,
	);
	try {
		await Promise.race([
			tracked.ownershipReady,
			new Promise((_, reject) => {
				ownershipTimer = setTimer(() => reject(ownershipTimeoutError), ownershipEstablishmentTimeoutMs);
			}),
		]);
	} catch (error) {
		requestOwnedKill(error === ownershipTimeoutError
			? ownershipTimeoutError
			: new Error(`${rendered} did not establish process-tree ownership`, { cause: error }));
	} finally {
		if (ownershipTimer !== undefined) clearTimer(ownershipTimer);
	}
	if (!terminalError) {
		executionTimer = setTimer(() => {
			requestOwnedKill(new Error(`${rendered} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	}

	const closed = await closeResult;
	child.stdout?.off("data", collectStdout);
	child.stderr?.off("data", collectStderr);
	if (executionTimer !== undefined) clearTimer(executionTimer);
	const treeExited = await tracked.waitForTreeExit(treeExitTimeoutMs);
	if (!treeExited) {
		throw new Error(`${rendered} closed without verified process-tree completion`, {
			cause: terminalError,
		});
	}

	const stdoutText = Buffer.concat(stdout).toString("utf8");
	const stderrText = Buffer.concat(stderr).toString("utf8");
	if (terminalError) {
		throw new Error(`${terminalError.message}\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`, { cause: terminalError });
	}
	if (closed.spawnError) {
		throw new Error(`Failed to spawn ${rendered}: ${closed.spawnError.message}`, { cause: closed.spawnError });
	}
	if (closed.signal || closed.code === null) {
		throw new Error(`${rendered} terminated without an exit code (signal: ${closed.signal ?? "unknown"})`);
	}
	return { command, args: [...args], code: closed.code, stdout: stdoutText, stderr: stderrText };
}

function requireSuccess(result) {
	if (result.code === 0) return;
	throw new Error(
		`${displayCommand(result.command, result.args)} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
}

function parsePackResult(stdout, expectedPackageName) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
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
	return entry.filename;
}

/** Build, pack, and online-install the real tarball solely to warm npm's cache. */
export async function prewarmPackedConsumerCache({
	repoRoot = REPO_ROOT,
	baseEnv = process.env,
	ensureDist = () => ensureDistBuild({ repoRoot }),
	runCommand = runOwnedCommand,
	resolveNpm = npmInvocation,
	tempParent = tmpdir(),
} = {}) {
	await ensureDist();
	const packageName = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).name;
	if (typeof packageName !== "string" || packageName.length === 0) throw new Error("package.json must declare a package name");
	const npm = resolveNpm(baseEnv);
	let tempRoot;
	try {
		tempRoot = await mkdtemp(join(tempParent, "bobbit-packed-cache-prewarm-"));
		const packDir = join(tempRoot, "pack");
		const consumerDir = join(tempRoot, "consumer");
		await mkdir(packDir);
		await mkdir(consumerDir);
		await writeFile(join(consumerDir, "package.json"), `${JSON.stringify({
			name: "bobbit-packed-cache-prewarm",
			version: "1.0.0",
			private: true,
		}, null, 2)}\n`);

		const packArgs = [...npm.argsPrefix, "pack", "--ignore-scripts", "--json", "--pack-destination", packDir];
		const packed = await runCommand(npm.command, packArgs, {
			cwd: repoRoot,
			env: baseEnv,
			timeoutMs: PACK_TIMEOUT_MS,
			repoRoot,
		});
		requireSuccess(packed);
		const filename = parsePackResult(packed.stdout, packageName);
		const tarballPath = resolve(packDir, filename);
		const tarball = await stat(tarballPath).catch(() => undefined);
		if (!tarball?.isFile()) throw new Error(`npm pack did not create ${tarballPath}`);

		const installArgs = [
			...npm.argsPrefix,
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			tarballPath,
		];
		const installed = await runCommand(npm.command, installArgs, {
			cwd: consumerDir,
			env: packedConsumerNpmEnv(consumerDir, baseEnv),
			timeoutMs: INSTALL_TIMEOUT_MS,
			repoRoot,
		});
		requireSuccess(installed);
		console.log(`[packed-cache-prewarm] cached dependencies selected by ${filename}`);
	} finally {
		if (tempRoot) {
			await rm(tempRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	prewarmPackedConsumerCache().catch(error => {
		console.error(error?.stack ?? error);
		process.exitCode = 1;
	});
}
