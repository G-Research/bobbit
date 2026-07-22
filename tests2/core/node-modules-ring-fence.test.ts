import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as rpcBridgeModule from "../../src/server/agent/rpc-bridge.js";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import * as harnessDepsModule from "../../src/server/harness-deps.js";

const POLICY_PREFIX = "NFS_STARTUP_POLICY";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const tempRoots: string[] = [];
const rpcExports = rpcBridgeModule as Record<string, unknown>;
const harnessExports = harnessDepsModule as Record<string, unknown>;
const resolverNames = ["resolveDirectHostPiRuntime", "resolveDirectHostAgentRuntime"];
const validatorNames = ["validateDependencies", "validateHarnessDependencies"];
const lifecycleNames = ["runHarnessLifecycle", "runHarnessLifecyclePhase", "applyHarnessLifecyclePolicy"];
const hasFunction = (module: Record<string, unknown>, names: string[]): boolean => names.some(name => typeof module[name] === "function");
const desiredContractAvailable = hasFunction(rpcExports, resolverNames)
	&& hasFunction(harnessExports, validatorNames)
	&& hasFunction(harnessExports, lifecycleNames)
	&& harnessExports.healDependencies === undefined;

type AnyFunction = (...args: any[]) => any;
type ValidationResult =
	| { ok: true }
	| { ok: false; message: string; missing?: string[]; diagnostics?: string[] };
type LifecycleTrigger = "initial" | "sentinel-restart" | "crash-relaunch";

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf-8");
}

function writePackage(modulesDir: string, packageName: string): void {
	writeJson(path.join(modulesDir, packageName, "package.json"), {
		name: packageName,
		version: "0.0.0-test",
	});
}

function requireExport(module: Record<string, unknown>, names: string[], label: string): AnyFunction {
	for (const name of names) {
		if (typeof module[name] === "function") return module[name] as AnyFunction;
	}
	throw new Error(`${POLICY_PREFIX}_${label}: expected an exported ${names.join(" or ")} test seam`);
}

function directRuntimeResolver(): AnyFunction {
	return requireExport(rpcExports, resolverNames, "RESOLVER_CONTRACT");
}

function dependencyValidator(): AnyFunction {
	return requireExport(harnessExports, validatorNames, "VALIDATOR_CONTRACT");
}

function lifecycleRunner(): AnyFunction {
	return requireExport(harnessExports, lifecycleNames, "LIFECYCLE_CONTRACT");
}

function dependencyValidationCli(): AnyFunction {
	return requireExport(harnessExports, ["runDependencyValidationCli"], "VALIDATION_CLI_CONTRACT");
}

function validationText(result: ValidationResult): string {
	if (result.ok) return "";
	return [result.message, ...(result.diagnostics ?? [])].filter(Boolean).join("\n");
}

function expectManualRecovery(result: ValidationResult, cause: RegExp): void {
	expect(result.ok, `${POLICY_PREFIX}_VALIDATION_FAILURE: fixture must be rejected`).toBe(false);
	const text = validationText(result);
	expect(text, `${POLICY_PREFIX}_VALIDATION_CAUSE: diagnostics must identify the validation failure`).toMatch(cause);
	expect(text, `${POLICY_PREFIX}_MANUAL_RECOVERY: diagnostics must tell the operator to stop Bobbit/the dev stack`).toMatch(/stop\s+(?:bobbit|the\s+.+(?:stack|harness))/i);
	expect(text, `${POLICY_PREFIX}_MANUAL_RECOVERY: diagnostics must require a manual npm install`).toMatch(/npm\s+install/i);
	expect(text, `${POLICY_PREFIX}_MANUAL_RECOVERY: diagnostics must tell the operator to retry or restart`).toMatch(/retry|restart/i);
}

function statIdentity(file: string): Record<string, number> {
	const stat = fs.statSync(file);
	return {
		size: stat.size,
		mode: stat.mode,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		birthtimeMs: stat.birthtimeMs,
		ino: stat.ino,
	};
}

