#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const CHILD_ENV_PASSTHROUGH = [
	// Executable lookup and Windows process startup essentials.
	"PATH",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	// Locale-only process settings.
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	// Public-network routing and trust settings. Auth and registry settings are
	// deliberately not inherited; the public registry is pinned below.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NPM_CONFIG_PROXY",
	"NPM_CONFIG_HTTPS_PROXY",
	"NPM_CONFIG_NOPROXY",
	"NPM_CONFIG_STRICT_SSL",
	"NPM_CONFIG_CAFILE",
	"NPM_CONFIG_CA",
];

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function excerpt(value, limit = 8_000) {
	const text = String(value ?? "").trim();
	if (text.length <= limit) return text;
	return `[...${text.length - limit} characters omitted...]\n${text.slice(-limit)}`;
}

function displayCommand(command, args) {
	return [command, ...args]
		.map(value => /\s/.test(value) ? JSON.stringify(value) : value)
		.join(" ");
}

function terminateProcessTree(child) {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
}

function runCommand(command, args, { cwd, env, timeoutMs }) {
	if (!env || typeof env !== "object") {
		throw new Error(`Refusing to spawn ${command} without an explicit restricted environment`);
	}
	const rendered = displayCommand(command, args);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout = [];
		const stderr = [];
		let outputBytes = 0;
		let terminalError;
		let settled = false;

		const failAndTerminate = message => {
			if (terminalError) return;
			terminalError = new Error(message);
			terminateProcessTree(child);
		};
		const collect = (target, chunk) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			outputBytes += buffer.byteLength;
			if (outputBytes > MAX_OUTPUT_BYTES) {
				failAndTerminate(`${rendered} exceeded the ${MAX_OUTPUT_BYTES}-byte output limit`);
				return;
			}
			target.push(buffer);
		};

		child.stdout?.on("data", chunk => collect(stdout, chunk));
		child.stderr?.on("data", chunk => collect(stderr, chunk));

		const timer = setTimeout(() => {
			failAndTerminate(`${rendered} timed out after ${timeoutMs}ms`);
		}, timeoutMs);

		child.once("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Failed to spawn ${rendered}: ${error.message}`, { cause: error }));
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const stdoutText = Buffer.concat(stdout).toString("utf8");
			const stderrText = Buffer.concat(stderr).toString("utf8");
			if (terminalError) {
				reject(new Error(
					`${terminalError.message}\nstdout:\n${excerpt(stdoutText)}\nstderr:\n${excerpt(stderrText)}`,
					{ cause: terminalError },
				));
				return;
			}
			if (signal || code === null) {
				reject(new Error(`${rendered} terminated without an exit code (signal: ${signal ?? "unknown"})`));
				return;
			}
			resolvePromise({ code, stdout: stdoutText, stderr: stderrText, rendered });
		});
	});
}

function npmInvocation(args) {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath && existsSync(npmExecPath)) {
		return { command: process.execPath, args: [npmExecPath, ...args] };
	}
	if (process.platform === "win32") {
		const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
		if (existsSync(npmCli)) return { command: process.execPath, args: [npmCli, ...args] };
		throw new Error("Cannot locate npm without a shell. Run this audit through `npm run audit:packed-consumer`.");
	}
	return { command: "npm", args };
}

function runNpm(args, options) {
	const invocation = npmInvocation(args);
	return runCommand(invocation.command, invocation.args, options);
}

