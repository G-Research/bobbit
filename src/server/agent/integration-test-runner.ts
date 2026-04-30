/**
 * Integration-test runner used by the `implementation` gate's
 * `integration-test` verify step.
 *
 * A best-effort smoke runner that:
 *   1. Reads the project's `qa_start_command` (skips with warning if absent).
 *   2. Spawns the application stack via a child process keyed by
 *      `(goalId, gateId, signalId)` so concurrent verifications don't collide.
 *   3. Polls a healthcheck URL (project-configurable; defaults to GET
 *      /health → /api/health on the published port).
 *   4. Routes a small set of project-supplied "smoke scenarios" loaded from
 *      `defaults/qa-scenarios/<workflow>.yaml` (or a project override at
 *      `.bobbit/config/qa-scenarios.yaml`). Each scenario is one of:
 *        - `command`: a shell command. Pass = exit 0.
 *        - `http`: an HTTP request. Pass = expected status + (optional)
 *          JSON-shape / substring assertion on the body.
 *   5. Tears down the stack (SIGTERM, then SIGKILL) when done.
 *
 * The runner is deliberately project-agnostic and minimal — anything
 * project-specific should override via `.bobbit/config/qa-scenarios.yaml`.
 *
 * Design rationale: today the implementation gate already runs unit + E2E +
 * agent-qa, but they're loosely coupled — type-check failure short-circuits
 * the QA step (good) but a passing E2E doesn't mean a working integrated
 * system. The integration-test step adds a black-box smoke that catches a
 * specific class of bug we keep shipping: the build is green, the type
 * checker is happy, the unit + E2E suites pass, but the actual running
 * binary refuses to do its job (missing tool registration, prompt
 * substitution drift, etc.). This step exists to make those visible.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

// ---------------------------------------------------------------------------
// Scenario types
// ---------------------------------------------------------------------------

export interface CommandScenario {
	name: string;
	type: "command";
	command: string;
	timeout?: number; // seconds (default 60)
	cwd?: string;
}

export interface HttpScenario {
	name: string;
	type: "http";
	method?: string;        // default GET
	url: string;            // ${PORT} substituted from spawn output
	headers?: Record<string, string>;
	body?: string;
	expect_status?: number; // default 200
	expect_json?: unknown;  // partial-match (subset of response)
	expect_body_contains?: string;
	timeout?: number;       // seconds (default 10)
}

export type Scenario = CommandScenario | HttpScenario;

export interface ScenarioFile {
	scenarios: Scenario[];
}

export interface IntegrationTestStepResult {
	passed: boolean;
	output: string;
	skipped: boolean;
}

export interface IntegrationTestStepOptions {
	/** Resolved qa_start_command from project.yaml. Empty / undefined = skip. */
	qaStartCommand?: string;
	/** Resolved qa_health_check URL. May contain ${PORT}. Defaults if empty. */
	qaHealthCheck?: string;
	/** Default health URL probe paths if `qaHealthCheck` is empty. */
	defaultHealthPaths?: string[];
	/** cwd for both the qa_start_command spawn and command-type scenarios. */
	cwd: string;
	/** Workflow id (feature, bug-fix, general...) used to find the default scenario file. */
	workflowId: string;
	/** Path to the project's config directory (used to resolve overrides). */
	configDir?: string;
	/** Explicit absolute / project-relative path to a scenarios.yaml override. */
	scenariosPath?: string;
	/** Maximum total duration (ms) for the entire integration-test step. */
	overallTimeoutMs?: number;
	/** Maximum time (ms) to wait for healthcheck. */
	healthcheckTimeoutMs?: number;
	/** Hook for tests to inject a different default-scenarios root. */
	defaultsRoot?: string;
	/** Hook for tests to inject a different `spawn` impl. */
	spawnImpl?: typeof spawn;
}

// ---------------------------------------------------------------------------
// Defaults root resolution
// ---------------------------------------------------------------------------