function pathIsWithin(candidate: unknown, root: string): boolean {
	if (typeof candidate !== "string") return false;
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function observeLegacyRuntimeAccess(runtimeDir: string): { accesses: string[]; restore: () => void } {
	const accesses: string[] = [];
	const methods = [
		"accessSync",
		"appendFileSync",
		"chmodSync",
		"copyFileSync",
		"cpSync",
		"existsSync",
		"linkSync",
		"lstatSync",
		"mkdirSync",
		"openSync",
		"opendirSync",
		"readFileSync",
		"readdirSync",
		"readlinkSync",
		"realpathSync",
		"renameSync",
		"rmSync",
		"rmdirSync",
		"statSync",
		"symlinkSync",
		"truncateSync",
		"unlinkSync",
		"writeFileSync",
	] as const;

	for (const method of methods) {
		const original = (fs as any)[method];
		if (typeof original !== "function") continue;
		vi.spyOn(fs as any, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
			if (args.some(arg => pathIsWithin(arg, runtimeDir))) accesses.push(`${method}:${String(args[0])}`);
			return original.apply(this, args);
		});
	}
	return { accesses, restore: () => vi.restoreAllMocks() };
}

function makeStableRpcChild(): childProcess.ChildProcess {
	const child = new EventEmitter() as childProcess.ChildProcess;
	Object.assign(child, {
		pid: 123,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: () => true,
	});
	return child;
}

const immediateClock = {
	now: () => 0,
	setTimeout: (handler: () => void) => {
		queueMicrotask(handler);
		return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
	},
	setInterval: () => 0 as unknown as ReturnType<typeof globalThis.setInterval>,
	clearTimeout: () => undefined,
	clearInterval: () => undefined,
};

function trapMutationAndSubprocesses(): { writes: string[]; commands: string[]; restore: () => void } {
	const writes: string[] = [];
	const commands: string[] = [];
	for (const method of [
		"appendFileSync",
		"chmodSync",
		"copyFileSync",
		"cpSync",
		"linkSync",
		"mkdirSync",
		"renameSync",
		"rmSync",
		"rmdirSync",
		"symlinkSync",
		"truncateSync",
		"unlinkSync",
		"writeFileSync",
	] as const) {
		if (typeof (fs as any)[method] !== "function") continue;
		vi.spyOn(fs as any, method).mockImplementation((...args: unknown[]) => {
			writes.push(`${method}:${String(args[0])}`);
			throw new Error(`${POLICY_PREFIX}_VALIDATOR_WRITE_ATTEMPT: ${method}`);
		});
	}
	for (const method of ["exec", "execFile", "execFileSync", "execSync", "spawn", "spawnSync"] as const) {
		vi.spyOn(childProcess as any, method).mockImplementation((...args: unknown[]) => {
			commands.push(`${method}:${String(args[0])}`);
			throw new Error(`${POLICY_PREFIX}_PACKAGE_MANAGER_ATTEMPT: ${method}`);
		});
	}
	return { writes, commands, restore: () => vi.restoreAllMocks() };
}

interface LifecycleCounters {
	validate: number;
	repair: number;
	build: number;
	launch: number;
	reports: string[];
	exitCodes: number[];
	alive: boolean;
}

function lifecycleFixture(validate: () => ValidationResult | Promise<ValidationResult>): {
	counters: LifecycleCounters;
	deps: Record<string, unknown>;
} {
	const counters: LifecycleCounters = {
		validate: 0,
		repair: 0,
		build: 0,
		launch: 0,
		reports: [],
		exitCodes: [],
		alive: true,
	};
	const repair = () => {
		counters.repair++;
		throw new Error(`${POLICY_PREFIX}_AUTOMATIC_REPAIR_CALLED`);
	};
	return {
		counters,
		deps: {
			validate: async () => {
				counters.validate++;
				return validate();
			},
			build: async () => { counters.build++; },
			launch: () => { counters.launch++; },
			report: (message: string) => { counters.reports.push(message); },
			exit: (code: number) => {
				counters.exitCodes.push(code);
				counters.alive = false;
			},
			// Deliberately supplied as extra traps. The policy must expose/use no
			// repair or package-manager path, even if a caller passes one dynamically.
			repair,
			runCommand: repair,
			runPackageManager: repair,
		},
	};
}

async function runLifecycle(trigger: LifecycleTrigger, deps: Record<string, unknown>): Promise<void> {
	await Promise.resolve(lifecycleRunner()(trigger, deps));
}