function inheritedEnvValue(sourceEnv, expectedKey) {
	const expected = expectedKey.toLowerCase();
	for (const [key, value] of Object.entries(sourceEnv)) {
		if (key.toLowerCase() === expected && typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

export function buildRestrictedNpmEnv(sourceEnv, paths) {
	const env = {};
	for (const key of CHILD_ENV_PASSTHROUGH) {
		const value = inheritedEnvValue(sourceEnv, key);
		if (value !== undefined) env[key] = value;
	}

	Object.assign(env, {
		HOME: paths.homeDir,
		USERPROFILE: paths.homeDir,
		APPDATA: paths.appDataDir,
		LOCALAPPDATA: paths.localAppDataDir,
		XDG_CONFIG_HOME: paths.xdgConfigDir,
		XDG_CACHE_HOME: paths.cacheDir,
		TMPDIR: paths.tempDir,
		TMP: paths.tempDir,
		TEMP: paths.tempDir,
		npm_config_userconfig: paths.userConfigPath,
		npm_config_globalconfig: paths.globalConfigPath,
		npm_config_cache: paths.cacheDir,
		npm_config_registry: PUBLIC_NPM_REGISTRY,
		npm_config_ignore_scripts: "true",
		npm_config_update_notifier: "false",
		npm_config_fund: "false",
	});
	return env;
}

async function prepareRestrictedNpmEnv(tempRoot) {
	const homeDir = join(tempRoot, "home");
	const cacheDir = join(tempRoot, "cache");
	const tempDir = join(tempRoot, "tmp");
	const configDir = join(tempRoot, "config");
	const appDataDir = join(homeDir, "AppData", "Roaming");
	const localAppDataDir = join(homeDir, "AppData", "Local");
	const xdgConfigDir = join(homeDir, ".config");
	const userConfigPath = join(configDir, "user.npmrc");
	const globalConfigPath = join(configDir, "global.npmrc");
	await Promise.all([
		mkdir(homeDir, { recursive: true }),
		mkdir(cacheDir, { recursive: true }),
		mkdir(tempDir, { recursive: true }),
		mkdir(configDir, { recursive: true }),
		mkdir(appDataDir, { recursive: true }),
		mkdir(localAppDataDir, { recursive: true }),
		mkdir(xdgConfigDir, { recursive: true }),
	]);
	await Promise.all([
		writeFile(userConfigPath, "\n", { mode: 0o600 }),
		writeFile(globalConfigPath, "\n", { mode: 0o600 }),
	]);
	return buildRestrictedNpmEnv(process.env, {
		homeDir,
		cacheDir,
		tempDir,
		appDataDir,
		localAppDataDir,
		xdgConfigDir,
		userConfigPath,
		globalConfigPath,
	});
}

export function packedConsumerPackArgs(packDir) {
	return ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir, REPO_ROOT];
}

export function packedConsumerInstallArgs(tarballPath) {
	return ["install", "--ignore-scripts", tarballPath];
}

/** Enable lifecycle scripts only for the one native dependency after isolated install. */
export function packedConsumerNativeRebuildArgs() {
	return ["rebuild", "better-sqlite3", "--foreground-scripts"];
}

function requireSuccess(label, result) {
	if (result.code === 0) return;
	throw new Error(
		`${label} failed with exit code ${result.code}: ${result.rendered}`
		+ `\nstdout:\n${excerpt(result.stdout)}\nstderr:\n${excerpt(result.stderr)}`,
	);
}

export function parseAuditJson(stdout) {
	if (typeof stdout !== "string" || stdout.trim() === "") {
		throw new Error("npm audit emitted no JSON on stdout");
	}
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`npm audit emitted malformed JSON: ${error.message}\nstdout:\n${excerpt(stdout)}`, { cause: error });
	}
	if (!isRecord(parsed)) throw new Error("npm audit JSON root must be an object");
	return parsed;
}