function resolveDefaultsRoot(): string {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		// dist/server/agent/integration-test-runner.js → dist → repo
		const candidates = [
			path.resolve(here, "..", "..", "..", "defaults", "qa-scenarios"),
			path.resolve(here, "..", "..", "defaults", "qa-scenarios"),
			path.resolve(here, "..", "defaults", "qa-scenarios"),
		];
		for (const c of candidates) {
			if (fs.existsSync(c)) return c;
		}
		return candidates[0];
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------

export function loadScenarios(opts: IntegrationTestStepOptions): { scenarios: Scenario[]; source: string } {
	const tried: string[] = [];

	const tryLoad = (file: string): { scenarios: Scenario[] } | null => {
		if (!file) return null;
		tried.push(file);
		if (!fs.existsSync(file)) return null;
		const text = fs.readFileSync(file, "utf-8");
		const parsed = yaml.parse(text);
		if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as ScenarioFile).scenarios)) {
			throw new Error(`Invalid scenarios file at ${file}: missing or non-array \`scenarios\``);
		}
		return { scenarios: (parsed as ScenarioFile).scenarios };
	};

	// 1. Explicit scenarios path (from VerifyStep.scenarios). Resolve relative to cwd.
	if (opts.scenariosPath) {
		const abs = path.isAbsolute(opts.scenariosPath)
			? opts.scenariosPath
			: path.resolve(opts.cwd, opts.scenariosPath);
		const r = tryLoad(abs);
		if (r) return { scenarios: r.scenarios, source: abs };
	}

	// 2. Project override
	if (opts.configDir) {
		const override = path.join(opts.configDir, "qa-scenarios.yaml");
		const r = tryLoad(override);
		if (r) return { scenarios: r.scenarios, source: override };
	}

	// 3. Defaults per workflow
	const defaultsRoot = opts.defaultsRoot || resolveDefaultsRoot();
	if (defaultsRoot) {
		const wfFile = path.join(defaultsRoot, `${opts.workflowId}.yaml`);
		const r = tryLoad(wfFile);
		if (r) return { scenarios: r.scenarios, source: wfFile };
		// Fallback to feature.yaml if the workflow-specific file is missing
		const fallback = path.join(defaultsRoot, "feature.yaml");
		const r2 = tryLoad(fallback);
		if (r2) return { scenarios: r2.scenarios, source: fallback };
	}

	throw new Error(
		`No scenarios file found for workflow "${opts.workflowId}". Tried: ${tried.join(", ")}`,
	);
}

// ---------------------------------------------------------------------------
// Port detection
// ---------------------------------------------------------------------------

const PORT_REGEX = /(?:listening (?:on|at)\s+(?:https?:\/\/[^:\s]+)?:?|(?:listening|server|ready) on (?:https?:\/\/[^:\s]+)?:|on port\s+|http:\/\/(?:127\.0\.0\.1|localhost):)(\d{2,5})\b/i;

export function detectPort(stdoutChunk: string): number | null {
	const m = PORT_REGEX.exec(stdoutChunk);
	if (m && m[1]) {
		const n = parseInt(m[1], 10);
		if (Number.isFinite(n) && n > 0 && n < 65536) return n;
	}
	return null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HttpResult {
	status: number;
	body: string;
	headers: Record<string, string>;
}

function fetchOnce(urlStr: string, opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		try {
			const url = new URL(urlStr);
			const lib = url.protocol === "https:" ? https : http;
			const req = lib.request({
				method: opts.method || "GET",
				hostname: url.hostname,
				port: url.port || (url.protocol === "https:" ? 443 : 80),
				path: url.pathname + url.search,
				headers: opts.headers || {},
				// Self-signed dev certs are common.
				...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
			}, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					const headers: Record<string, string> = {};
					for (const [k, v] of Object.entries(res.headers)) {
						if (typeof v === "string") headers[k.toLowerCase()] = v;
						else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
					}
					resolve({
						status: res.statusCode || 0,
						body: Buffer.concat(chunks).toString("utf-8"),
						headers,
					});
				});
			});
			req.on("error", reject);
			req.setTimeout(opts.timeoutMs, () => {
				req.destroy(new Error(`HTTP request timed out after ${opts.timeoutMs}ms`));
			});
			if (opts.body) req.write(opts.body);
			req.end();
		} catch (err) {
			reject(err);
		}
	});
}