const healthy: ValidationResult = { ok: true };
const unhealthy: ValidationResult = {
	ok: false,
	message: "Missing dependency missing-pkg. Stop Bobbit/dev stack, run npm install manually, then retry/restart.",
	missing: ["missing-pkg"],
};

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("NFS startup policy reproducing contract", () => {
	it("retires automatic repair and exposes the read-only resolution, validation, and lifecycle seams", () => {
		expect(
			harnessExports.healDependencies,
			`${POLICY_PREFIX}_AUTOMATIC_REPAIR_RETIRED: harness-deps must not export healDependencies or invoke npm/package-manager repair`,
		).toBeUndefined();
		expect(harnessExports.DependencyHealError).toBeUndefined();
		expect(hasFunction(rpcExports, resolverNames), `${POLICY_PREFIX}_RESOLVER_CONTRACT`).toBe(true);
		expect(hasFunction(harnessExports, validatorNames), `${POLICY_PREFIX}_VALIDATOR_CONTRACT`).toBe(true);
		expect(hasFunction(harnessExports, lifecycleNames), `${POLICY_PREFIX}_LIFECYCLE_CONTRACT`).toBe(true);
	});
});

describe.skipIf(!desiredContractAvailable)("direct-host Pi resolution without a runtime snapshot", () => {
	it("resolves the installed Pi entry, node_modules root, and CLI through the Node-compatible resolver seam", async () => {
		const root = makeTempDir("bobbit-direct-pi-");
		const modulesDir = path.join(root, "node_modules");
		const packageRoot = path.join(modulesDir, "@earendil-works", "pi-coding-agent");
		const entryPath = path.join(packageRoot, "dist", "index.js");
		const cliPath = path.join(packageRoot, "dist", "cli.js");
		fs.mkdirSync(path.dirname(entryPath), { recursive: true });
		fs.writeFileSync(entryPath, "export {};\n", "utf-8");
		fs.writeFileSync(cliPath, "// fake Pi CLI\n", "utf-8");
		writeJson(path.join(packageRoot, "package.json"), { name: PI_PACKAGE, type: "module" });

		const specifiers: string[] = [];
		const availabilityChecks: string[] = [];
		const resolved = await Promise.resolve(directRuntimeResolver()({
			resolve: (specifier: string) => {
				specifiers.push(specifier);
				return pathToFileURL(entryPath).href;
			},
			exists: (file: string) => {
				availabilityChecks.push(file);
				return fs.existsSync(file);
			},
		}));

		expect(specifiers, `${POLICY_PREFIX}_NODE_RESOLVE_SEMANTICS: resolve the package through the injected import.meta.resolve-compatible seam`).toEqual([PI_PACKAGE]);
		expect(availabilityChecks, `${POLICY_PREFIX}_PI_RUNTIME_AVAILABILITY: verify the resolved entry and derived CLI`).toEqual([entryPath, cliPath]);
		expect(resolved).toEqual({ modulesDir, cliPath });
	});

	it("never probes or mutates a legacy state/runtime tree during real direct bridge starts", async () => {
		const root = makeTempDir("bobbit-no-runtime-access-");
		const previousBobbitDir = process.env.BOBBIT_DIR;
		const previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		process.env.BOBBIT_DIR = root;
		process.env.BOBBIT_AGENT_DIR = path.join(root, "agent");
		resetAgentDirStateForTests();

		const runtimeDir = path.join(root, "state", "runtime");
		const sentinel = path.join(runtimeDir, "node_modules.partial", "sentinel.txt");
		fs.mkdirSync(path.dirname(sentinel), { recursive: true });
		fs.writeFileSync(sentinel, "legacy-runtime-must-remain-byte-identical", "utf-8");
		const beforeBytes = fs.readFileSync(sentinel);
		const beforeStat = statIdentity(sentinel);

		const modulesDir = path.join(root, "installed", "node_modules");
		const entryPath = path.join(modulesDir, "@earendil-works", "pi-coding-agent", "dist", "index.js");
		const cliPath = path.join(path.dirname(entryPath), "cli.js");
		fs.mkdirSync(path.dirname(entryPath), { recursive: true });
		fs.writeFileSync(entryPath, "export {};\n", "utf-8");
		fs.writeFileSync(cliPath, "// fake Pi CLI\n", "utf-8");

		const observer = observeLegacyRuntimeAccess(runtimeDir);
		const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
		const resolvedSpecifiers: string[] = [];
		try {
			for (const route of ["pre-listen restored direct session", "later direct agent/verification"] as const) {
				const spawnDirect = ((command: string, args: readonly string[] = []) => {
					spawnCalls.push({ command, args: [...args] });
					return makeStableRpcChild();
				}) as typeof childProcess.spawn;
				const bridge = new rpcBridgeModule.RpcBridge({
					cwd: root,
					args: ["--no-extensions"],
					clock: immediateClock,
				}, {
					resolvePackage: (specifier: string) => {
						resolvedSpecifiers.push(specifier);
						return pathToFileURL(entryPath).href;
					},
					spawnDirect,
				});

				await bridge.start();
				const call = spawnCalls.at(-1);
				expect(call, `${POLICY_PREFIX}_DIRECT_ROUTE_START: ${route}`).toBeDefined();
				expect(call!.command).toBe(process.execPath);
				expect(call!.args[0]).toBe(cliPath);
			}
			expect(resolvedSpecifiers).toEqual([PI_PACKAGE, PI_PACKAGE]);
			expect(
				observer.accesses,
				`${POLICY_PREFIX}_LEGACY_RUNTIME_ACCESS: direct start must perform zero reads, stats, traversals, writes, creates, renames, or deletes below <stateDir>/runtime`,
			).toEqual([]);
		} finally {
			observer.restore();
			if (previousBobbitDir === undefined) delete process.env.BOBBIT_DIR;
			else process.env.BOBBIT_DIR = previousBobbitDir;
			if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
			else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
			resetAgentDirStateForTests();
		}

		expect(fs.readFileSync(sentinel)).toEqual(beforeBytes);
		expect(statIdentity(sentinel)).toEqual(beforeStat);
	});

	it("keeps an explicit CLI override first and does not invoke automatic resolution or availability checks", async () => {
		const explicitCli = path.join(makeTempDir("bobbit-explicit-pi-"), "custom-cli.js");
		let resolutionCalls = 0;
		let availabilityChecks = 0;
		const resolved = await Promise.resolve(directRuntimeResolver()({
			cliPath: explicitCli,
			resolve: () => {
				resolutionCalls++;
				throw new Error("automatic resolution must not run for an explicit CLI");
			},
			exists: () => {
				availabilityChecks++;
				return false;
			},
		}));

		expect({ resolutionCalls, availabilityChecks }, `${POLICY_PREFIX}_EXPLICIT_CLI_PRECEDENCE`).toEqual({
			resolutionCalls: 0,
			availabilityChecks: 0,
		});
		expect(resolved.cliPath).toBe(explicitCli);
	});

	it("turns a missing Pi package into actionable install or --agent-cli guidance", async () => {
		await expect(async () => Promise.resolve(directRuntimeResolver()({
			resolve: () => {
				throw Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });
			},
		}))).rejects.toThrow(/install\s+@earendil-works\/pi-coding-agent[\s\S]*--agent-cli\s+\/path\/to\/cli\.js/i);
	});

	it.each([
		{ unavailable: "resolved package entry", entryAvailable: false },
		{ unavailable: "derived dist/cli.js", entryAvailable: true },
	])("turns an unavailable $unavailable into actionable partial-install guidance", async ({ entryAvailable }) => {
		const root = makeTempDir("bobbit-partial-pi-");
		const packageRoot = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
		const entryPath = path.join(packageRoot, "dist", "index.js");
		const cliPath = path.join(packageRoot, "dist", "cli.js");
		const availabilityChecks: string[] = [];

		await expect(async () => Promise.resolve(directRuntimeResolver()({
			resolve: () => pathToFileURL(entryPath).href,
			exists: (file: string) => {
				availabilityChecks.push(file);
				return file === entryPath && entryAvailable;
			},
		}))).rejects.toThrow(/(?:missing|incomplete)[\s\S]*install\s+@earendil-works\/pi-coding-agent[\s\S]*--agent-cli\s+\/path\/to\/cli\.js/i);

		expect(availabilityChecks, `${POLICY_PREFIX}_PARTIAL_PI_AVAILABILITY`).toEqual(
			entryAvailable ? [entryPath, cliPath] : [entryPath],
		);
	});
});