function printable(value, fallback = "unknown") {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

export function formatAuditFindings(report) {
	const lines = [];
	if (report.error !== undefined) {
		if (isRecord(report.error)) {
			lines.push(`npm audit error: ${printable(report.error.summary, printable(report.error.code))}`);
			if (typeof report.error.detail === "string" && report.error.detail.trim()) {
				lines.push(`  ${report.error.detail.trim()}`);
			}
		} else {
			lines.push(`npm audit returned a malformed error: ${JSON.stringify(report.error)}`);
		}
	}
	if (!isRecord(report.vulnerabilities)) return lines;

	for (const [packageName, rawFinding] of Object.entries(report.vulnerabilities)) {
		if (!isRecord(rawFinding)) {
			lines.push(`- ${packageName}: malformed vulnerability entry ${JSON.stringify(rawFinding)}`);
			continue;
		}
		const nodes = Array.isArray(rawFinding.nodes)
			? rawFinding.nodes.map(node => String(node)).join(", ")
			: "unknown path";
		lines.push(
			`- ${packageName}: severity=${printable(rawFinding.severity)}, range=${printable(rawFinding.range)}, paths=${nodes}`,
		);
		if (!Array.isArray(rawFinding.via)) continue;
		for (const rawAdvisory of rawFinding.via) {
			if (typeof rawAdvisory === "string") {
				lines.push(`  - via dependency ${rawAdvisory}`);
				continue;
			}
			if (!isRecord(rawAdvisory)) {
				lines.push(`  - malformed advisory ${JSON.stringify(rawAdvisory)}`);
				continue;
			}
			const advisoryId = printable(rawAdvisory.source, printable(rawAdvisory.name, "unidentified advisory"));
			const title = printable(rawAdvisory.title, "untitled advisory");
			const url = printable(rawAdvisory.url, "no advisory URL");
			lines.push(
				`  - ${advisoryId}: ${title}; severity=${printable(rawAdvisory.severity)}, range=${printable(rawAdvisory.range)}; ${url}`,
			);
		}
	}
	return lines;
}

export function evaluatePackedConsumerAudit(report, exitCode) {
	const diagnostics = [];
	const counts = {};
	if (!Number.isInteger(report.auditReportVersion) || report.auditReportVersion < 1) {
		diagnostics.push(`npm audit reported an invalid schema version: ${JSON.stringify(report.auditReportVersion)}`);
	}
	const metadata = isRecord(report.metadata) ? report.metadata : undefined;
	const vulnerabilityCounts = metadata && isRecord(metadata.vulnerabilities)
		? metadata.vulnerabilities
		: undefined;

	if (!vulnerabilityCounts) {
		diagnostics.push("npm audit JSON is missing metadata.vulnerabilities");
	} else {
		for (const severity of AUDIT_SEVERITIES) {
			const count = vulnerabilityCounts[severity];
			counts[severity] = count;
			if (!Number.isInteger(count) || count < 0) {
				diagnostics.push(`npm audit reported an invalid ${severity} vulnerability count: ${JSON.stringify(count)}`);
			} else if (count !== 0) {
				diagnostics.push(`npm audit reported ${count} ${severity} vulnerabilit${count === 1 ? "y" : "ies"}`);
			}
		}
		const total = vulnerabilityCounts.total;
		counts.total = total;
		if (!Number.isInteger(total) || total < 0) {
			diagnostics.push(`npm audit reported an invalid total vulnerability count: ${JSON.stringify(total)}`);
		} else if (total !== 0) {
			diagnostics.push(`npm audit reported ${total} total vulnerabilities`);
		}
	}

	const vulnerabilityEntries = isRecord(report.vulnerabilities)
		? Object.keys(report.vulnerabilities)
		: undefined;
	if (!vulnerabilityEntries) {
		diagnostics.push("npm audit JSON is missing the vulnerabilities object");
	}
	if ((vulnerabilityEntries && vulnerabilityEntries.length > 0) || report.error !== undefined) {
		diagnostics.push(...formatAuditFindings(report));
	}
	if (!Number.isInteger(exitCode) || exitCode !== 0) {
		diagnostics.push(`npm audit exited with code ${JSON.stringify(exitCode)}; an audit-clean consumer must exit 0`);
	}

	return { clean: diagnostics.length === 0, counts, diagnostics };
}

function parsePackedTarball(stdout, packDir) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`npm pack emitted malformed JSON: ${error.message}\nstdout:\n${excerpt(stdout)}`, { cause: error });
	}
	if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0]) || typeof parsed[0].filename !== "string") {
		throw new Error(`npm pack must report one tarball with a filename; received:\n${excerpt(stdout)}`);
	}
	const tarballPath = resolve(packDir, parsed[0].filename);
	const fromPackDir = relative(packDir, tarballPath);
	if (fromPackDir === "" || fromPackDir.startsWith("..") || isAbsolute(fromPackDir)) {
		throw new Error(`npm pack reported a filename outside its destination: ${JSON.stringify(parsed[0].filename)}`);
	}
	return tarballPath;
}