/**
 * Partial-match: every primitive leaf in `expected` must appear and equal in
 * `actual` at the same path. Arrays compared by index, but `actual` may be
 * longer.
 */
export function jsonShapeMatches(actual: unknown, expected: unknown): boolean {
	if (expected === null || expected === undefined) return actual === expected;
	if (typeof expected !== "object") return actual === expected;
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return false;
		for (let i = 0; i < expected.length; i++) {
			if (!jsonShapeMatches((actual as unknown[])[i], expected[i])) return false;
		}
		return true;
	}
	if (typeof actual !== "object" || actual === null) return false;
	for (const [k, v] of Object.entries(expected)) {
		if (!jsonShapeMatches((actual as Record<string, unknown>)[k], v)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Stack lifecycle
// ---------------------------------------------------------------------------

interface RunningStack {
	child: ChildProcess;
	stdout: string;
	stderr: string;
	port: number | null;
}

async function spawnStack(
	startCommand: string,
	cwd: string,
	spawnImpl: typeof spawn,
): Promise<RunningStack> {
	// Use the same shell heuristic as command steps; default to /bin/sh -c on
	// non-Windows for predictability.
	const shellBin = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
	const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
	const child = spawnImpl(shellBin, [...shellArgs, startCommand], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
		...(process.platform === "win32" ? { windowsHide: true } : {}),
	});
	const stack: RunningStack = { child, stdout: "", stderr: "", port: null };
	child.stdout?.on("data", (d: Buffer) => {
		const s = d.toString();
		stack.stdout += s;
		if (stack.stdout.length > 256 * 1024) stack.stdout = stack.stdout.slice(-128 * 1024);
		if (stack.port == null) {
			const p = detectPort(s);
			if (p != null) stack.port = p;
		}
	});
	child.stderr?.on("data", (d: Buffer) => {
		const s = d.toString();
		stack.stderr += s;
		if (stack.stderr.length > 256 * 1024) stack.stderr = stack.stderr.slice(-128 * 1024);
		// Some servers print "listening on :3001" to stderr.
		if (stack.port == null) {
			const p = detectPort(s);
			if (p != null) stack.port = p;
		}
	});
	return stack;
}

async function teardownStack(stack: RunningStack): Promise<void> {
	if (!stack.child || stack.child.exitCode != null) return;
	try { stack.child.kill("SIGTERM"); } catch { /* ignore */ }
	// Give the child up to 3s to exit cleanly.
	const exited = await new Promise<boolean>((resolve) => {
		const t = setTimeout(() => resolve(false), 3000);
		stack.child.once("exit", () => { clearTimeout(t); resolve(true); });
	});
	if (!exited) {
		try { stack.child.kill("SIGKILL"); } catch { /* ignore */ }
	}
}

// ---------------------------------------------------------------------------
// Healthcheck
// ---------------------------------------------------------------------------

function substitutePort(template: string, port: number | null): string {
	if (port == null) return template;
	return template
		.replace(/\$\{PORT\}/g, String(port))
		.replace(/\$PORT\b/g, String(port));
}

async function pollHealth(
	healthUrl: string,
	timeoutMs: number,
): Promise<{ ok: boolean; status?: number; lastError?: string }> {
	const start = Date.now();
	let lastError = "";
	let lastStatus: number | undefined;
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetchOnce(healthUrl, { timeoutMs: 2_000 });
			lastStatus = r.status;
			if (r.status >= 200 && r.status < 400) {
				return { ok: true, status: r.status };
			}
		} catch (err: any) {
			lastError = err?.message || String(err);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return { ok: false, status: lastStatus, lastError };
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

async function runCommandScenario(
	s: CommandScenario,
	cwd: string,
	port: number | null,
	spawnImpl: typeof spawn,
): Promise<{ passed: boolean; output: string }> {
	const cmd = substitutePort(s.command, port);
	const shellBin = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
	const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
	return new Promise((resolve) => {
		const child = spawnImpl(shellBin, [...shellArgs, cmd], {
			cwd: s.cwd || cwd,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: (s.timeout ?? 60) * 1000,
			env: { ...process.env, ...(port != null ? { PORT: String(port) } : {}) },
			...(process.platform === "win32" ? { windowsHide: true } : {}),
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("close", (code) => {
			const out = (stdout + (stderr ? `\nstderr:\n${stderr}` : "")).slice(-2000);
			resolve({ passed: code === 0, output: out || `exit ${code}` });
		});
		child.on("error", (err) => {
			resolve({ passed: false, output: err.message });
		});
	});
}

async function runHttpScenario(
	s: HttpScenario,
	port: number | null,
): Promise<{ passed: boolean; output: string }> {
	const url = substitutePort(s.url, port);
	const expectedStatus = s.expect_status ?? 200;
	const timeoutMs = (s.timeout ?? 10) * 1000;
	let r: HttpResult;
	try {
		r = await fetchOnce(url, {
			method: s.method,
			headers: s.headers,
			body: s.body,
			timeoutMs,
		});
	} catch (err: any) {
		return { passed: false, output: `HTTP request to ${url} failed: ${err?.message ?? String(err)}` };
	}

	const lines: string[] = [`${s.method || "GET"} ${url} → ${r.status}`];
	if (r.status !== expectedStatus) {
		lines.push(`Expected status ${expectedStatus}, got ${r.status}`);
		lines.push(`Body (first 500 chars): ${r.body.slice(0, 500)}`);
		return { passed: false, output: lines.join("\n") };
	}

	if (s.expect_body_contains && !r.body.includes(s.expect_body_contains)) {
		lines.push(`Expected body to contain "${s.expect_body_contains}"`);
		lines.push(`Body (first 500 chars): ${r.body.slice(0, 500)}`);
		return { passed: false, output: lines.join("\n") };
	}

	if (s.expect_json !== undefined) {
		let actual: unknown;
		try {
			actual = JSON.parse(r.body);
		} catch {
			lines.push(`Expected JSON body but failed to parse.`);
			lines.push(`Body (first 500 chars): ${r.body.slice(0, 500)}`);
			return { passed: false, output: lines.join("\n") };
		}
		if (!jsonShapeMatches(actual, s.expect_json)) {
			lines.push(`JSON shape did not match expected.`);
			lines.push(`Expected: ${JSON.stringify(s.expect_json)}`);
			lines.push(`Actual (first 500 chars): ${r.body.slice(0, 500)}`);
			return { passed: false, output: lines.join("\n") };
		}
	}

	lines.push("OK");
	return { passed: true, output: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the integration-test step. Returns a structured result for the
 * verification harness to record on the GateSignalStep.
 */
export async function runIntegrationTestStep(
	opts: IntegrationTestStepOptions,
): Promise<IntegrationTestStepResult> {
	const startCmd = (opts.qaStartCommand || "").trim();
	if (!startCmd) {
		return {
			passed: true,
			skipped: true,
			output:
				"Skipped: no qa_start_command configured for this project. " +
				"Add `qa_start_command` to project.yaml to enable integration smoke testing.",
		};
	}

	let scenarios: Scenario[];
	let source: string;
	try {
		const loaded = loadScenarios(opts);
		scenarios = loaded.scenarios;
		source = loaded.source;
	} catch (err: any) {
		return {
			passed: false,
			skipped: false,
			output: `Failed to load scenarios: ${err?.message ?? String(err)}`,
		};
	}

	const overallTimeoutMs = opts.overallTimeoutMs ?? 5 * 60 * 1000;
	const healthcheckTimeoutMs = opts.healthcheckTimeoutMs ?? 60_000;
	const spawnImpl = opts.spawnImpl ?? spawn;

	const overallStart = Date.now();
	const log: string[] = [`Scenarios from: ${source}`];

	let stack: RunningStack | null = null;
	try {
		stack = await spawnStack(startCmd, opts.cwd, spawnImpl);

		// Wait for port to be detected from stdout/stderr OR fall back to
		// healthcheck on a configured port. The healthcheck may itself
		// substitute ${PORT} so we resolve port-detection first.
		// Port detection wait is capped by `overallTimeoutMs` so a hung
		// qa_start_command (no port emitted) doesn't block the runner past the
		// caller-configured budget.
		const portWaitBudget = Math.min(15_000, overallTimeoutMs);
		const portWait = Date.now();
		while (stack.port == null && Date.now() - portWait < portWaitBudget) {
			if (stack.child.exitCode != null) {
				log.push("qa_start_command exited before announcing a port.");
				log.push(`stdout (first 1000): ${stack.stdout.slice(0, 1000)}`);
				log.push(`stderr (first 1000): ${stack.stderr.slice(0, 1000)}`);
				return { passed: false, skipped: false, output: log.join("\n") };
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		const healthCandidates: string[] = [];
		if (opts.qaHealthCheck) {
			healthCandidates.push(substitutePort(opts.qaHealthCheck, stack.port));
		} else if (stack.port != null) {
			const defaults = opts.defaultHealthPaths ?? ["/health", "/api/health"];
			for (const p of defaults) {
				healthCandidates.push(`http://127.0.0.1:${stack.port}${p}`);
			}
		}

		// Healthcheck — try each candidate in turn.
		let healthOk = false;
		let healthStatus: number | undefined;
		let healthError = "";
		for (const url of healthCandidates) {
			const remaining = Math.max(1_000, healthcheckTimeoutMs - (Date.now() - overallStart));
			const r = await pollHealth(url, Math.min(remaining, healthcheckTimeoutMs));
			if (r.ok) {
				healthOk = true;
				healthStatus = r.status;
				log.push(`Healthcheck OK: ${url} → ${r.status}`);
				break;
			}
			healthError = r.lastError || `status ${r.status ?? "?"}`;
			log.push(`Healthcheck failed: ${url} (${healthError})`);
		}

		if (healthCandidates.length === 0) {
			log.push(
				"No port detected from qa_start_command output and no qa_health_check configured " +
				"— skipping healthcheck and running scenarios without port substitution.",
			);
		} else if (!healthOk) {
			log.push(`Healthcheck failed after ${Math.round((Date.now() - overallStart) / 1000)}s: ${healthError}`);
			log.push(`stdout tail: ${stack.stdout.slice(-500)}`);
			log.push(`stderr tail: ${stack.stderr.slice(-500)}`);
			return { passed: false, skipped: false, output: log.join("\n") };
		}

		// Run scenarios (fail fast).
		for (const scenario of scenarios) {
			if (Date.now() - overallStart > overallTimeoutMs) {
				log.push(`Overall timeout (${overallTimeoutMs}ms) exceeded — aborting remaining scenarios.`);
				return { passed: false, skipped: false, output: log.join("\n") };
			}
			let r: { passed: boolean; output: string };
			if (scenario.type === "command") {
				r = await runCommandScenario(scenario, opts.cwd, stack.port, spawnImpl);
			} else if (scenario.type === "http") {
				r = await runHttpScenario(scenario, stack.port);
			} else {
				log.push(`Unknown scenario type: ${(scenario as Scenario).type}`);
				return { passed: false, skipped: false, output: log.join("\n") };
			}
			log.push(`[${r.passed ? "PASS" : "FAIL"}] ${scenario.name}: ${r.output}`);
			if (!r.passed) {
				return { passed: false, skipped: false, output: log.join("\n") };
			}
		}

		void healthStatus;
		log.push(`All ${scenarios.length} scenario(s) passed.`);
		return { passed: true, skipped: false, output: log.join("\n") };
	} catch (err: any) {
		log.push(`Integration-test runner error: ${err?.message ?? String(err)}`);
		return { passed: false, skipped: false, output: log.join("\n") };
	} finally {
		if (stack) {
			try { await teardownStack(stack); } catch { /* ignore */ }
		}
	}
}