describe.skipIf(!desiredContractAvailable)("development harness pre-build validation wrapper", () => {
	it.each(["dev:harness", "dev:nord", "dev:watchdog"])(
		"runs the read-only validator before build:server in the real %s script without dependency repair",
		(scriptName) => {
			const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
			const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf-8")) as {
				scripts?: Record<string, string>;
			};
			const script = manifest.scripts?.[scriptName] ?? "";
			const steps = script.split(/\s*&&\s*/);

			expect(steps[0], `${POLICY_PREFIX}_WRAPPER_VALIDATION_FIRST:${scriptName}`).toBe("node src/server/harness-deps.ts");
			expect(steps[1], `${POLICY_PREFIX}_WRAPPER_BUILD_SECOND:${scriptName}`).toBe("npm run build:server");
			expect(script, `${POLICY_PREFIX}_WRAPPER_NO_DEPENDENCY_REPAIR:${scriptName}`).not.toMatch(
				/\b(?:npm\s+(?:install|i|ci|update|uninstall|remove|rm|prune|audit\s+fix)|pnpm\s+(?:install|i|add|update|up|remove)|yarn\s+(?:install|add|upgrade|remove)|bun\s+(?:install|add|update|remove))\b/i,
			);
		},
	);

	it("fails non-zero with actionable diagnostics without writes or package-manager subprocesses", () => {
		const root = makeTempDir("bobbit-wrapper-validation-");
		writeJson(path.join(root, "package.json"), {
			dependencies: { "wrapper-missing": "1.0.0" },
		});
		const reports: string[] = [];
		const traps = trapMutationAndSubprocesses();
		let exitCode: number;
		try {
			exitCode = dependencyValidationCli()(root, {
				report: (message: string) => reports.push(message),
			});
		} finally {
			traps.restore();
		}

		expect(exitCode!).toBeGreaterThan(0);
		expect(reports.join("\n")).toMatch(/wrapper-missing[\s\S]*stop Bobbit[\s\S]*npm install[\s\S]*(?:retry|restart)/i);
		expect({ writes: traps.writes, commands: traps.commands }).toEqual({ writes: [], commands: [] });
	});
});