async function performPackedConsumerAudit(tempRoot, npmRunner, commandRunner) {
	const packDir = join(tempRoot, "pack");
	const consumerDir = join(tempRoot, "consumer");
	await mkdir(packDir, { recursive: true });
	await mkdir(consumerDir, { recursive: true });
	await writeFile(join(consumerDir, "package.json"), `${JSON.stringify({
		name: "bobbit-release-audit-consumer",
		version: "1.0.0",
		private: true,
	}, null, 2)}\n`);
	const restrictedNpmEnv = await prepareRestrictedNpmEnv(tempRoot);

	console.log("[audit:packed-consumer] Packing the built Bobbit package...");
	const packed = await npmRunner(packedConsumerPackArgs(packDir), {
		// Invoking from the empty temporary root prevents repository .npmrc
		// settings from becoming project configuration for this npm process.
		cwd: tempRoot,
		env: restrictedNpmEnv,
		timeoutMs: 3 * 60_000,
	});
	requireSuccess("npm pack", packed);
	const tarballPath = parsePackedTarball(packed.stdout, packDir);
	await stat(tarballPath);

	const lockConfig = await npmRunner(["config", "get", "package-lock"], {
		cwd: consumerDir,
		env: restrictedNpmEnv,
		timeoutMs: 30_000,
	});
	requireSuccess("npm config get package-lock", lockConfig);
	if (lockConfig.stdout.trim() !== "true") {
		throw new Error(
			"The clean consumer is not using npm's normal package-lock=true setting. "
			+ `Received ${JSON.stringify(lockConfig.stdout.trim())}; check user npm configuration.`,
		);
	}

	console.log("[audit:packed-consumer] Installing the tarball into a clean private consumer...");
	const installed = await npmRunner(packedConsumerInstallArgs(tarballPath), {
		cwd: consumerDir,
		env: restrictedNpmEnv,
		timeoutMs: 10 * 60_000,
	});
	requireSuccess("clean consumer install", installed);
	await stat(join(consumerDir, "package-lock.json"));

	console.log("[audit:packed-consumer] Installing the packaged SQLite native binding...");
	const rebuiltNative = await npmRunner(packedConsumerNativeRebuildArgs(), {
		cwd: consumerDir,
		env: { ...restrictedNpmEnv, npm_config_ignore_scripts: "false" },
		timeoutMs: 5 * 60_000,
	});
	requireSuccess("packed SQLite native rebuild", rebuiltNative);

	console.log("[audit:packed-consumer] Loading the packaged SQLite native binding...");
	const sqliteSmoke = await commandRunner(process.execPath, ["-e", `
		const { createRequire } = require("node:module");
		const fromBobbit = createRequire(require.resolve("@gresearch/bobbit/package.json"));
		const Database = fromBobbit("better-sqlite3");
		const db = new Database(":memory:");
		db.exec("CREATE TABLE smoke(value TEXT NOT NULL)");
		db.prepare("INSERT INTO smoke(value) VALUES (?)").run("ok");
		if (db.prepare("SELECT value FROM smoke").get()?.value !== "ok") process.exit(2);
		db.close();

		const assert = require("node:assert/strict");
		const { existsSync, mkdtempSync, rmSync } = require("node:fs");
		const { tmpdir } = require("node:os");
		const { dirname, join } = require("node:path");
		const { pathToFileURL } = require("node:url");
		(async () => {
			const packageDir = dirname(require.resolve("@gresearch/bobbit/package.json"));
			const { GoalStore } = await import(pathToFileURL(join(packageDir, "dist", "server", "agent", "goal-store.js")).href);
			const { TaskStore } = await import(pathToFileURL(join(packageDir, "dist", "server", "agent", "task-store.js")).href);
			const root = mkdtempSync(join(tmpdir(), "bobbit-packed-store-smoke-"));
			const stateDir = join(root, "state");
			const expectedGoal = {
				id: "packed-goal",
				title: "Packed SQLite goal ✓",
				cwd: root,
				state: "in-progress",
				spec: "Round-trip the installed GoalStore payload.",
				createdAt: 1700000000000,
				updatedAt: 1700000000001,
				setupStatus: "ready",
				metadata: { source: "packed-consumer", unicode: "雪" },
				packedExtension: { nested: ["preserved", 7] },
			};
			const expectedTask = {
				id: "packed-task",
				goalId: expectedGoal.id,
				title: "Packed SQLite task ✓",
				type: "testing",
				state: "todo",
				spec: "Round-trip the installed TaskStore payload.",
				createdAt: 1700000000010,
				updatedAt: 1700000000011,
				dependsOn: [],
				gitHandoff: { api: { baseSha: "base", headSha: "head", branch: "test/packed" } },
				packedExtension: { nested: { unicode: "λ" } },
			};
			let goals;
			let tasks;
			let reloadedGoals;
			let reloadedTasks;
			try {
				goals = new GoalStore(stateDir);
				tasks = new TaskStore(stateDir);
				goals.put(expectedGoal);
				tasks.put(expectedTask);
				await Promise.all([goals.close(), tasks.close()]);
				assert.equal(existsSync(join(stateDir, "goals.sqlite")), true);
				assert.equal(existsSync(join(stateDir, "tasks.sqlite")), true);
				reloadedGoals = new GoalStore(stateDir);
				reloadedTasks = new TaskStore(stateDir);
				assert.deepEqual(reloadedGoals.get(expectedGoal.id), expectedGoal);
				assert.deepEqual(reloadedTasks.get(expectedTask.id), expectedTask);
				await Promise.all([reloadedGoals.close(), reloadedTasks.close()]);
			} finally {
				await Promise.allSettled([goals, tasks, reloadedGoals, reloadedTasks]
					.filter(Boolean)
					.map(store => store.close()));
				rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
				assert.equal(existsSync(root), false, "native stores must release handles before cleanup");
			}
		})().catch(error => {
			console.error(error);
			process.exitCode = 3;
		});
	`], {
		cwd: consumerDir,
		env: restrictedNpmEnv,
		timeoutMs: 30_000,
	});
	requireSuccess("packed SQLite native binding and store smoke", sqliteSmoke);

	console.log("[audit:packed-consumer] Querying the registry advisory service...");
	const audited = await npmRunner(["audit", "--omit=dev", "--json"], {
		cwd: consumerDir,
		env: restrictedNpmEnv,
		timeoutMs: 3 * 60_000,
	});
	// npm intentionally exits nonzero for vulnerability findings. Always parse
	// stdout first so those exits retain package, path, and advisory evidence.
	const report = parseAuditJson(audited.stdout);
	const evaluation = evaluatePackedConsumerAudit(report, audited.code);
	if (!evaluation.clean) {
		const stderr = audited.stderr.trim() ? `\nnpm audit stderr:\n${excerpt(audited.stderr)}` : "";
		throw new Error(
			"Packed consumer audit is not clean; publishing is blocked.\n"
			+ evaluation.diagnostics.join("\n")
			+ stderr,
		);
	}
	console.log("[audit:packed-consumer] PASS: the freshly installed consumer reports zero runtime vulnerabilities.");
}