describe.skipIf(!desiredContractAvailable)("read-only harness dependency validation", () => {
	it("checks prod and dev package manifests, ignores optional dependencies, and performs only injected reads", async () => {
		const root = makeTempDir("bobbit-dependency-validation-");
		writeJson(path.join(root, "package.json"), {
			dependencies: { "prod-present": "1.0.0" },
			devDependencies: { "dev-present": "1.0.0" },
			optionalDependencies: { "optional-absent": "1.0.0" },
		});
		writePackage(path.join(root, "node_modules"), "prod-present");
		writePackage(path.join(root, "node_modules"), "dev-present");
		const reads: string[] = [];
		const existsChecks: string[] = [];
		let injectedWriteCalls = 0;
		let injectedCommandCalls = 0;
		const traps = trapMutationAndSubprocesses();
		let result: ValidationResult;
		try {
			result = await Promise.resolve(dependencyValidator()(root, {
				readFile: (file: string) => {
					reads.push(file);
					return fs.readFileSync(file, "utf-8");
				},
				exists: (file: string) => {
					existsChecks.push(file);
					return fs.existsSync(file);
				},
				writeFile: () => { injectedWriteCalls++; },
				exec: () => { injectedCommandCalls++; },
			}));
		} finally {
			traps.restore();
		}

		expect(result!.ok).toBe(true);
		expect(reads.map(file => path.normalize(file))).toContain(path.normalize(path.join(root, "package.json")));
		expect(existsChecks.map(file => path.normalize(file))).toEqual(expect.arrayContaining([
			path.normalize(path.join(root, "node_modules", "prod-present", "package.json")),
			path.normalize(path.join(root, "node_modules", "dev-present", "package.json")),
		]));
		expect(existsChecks.some(file => file.includes("optional-absent"))).toBe(false);
		expect({ injectedWriteCalls, injectedCommandCalls, writes: traps.writes, commands: traps.commands }, `${POLICY_PREFIX}_READ_ONLY_VALIDATOR`).toEqual({
			injectedWriteCalls: 0,
			injectedCommandCalls: 0,
			writes: [],
			commands: [],
		});
	});

	it("names every missing prod/dev package and gives manual recovery instructions", async () => {
		const root = makeTempDir("bobbit-missing-dependencies-");
		writeJson(path.join(root, "package.json"), {
			dependencies: { "missing-prod": "1.0.0", "bare-directory": "1.0.0" },
			devDependencies: { "missing-dev": "1.0.0" },
			optionalDependencies: { "missing-optional": "1.0.0" },
		});
		fs.mkdirSync(path.join(root, "node_modules", "bare-directory"), { recursive: true });

		const result = await Promise.resolve(dependencyValidator()(root)) as ValidationResult;
		expectManualRecovery(result, /missing-prod/i);
		const text = validationText(result);
		expect(text).toContain("bare-directory");
		expect(text).toContain("missing-dev");
		expect(text).not.toContain("missing-optional");
	});

	it("rejects unreadable, malformed, and structurally invalid root manifests", async () => {
		const cases: Array<{ name: string; prepare: (root: string) => void; cause: RegExp }> = [
			{ name: "unreadable", prepare: () => {}, cause: /package\.json[\s\S]*(?:read|unreadable|missing|ENOENT)/i },
			{ name: "malformed", prepare: root => fs.writeFileSync(path.join(root, "package.json"), "{not-json", "utf-8"), cause: /package\.json[\s\S]*(?:invalid|parse|JSON|malformed)/i },
			{ name: "structurally-invalid", prepare: root => writeJson(path.join(root, "package.json"), { dependencies: ["not-a-map"] }), cause: /package\.json[\s\S]*(?:invalid|dependencies|object|structure)/i },
		];
		for (const fixture of cases) {
			const root = makeTempDir(`bobbit-${fixture.name}-manifest-`);
			fixture.prepare(root);
			const result = await Promise.resolve(dependencyValidator()(root)) as ValidationResult;
			expectManualRecovery(result, fixture.cause);
		}
	});
});

describe.skipIf(!desiredContractAvailable)("harness lifecycle validation policy", () => {
	it("blocks unhealthy initial boot before repair, build, or launch and exits non-zero", async () => {
		const fixture = lifecycleFixture(() => unhealthy);
		await runLifecycle("initial", fixture.deps);

		expect(fixture.counters).toMatchObject({ validate: 1, repair: 0, build: 0, launch: 0, alive: false });
		expect(fixture.counters.exitCodes).toHaveLength(1);
		expect(fixture.counters.exitCodes[0]).toBeGreaterThan(0);
		expect(fixture.counters.reports.join("\n")).toMatch(/missing-pkg[\s\S]*npm install/i);
	});

	it.each(["sentinel-restart", "crash-relaunch"] as const)("keeps the harness alive when %s validation fails", async trigger => {
		const fixture = lifecycleFixture(() => unhealthy);
		await runLifecycle(trigger, fixture.deps);

		expect(fixture.counters).toMatchObject({ validate: 1, repair: 0, build: 0, launch: 0, alive: true });
		expect(fixture.counters.exitCodes).toEqual([]);
		expect(fixture.counters.reports.join("\n")).toMatch(/missing-pkg[\s\S]*npm install/i);
	});

	it("revalidates a later operator sentinel retry on the same live harness and then builds and launches", async () => {
		let repaired = false;
		const fixture = lifecycleFixture(() => repaired ? healthy : unhealthy);
		await runLifecycle("sentinel-restart", fixture.deps);
		expect(fixture.counters).toMatchObject({ validate: 1, repair: 0, build: 0, launch: 0, alive: true });

		repaired = true; // Simulated operator-only repair of the temp-fixture state.
		await runLifecycle("sentinel-restart", fixture.deps);
		expect(fixture.counters).toMatchObject({ validate: 2, repair: 0, build: 1, launch: 1, alive: true });
	});

	it.each([
		{ trigger: "initial" as const, builds: 1 },
		{ trigger: "sentinel-restart" as const, builds: 1 },
		{ trigger: "crash-relaunch" as const, builds: 0 },
	])("validates and follows the healthy $trigger build/launch policy", async ({ trigger, builds }) => {
		const fixture = lifecycleFixture(() => healthy);
		await runLifecycle(trigger, fixture.deps);
		expect(fixture.counters).toMatchObject({ validate: 1, repair: 0, build: builds, launch: 1, alive: true });
		expect(fixture.counters.exitCodes).toEqual([]);
	});

	it("does not launch after a sentinel build failure and remains retryable", async () => {
		const fixture = lifecycleFixture(() => healthy);
		let failBuild = true;
		fixture.deps.build = async () => {
			fixture.counters.build++;
			if (failBuild) throw new Error("deterministic build failure");
		};

		await runLifecycle("sentinel-restart", fixture.deps);
		expect(fixture.counters).toMatchObject({ validate: 1, repair: 0, build: 1, launch: 0, alive: true });
		expect(fixture.counters.reports.join("\n")).toMatch(/build failure/i);

		failBuild = false;
		await runLifecycle("sentinel-restart", fixture.deps);
		expect(fixture.counters).toMatchObject({ validate: 2, repair: 0, build: 2, launch: 1, alive: true });
	});
});