/**
 * Allocates the audit beneath the coordinator's canonical run root when one is
 * supplied. The returned prefix is for an owned mkdtemp child, never the
 * coordinator root itself.
 */
export function packedConsumerTempPrefix(env = process.env, tempDirectory = tmpdir()) {
	const suppliedRoot = env.BOBBIT_V2_RUN_ROOT?.trim();
	const parent = suppliedRoot ? realpathSync(suppliedRoot) : tempDirectory;
	return join(parent, "bobbit-release-packed-audit-");
}

export async function runPackedConsumerAudit({ npmRunner = runNpm, commandRunner = runCommand } = {}) {
	const tempRoot = await mkdtemp(packedConsumerTempPrefix());
	let operationError;
	try {
		await performPackedConsumerAudit(tempRoot, npmRunner, commandRunner);
	} catch (error) {
		operationError = error;
	}

	let cleanupError;
	try {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch (error) {
		cleanupError = error;
	}
	if (operationError && cleanupError) {
		throw new AggregateError(
			[operationError, cleanupError],
			`Packed consumer audit failed: ${String(operationError)}\nTemporary cleanup also failed for ${tempRoot}: ${String(cleanupError)}`,
		);
	}
	if (operationError) throw operationError;
	if (cleanupError) {
		throw new Error(`Packed consumer audit passed, but temporary cleanup failed for ${tempRoot}`, { cause: cleanupError });
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	runPackedConsumerAudit().catch(error => {
		console.error(`[audit:packed-consumer] FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
