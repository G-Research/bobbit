import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";

export const RUN_PREFIX = "bobbit-benchmark-";
export const RUN_OWNER_MARKER = ".bobbit-benchmark-owner.json";
export const DEFAULT_GATEWAY_TIMEOUT_MS = 120_000;
export const DEFAULT_STOP_GRACE_MS = 5_000;
export const DEFAULT_LOG_TAIL_BYTES = 32 * 1024;
export const DIAGNOSTIC_TAIL_BYTES = 2 * 1024;
export const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

function boundedReliability(value) {
	const normalized = String(value ?? "unsupported").replace(/\s+/g, " ").trim() || "unsupported";
	return normalized.slice(0, 120);
}

/** Conservatively summarize per-sample reliability without letting warm-ups influence measured results. */
export function aggregateMeasuredReliability(samples, metric) {
	const measured = (Array.isArray(samples) ? samples : [])
		.filter(sample => sample?.phase === "measured")
		.map(sample => boundedReliability(sample?.metricReliability?.[metric]));
	if (measured.length === 0) return "unsupported";
	const observed = [...new Set(measured)].sort();
	if (observed.length === 1) return observed[0];
	const mixed = `mixed (${observed.join(", ")})`;
	return mixed.length <= 240 ? mixed : `${mixed.slice(0, 227)}... (truncated)`;
}

/**
 * Own one absolute browser-sample deadline. Expiry interrupts active page
 * execution instead of abandoning its promise, leaving ordinary finally blocks
 * responsible for verified browser-before-gateway teardown.
 */
export function createInterruptingSampleWatchdog({
	label,
	errorName,
	phaseLabel = label?.toLowerCase(),
	phases,
	initialPhase = phases?.[0],
	timeoutMs,
	graceMs,
	now = () => performance.now(),
	setTimer = (callback, delay) => setTimeout(callback, delay),
	clearTimer = handle => clearTimeout(handle),
	terminateExecution = runtime => runtime?.cdp?.send("Runtime.terminateExecution") ?? Promise.resolve(),
	closeBrowser = runtime => runtime?.browser?.close() ?? Promise.resolve(),
} = {}) {
	if (typeof label !== "string" || !label.trim()) throw new TypeError("Watchdog label is required");
	if (typeof errorName !== "string" || !errorName.trim()) throw new TypeError("Watchdog error name is required");
	if (!Array.isArray(phases) || phases.length === 0 || new Set(phases).size !== phases.length || phases.some(phase => typeof phase !== "string" || !phase)) {
		throw new TypeError("Watchdog phases must be unique non-empty strings");
	}
	if (!phases.includes(initialPhase)) throw new Error(`Unknown ${phaseLabel} phase: ${initialPhase}`);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError(`${label} timeout must be positive`);
	if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError(`${label} watchdog grace must be non-negative`);

	const startedAt = now();
	const deadline = startedAt + timeoutMs;
	const durations = Object.fromEntries(phases.map(phase => [phase, 0]));
	const abortController = new AbortController();
	const interruptErrors = [];
	let phase = initialPhase;
	let phaseStartedAt = startedAt;
	let browserRuntime = null;
	let gatewayRuntime = null;
	let expired = false;
	let workSettled = false;
	let timeoutError = null;
	const browserInterruptions = new Map();

	const snapshotDurations = () => {
		const result = { ...durations };
		if (phase && !workSettled) result[phase] += Math.max(0, now() - phaseStartedAt);
		return Object.fromEntries(phases.map(name => [`${name}Ms`, result[name]]));
	};
	const captureInterrupt = async operation => {
		try { await operation(); } catch (error) { interruptErrors.push(error); }
	};
	const interruptBrowser = runtime => {
		if (!runtime || browserInterruptions.has(runtime)) return;
		let resolveFallback;
		const interruption = {
			terminatePromise: null,
			terminateSettled: false,
			fallbackPromise: new Promise(resolve => { resolveFallback = resolve; }),
			fallbackTimer: null,
			fallbackSettled: false,
			cancelFallback() {
				if (this.fallbackSettled) return;
				this.fallbackSettled = true;
				if (this.fallbackTimer !== null) clearTimer(this.fallbackTimer);
				resolveFallback();
			},
		};
		interruption.terminatePromise = captureInterrupt(() => terminateExecution(runtime))
			.finally(() => { interruption.terminateSettled = true; });
		interruption.fallbackTimer = setTimer(() => {
			if (interruption.fallbackSettled) return;
			captureInterrupt(() => closeBrowser(runtime)).finally(() => {
				interruption.fallbackSettled = true;
				resolveFallback();
			});
		}, graceMs);
		browserInterruptions.set(runtime, interruption);
	};
	const expire = () => {
		if (expired || workSettled) return;
		expired = true;
		timeoutError = new Error(`${label} watchdog expired after ${timeoutMs}ms during ${phase} phase`);
		timeoutError.name = errorName;
		timeoutError.phase = phase;
		timeoutError.phaseDurationsMs = snapshotDurations();
		abortController.abort(timeoutError);
		interruptBrowser(browserRuntime);
	};
	const expireIfPastDeadline = () => {
		if (!expired && !workSettled && now() >= deadline) expire();
	};
	const deadlineTimer = setTimer(expire, timeoutMs);

	return {
		signal: abortController.signal,
		setPhase(nextPhase) {
			if (!phases.includes(nextPhase)) throw new Error(`Unknown ${phaseLabel} phase: ${nextPhase}`);
			if (nextPhase === phase) return;
			const timestamp = now();
			durations[phase] += Math.max(0, timestamp - phaseStartedAt);
			phase = nextPhase;
			phaseStartedAt = timestamp;
		},
		registerGateway(runtime) { gatewayRuntime = runtime ?? null; },
		registerBrowser(runtime) {
			browserRuntime = runtime ?? null;
			expireIfPastDeadline();
			if (expired && browserRuntime) interruptBrowser(browserRuntime);
		},
		resources() { return { browserRuntime, gatewayRuntime }; },
		remainingMs() {
			expireIfPastDeadline();
			return Math.max(1, Math.ceil(deadline - now()));
		},
		throwIfExpired() {
			expireIfPastDeadline();
			if (expired) throw timeoutError;
		},
		markWorkSettled() {
			if (workSettled) return;
			const timestamp = now();
			durations[phase] += Math.max(0, timestamp - phaseStartedAt);
			workSettled = true;
			clearTimer(deadlineTimer);
			for (const interruption of browserInterruptions.values()) {
				if (!expired || interruption.terminateSettled) interruption.cancelFallback();
			}
		},
		async finish() {
			this.markWorkSettled();
			const interruptions = [...browserInterruptions.values()];
			const allSettled = Promise.all(interruptions.flatMap(interruption => [
				interruption.terminatePromise,
				interruption.fallbackPromise,
			]));
			if (interruptions.length > 0) {
				let finishTimer;
				const settledWithinBound = await new Promise(resolve => {
					let settled = false;
					const finishWait = value => {
						if (settled) return;
						settled = true;
						if (finishTimer !== undefined) clearTimer(finishTimer);
						resolve(value);
					};
					allSettled.then(() => finishWait(true));
					finishTimer = setTimer(() => finishWait(false), Math.max(1, graceMs * 2));
				});
				if (!settledWithinBound) {
					interruptErrors.push(new Error(`${label} watchdog interruption did not settle within ${Math.max(1, graceMs * 2)}ms`));
				}
			}
			if (interruptErrors.length === 1) throw interruptErrors[0];
			if (interruptErrors.length > 1) throw new AggregateError(interruptErrors, `${label} watchdog interruption failed`);
		},
		phaseDurationsMs: snapshotDurations,
		get timedOut() { return expired; },
		get error() { return timeoutError; },
	};
}

function isWithin(parent, candidate) {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalExistingDirectory(directory) {
	const resolved = path.resolve(directory);
	if (lstatSync(resolved).isSymbolicLink()) {
		throw new Error(`Benchmark owned directory must not be a symbolic link or junction: ${resolved}`);
	}
	return realpathSync(resolved);
}

function projectedCanonicalPath(candidate) {
	const missing = [];
	let existing = path.resolve(candidate);
	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) throw new Error(`No existing ancestor for ${candidate}`);
		missing.unshift(path.basename(existing));
		existing = parent;
	}
	return path.join(realpathSync(existing), ...missing);
}

function benchmarkTempParent(env, tempDirectory) {
	const inherited = env.BOBBIT_V2_RUN_ROOT?.trim();
	return canonicalExistingDirectory(inherited || tempDirectory);
}

async function assertOwnedDirectory(root, candidate, label) {
	const lexicalRoot = path.resolve(root);
	const lexicalCandidate = path.resolve(candidate);
	if (!isWithin(lexicalRoot, lexicalCandidate)) throw new Error(`${label} escaped the owned benchmark root`);
	if ((await lstat(lexicalRoot)).isSymbolicLink()) {
		throw new Error(`${label} root must not be a symbolic link or junction`);
	}
	const canonicalRoot = await realpath(lexicalRoot);
	const canonicalCandidate = await realpath(lexicalCandidate);
	if (!isWithin(canonicalRoot, canonicalCandidate)) throw new Error(`${label} resolved outside the owned benchmark root`);
	let current = lexicalRoot;
	for (const segment of path.relative(lexicalRoot, lexicalCandidate).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if ((await lstat(current)).isSymbolicLink()) {
			throw new Error(`${label} must not traverse a symbolic link or junction`);
		}
	}
	if ((await lstat(lexicalRoot)).isSymbolicLink() || (await realpath(lexicalRoot)) !== canonicalRoot) {
		throw new Error(`${label} root identity changed during validation`);
	}
	return canonicalCandidate;
}

async function assertTreeHasNoLinks(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) throw new Error("Canonical fixtures must not contain symbolic links or junctions");
		if (entry.isDirectory()) await assertTreeHasNoLinks(path.join(directory, entry.name));
	}
}

/** Create the only recursively removable root used by a benchmark invocation. */
export async function createBenchmarkRunRoot({
	repoRoot = process.cwd(),
	env = process.env,
	tempDirectory = os.tmpdir(),
} = {}) {
	const requestedParent = path.resolve(env.BOBBIT_V2_RUN_ROOT?.trim() || tempDirectory);
	const lexicalForbiddenState = path.join(path.resolve(repoRoot), ".bobbit");
	if (isWithin(lexicalForbiddenState, requestedParent)) {
		throw new Error("Benchmark temporary roots may not traverse the repository .bobbit state tree");
	}
	const parent = benchmarkTempParent(env, tempDirectory);
	const forbiddenState = projectedCanonicalPath(lexicalForbiddenState);
	if (isWithin(forbiddenState, parent)) {
		throw new Error("Benchmark temporary roots may not use the repository .bobbit state tree");
	}
	const root = realpathSync(await mkdtemp(path.join(parent, RUN_PREFIX)));
	if (!isWithin(parent, root)) throw new Error("Benchmark run root escaped its canonical temporary parent");
	const ownerToken = randomUUID();
	const paths = {
		root,
		gateway: path.join(root, "gateway"),
		project: path.join(root, "project"),
		agent: path.join(root, "agent"),
		artifacts: path.join(root, "artifacts"),
		fixtures: path.join(root, "fixtures"),
		samples: path.join(root, "samples"),
	};
	try {
		await writeFile(path.join(root, RUN_OWNER_MARKER), JSON.stringify({
			schemaVersion: 1,
			ownerToken,
			pid: process.pid,
			createdAt: new Date().toISOString(),
		}), { encoding: "utf8", flag: "wx" });
		await Promise.all([
			paths.gateway,
			paths.project,
			paths.agent,
			paths.artifacts,
			paths.fixtures,
			paths.samples,
		].map(directory => mkdir(directory, { recursive: true })));
		await Promise.all(Object.values(paths).map(directory => assertOwnedDirectory(root, directory, "Benchmark run directory")));
		return { ...paths, ownerToken, tempParent: parent };
	} catch (error) {
		await rm(root, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

function safeSegment(value) {
	const segment = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
	if (!segment || segment === "." || segment === "..") throw new Error("Invalid benchmark sample name");
	return segment;
}

/** Allocate a fresh sample root and optionally copy an immutable canonical fixture. */
export async function createSampleRoot(paths, entry, { fixtureRoot } = {}) {
	if (!paths?.root || !paths?.samples || !paths?.fixtures) {
		throw new Error("Sample roots require owned benchmark paths");
	}
	if (!Number.isInteger(entry?.order) || entry.order < 0) {
		throw new Error("Benchmark samples require a non-negative scheduled order");
	}
	await assertOwnedDirectory(paths.root, paths.samples, "Samples root");
	await assertOwnedDirectory(paths.root, paths.fixtures, "Fixtures root");
	const directory = path.join(
		paths.samples,
		`${String(entry.order).padStart(4, "0")}-${safeSegment(entry?.phase ?? "sample")}-${safeSegment(entry?.case ?? "case")}`,
	);
	if (!isWithin(paths.samples, directory)) throw new Error("Sample path escaped the owned samples root");
	await mkdir(directory, { recursive: false });
	await assertOwnedDirectory(paths.samples, directory, "Sample directory");
	if (fixtureRoot) {
		const canonicalFixture = await assertOwnedDirectory(paths.fixtures, fixtureRoot, "Canonical fixture");
		await assertTreeHasNoLinks(canonicalFixture);
		const destination = path.join(directory, "fixture");
		await assertOwnedDirectory(paths.root, directory, "Sample directory");
		await cp(canonicalFixture, destination, {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
		await assertOwnedDirectory(directory, destination, "Copied fixture");
		await assertTreeHasNoLinks(destination);
	}
	return directory;
}

async function readOwner(paths) {
	const markerPath = path.join(paths.root, RUN_OWNER_MARKER);
	if ((await lstat(markerPath)).isSymbolicLink()) {
		throw new Error("Refusing to follow a linked benchmark owner marker");
	}
	const marker = JSON.parse(await readFile(markerPath, "utf8"));
	if (marker?.ownerToken !== paths.ownerToken || marker?.pid !== process.pid) {
		throw new Error("Refusing to clean a benchmark root not owned by this process");
	}
}

/** Remove only an owner-marked benchmark root. */
export async function cleanupBenchmarkRunRoot(paths) {
	if (!paths?.root || !paths?.ownerToken) throw new Error("Missing benchmark root ownership metadata");
	if (!existsSync(paths.root)) return;
	if (lstatSync(paths.root).isSymbolicLink()) {
		throw new Error("Refusing to clean a linked benchmark root");
	}
	const root = realpathSync(paths.root);
	if (path.resolve(root) !== path.resolve(paths.root)) {
		throw new Error("Refusing to clean a benchmark root whose identity changed");
	}
	if (paths.tempParent && !isWithin(realpathSync(paths.tempParent), root)) {
		throw new Error("Refusing to clean a benchmark root outside its temporary parent");
	}
	if (path.basename(root).startsWith(RUN_PREFIX) !== true) {
		throw new Error("Refusing to clean a root without the benchmark prefix");
	}
	await readOwner({ ...paths, root });
	await rm(root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

export function createTailBuffer(maxBytes = DEFAULT_LOG_TAIL_BYTES) {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
	let buffer = Buffer.alloc(0);
	let truncated = false;
	return {
		push(chunk) {
			const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			buffer = buffer.length === 0 ? next : Buffer.concat([buffer, next]);
			if (buffer.length > maxBytes) {
				buffer = buffer.subarray(buffer.length - maxBytes);
				truncated = true;
			}
		},
		text() { return buffer.toString("utf8"); },
		bytes() { return buffer.length; },
		truncated() { return truncated; },
	};
}

function diagnosticRedactions(cwd, env) {
	const values = [];
	for (const [key, value] of Object.entries(env ?? {})) {
		if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)/i.test(key) && typeof value === "string" && value.length >= 4) {
			values.push(value);
		}
	}
	if (typeof cwd === "string" && cwd.length >= 4) values.push(cwd);
	return [...new Set(values)].sort((left, right) => right.length - left.length).slice(0, 64);
}

function capDiagnosticTail(value, maximumBytes) {
	const bytes = Buffer.from(value);
	if (bytes.length <= maximumBytes) return { text: value, truncated: false };
	const marker = "[truncated]\n";
	const available = Math.max(0, maximumBytes - Buffer.byteLength(marker));
	const suffix = bytes.subarray(bytes.length - available).toString("utf8").replace(/^\uFFFD+/, "");
	return { text: `${marker}${suffix}`, truncated: true };
}

/** Redact credentials, absolute paths, and command-line dumps from bounded child diagnostics. */
export function sanitizeBenchmarkDiagnosticText(value, {
	maximumBytes = DIAGNOSTIC_TAIL_BYTES,
	redactions = [],
} = {}) {
	let text = String(value ?? "").replace(/\r\n?/g, "\n");
	for (const redaction of redactions) {
		const secret = String(redaction ?? "");
		if (secret.length >= 4) text = text.split(secret).join("[redacted]");
	}
	text = text
		.replace(/\b(authorization\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
		.replace(/\b((?:bearer|token|api[-_ ]?key|password|secret|credential)\b\s*[:=]?\s*)[^\s,;]+/gi, "$1[redacted]")
		.replace(/\b(?:command|argv|args|environment|env)\s*[:=].*$/gim, "[redacted diagnostic line]")
		.replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"']+\1/g, "[path]")
		.replace(/file:\/\/\/?[A-Za-z]:[\\/][^\s"'`)]+/gi, "[path]")
		.replace(/\\\\(?:\?\\)?[^\s"'`)]+/g, "[path]")
		.replace(/\b[A-Za-z]:[\\/][^\s"'`)]+/g, "[path]")
		.replace(/(^|[\s("'=])\/(?!\/)[^\s"'`)]+/gm, "$1[path]");
	return capDiagnosticTail(text, maximumBytes);
}

/** Spawn a fixed journey-owned gateway invocation without a shell. */
export function spawnGateway({ command = process.execPath, args, cwd, env, maxLogBytes = DEFAULT_LOG_TAIL_BYTES }) {
	if (!Array.isArray(args) || args.some(value => typeof value !== "string")) throw new TypeError("Gateway args must be strings");
	if (!cwd || !env || typeof env !== "object") throw new Error("Gateway spawn requires explicit cwd and env");
	const stdout = createTailBuffer(maxLogBytes);
	const stderr = createTailBuffer(maxLogBytes);
	const startedAt = performance.now();
	const child = spawn(command, args, {
		cwd,
		env,
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	const runtime = {
		child,
		startedAt,
		stdout,
		stderr,
		exited: false,
		closed: false,
		spawnError: null,
		shutdownStarted: false,
		posixGroupOwned: false,
		finalGroupSignalSent: false,
		diagnosticRedactions: diagnosticRedactions(cwd, env),
	};
	child.stdout?.on("data", chunk => stdout.push(chunk));
	child.stderr?.on("data", chunk => stderr.push(chunk));
	child.once("error", error => { runtime.spawnError = error; });
	child.once("exit", () => {
		runtime.exited = true;
		if (runtime.shutdownStarted && runtime.posixGroupOwned && process.platform !== "win32" && !runtime.finalGroupSignalSent) {
			forceExitedPosixGroup(runtime);
		}
	});
	child.once("close", () => { runtime.closed = true; });
	return runtime;
}

function rootExited(runtime) {
	return runtime.exited || runtime.child.exitCode !== null || runtime.child.signalCode !== null;
}

function signalOwnedTree(runtime, signal) {
	if (rootExited(runtime) || !runtime.child.pid) return { sent: false, error: null };
	if (process.platform === "win32") {
		const result = spawnSync("taskkill", ["/pid", String(runtime.child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
			timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
		});
		const error = result.error
			?? (result.status === 0 ? null : new Error(`taskkill exited with status ${result.status ?? "unknown"}`));
		return { sent: !error, error };
	}
	try {
		process.kill(-runtime.child.pid, 0);
		runtime.posixGroupOwned = true;
		process.kill(-runtime.child.pid, signal);
		return { sent: true, error: null };
	} catch (groupError) {
		try {
			const sent = runtime.child.kill(signal);
			return { sent, error: sent ? null : groupError };
		} catch (error) {
			return { sent: false, error };
		}
	}
}

function forceExitedPosixGroup(runtime) {
	const pid = runtime.child.pid;
	if (!pid || !runtime.posixGroupOwned || runtime.finalGroupSignalSent) return;
	try {
		process.kill(-pid, 0);
		process.kill(-pid, "SIGKILL");
	} catch { /* group already gone */ }
	runtime.finalGroupSignalSent = true;
}

function waitForClose(runtime, timeoutMs) {
	if (runtime.closed) return Promise.resolve(true);
	return new Promise(resolve => {
		let settled = false;
		const finish = value => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			runtime.child.removeListener("close", onClose);
			resolve(value);
		};
		const onClose = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		runtime.child.once("close", onClose);
		if (runtime.closed) finish(true);
	});
}

function releaseStdio(runtime) {
	for (const stream of [runtime.child.stdin, runtime.child.stdout, runtime.child.stderr]) {
		try { stream?.destroy(); } catch { /* containment after failed OS cleanup */ }
	}
	try { runtime.child.unref(); } catch { /* already exited */ }
}

function scheduledSampleIdentity(sample) {
	if (!sample || typeof sample !== "object") return null;
	const identity = {
		order: Number.isInteger(sample.order) && sample.order >= 0 ? sample.order : null,
		phase: typeof sample.phase === "string" ? sample.phase.slice(0, 32) : null,
		cycle: Number.isInteger(sample.cycle) && sample.cycle >= 0 ? sample.cycle : null,
		case: typeof sample.case === "string" ? sample.case.slice(0, 160) : null,
		caseOrder: Number.isInteger(sample.caseOrder) && sample.caseOrder >= 0 ? sample.caseOrder : null,
	};
	return identity.order === null ? null : identity;
}

/**
 * Capture only failure-safe child state. For an exited child, wait for `close`
 * first so both pipe tails include their final writes before they are formatted.
 */
export async function captureGatewayFailureDiagnostic(runtime, {
	sample = null,
	closeTimeoutMs = 8_000,
	redactions = [],
} = {}) {
	const identity = scheduledSampleIdentity(sample);
	if (!runtime || (!runtime.spawnError && !rootExited(runtime))) {
		return { sample: identity, childExit: null };
	}
	const pipesClosed = runtime.closed || await waitForClose(runtime, closeTimeoutMs);
	const allRedactions = [...(runtime.diagnosticRedactions ?? []), ...redactions];
	const output = sanitizeBenchmarkDiagnosticText(runtime.stdout?.text?.() ?? "", { redactions: allRedactions });
	const error = sanitizeBenchmarkDiagnosticText(runtime.stderr?.text?.() ?? "", { redactions: allRedactions });
	const spawnFailure = runtime.spawnError
		? sanitizeBenchmarkDiagnosticText(runtime.spawnError?.message ?? runtime.spawnError, {
			maximumBytes: 512,
			redactions: allRedactions,
		}).text
		: null;
	return {
		sample: identity,
		childExit: {
			exitCode: Number.isInteger(runtime.child?.exitCode) ? runtime.child.exitCode : null,
			signal: typeof runtime.child?.signalCode === "string" ? runtime.child.signalCode.slice(0, 32) : null,
			spawnFailure,
			pipesClosed,
			output: {
				tail: output.text,
				truncated: runtime.stdout?.truncated?.() === true || output.truncated,
			},
			error: {
				tail: error.text,
				truncated: runtime.stderr?.truncated?.() === true || error.truncated,
			},
		},
	};
}

async function gatewayExitError(message, runtime) {
	const error = new Error(message);
	error.benchmarkDiagnostic = await captureGatewayFailureDiagnostic(runtime);
	return error;
}

/** Probe the existing authenticated 503-to-200 readiness boundary. */
export async function waitForGatewayReady({
	runtime,
	baseUrl,
	token,
	timeoutMs = DEFAULT_GATEWAY_TIMEOUT_MS,
	pollIntervalMs = 50,
	fetchImpl = fetch,
	signal,
}) {
	const deadline = performance.now() + timeoutMs;
	let lastStatus = null;
	let lastError = null;
	while (performance.now() < deadline) {
		signal?.throwIfAborted();
		if (runtime.spawnError) throw await gatewayExitError("Gateway failed to spawn before readiness", runtime);
		if (rootExited(runtime)) {
			throw await gatewayExitError(`Gateway exited before readiness (code ${runtime.child.exitCode ?? "unknown"})`, runtime);
		}
		try {
			const probeSignal = AbortSignal.timeout(Math.min(2_000, Math.max(1, Math.ceil(deadline - performance.now()))));
			const response = await fetchImpl(new URL("api/health", baseUrl), {
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
				signal: signal ? AbortSignal.any([signal, probeSignal]) : probeSignal,
			});
			lastStatus = response.status;
			if (response.ok) return { readyMs: performance.now() - runtime.startedAt, status: response.status };
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			lastError = error;
		}
		await new Promise((resolve, reject) => {
			let settled = false;
			const finish = callback => value => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				callback(value);
			};
			const abort = finish(reject);
			const timer = setTimeout(finish(resolve), Math.min(pollIntervalMs, Math.max(1, Math.ceil(deadline - performance.now()))));
			if (signal?.aborted) abort(signal.reason);
			else signal?.addEventListener("abort", abort, { once: true });
		});
	}
	const detail = lastStatus === null ? String(lastError?.message ?? lastError ?? "no response") : `HTTP ${lastStatus}`;
	throw new Error(`Gateway readiness timed out after ${timeoutMs}ms (${detail})`);
}

/** Graceful HTTP shutdown, followed by owned process-tree escalation and close wait. */
export async function stopGateway(runtime, {
	baseUrl,
	token,
	graceMs = DEFAULT_STOP_GRACE_MS,
	forcedCloseMs = 8_000,
	fetchImpl = fetch,
} = {}) {
	if (!runtime || runtime.closed) return { graceful: true, forced: false, closed: true };
	let shutdownResponseError = null;
	if (baseUrl && !rootExited(runtime)) {
		// Claim the detached POSIX group before asking the root to exit. If the
		// HTTP shutdown closes the root while a descendant retains stdio, the
		// exit listener can safely finish that already-owned group at the exact
		// root-exit boundary without ever retargeting a later reused PGID.
		if (process.platform !== "win32" && runtime.child.pid) {
			try {
				process.kill(-runtime.child.pid, 0);
				runtime.posixGroupOwned = true;
				runtime.shutdownStarted = true;
			} catch { /* root may exit before the graceful request */ }
		}
		try {
			const response = await fetchImpl(new URL("api/shutdown", baseUrl), {
				method: "POST",
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
				signal: AbortSignal.timeout(Math.min(2_000, graceMs)),
			});
			if (!response.ok) shutdownResponseError = new Error(`Gateway shutdown returned HTTP ${response.status}`);
		} catch (error) { shutdownResponseError = error; }
		if (await waitForClose(runtime, graceMs)) return { graceful: true, forced: false, closed: true };
	}
	if (rootExited(runtime)) {
		if (await waitForClose(runtime, forcedCloseMs)) return { graceful: true, forced: false, closed: true };
		releaseStdio(runtime);
		throw new Error("Gateway root exited but its owned process tree did not close");
	}
	const term = signalOwnedTree(runtime, "SIGTERM");
	runtime.shutdownStarted ||= term.sent;
	if (await waitForClose(runtime, graceMs)) return { graceful: false, forced: true, closed: true };
	let forceError = term.error;
	if (!rootExited(runtime) && process.platform !== "win32") {
		const forced = signalOwnedTree(runtime, "SIGKILL");
		forceError ??= forced.error;
		runtime.finalGroupSignalSent = forced.sent;
	}
	if (await waitForClose(runtime, forcedCloseMs)) return { graceful: false, forced: true, closed: true };
	releaseStdio(runtime);
	const details = [shutdownResponseError, forceError].filter(Boolean).map(error => error?.message ?? String(error));
	throw new Error(`Gateway process tree did not close after forced termination${details.length ? ` (${details.join("; ")})` : ""}`);
}

export async function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Unable to allocate an IPv4 port"));
				return;
			}
			server.close(error => error ? reject(error) : resolve(address.port));
		});
	});
}

/** Lazily launch Chromium so the startup-only journey need not load Playwright. */
export async function launchBenchmarkBrowser({
	viewport = { width: 1280, height: 800 },
	launchOptions = {},
	playwrightLoader = () => import("playwright"),
	registerRuntime,
} = {}) {
	const partial = { browser: null, context: null, page: null, cdp: null, viewport };
	try {
		const { chromium } = await playwrightLoader();
		partial.browser = await chromium.launch({ headless: true, ...launchOptions });
		registerRuntime?.(partial);
		partial.context = await partial.browser.newContext({ viewport });
		registerRuntime?.(partial);
		partial.page = await partial.context.newPage();
		registerRuntime?.(partial);
		try { partial.cdp = await partial.context.newCDPSession(partial.page); } catch { /* optional Chromium metrics unsupported */ }
		registerRuntime?.(partial);
		return partial;
	} catch (error) {
		try {
			await closeBenchmarkBrowser(partial);
			registerRuntime?.(null);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], `Browser acquisition failed and rollback was incomplete: ${error?.message ?? error}; ${cleanupError?.message ?? cleanupError}`);
		}
		throw error;
	}
}

export async function closeBenchmarkBrowser(runtime) {
	if (!runtime) return;
	const errors = [];
	for (const [label, close] of [
		["CDP session", () => runtime.cdp?.detach()],
		["browser page", () => runtime.page?.close()],
		["browser context", () => runtime.context?.close()],
		["browser", () => runtime.browser?.close()],
	]) {
		try { await close(); } catch (error) { errors.push(new Error(`${label} close failed: ${error?.message ?? error}`, { cause: error })); }
	}
	if (runtime.browser && typeof runtime.browser.isConnected === "function" && runtime.browser.isConnected()) {
		errors.push(new Error("Browser remained connected after teardown"));
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, `Browser teardown failed: ${errors.map(error => error.message).join("; ")}`);
}

function parseProcessTime(value) {
	const text = String(value).trim();
	if (!text) return null;
	const parts = text.split(":").map(Number);
	if (parts.some(valuePart => !Number.isFinite(valuePart))) return null;
	if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1_000;
	if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1_000;
	return parts.length === 1 ? parts[0] * 1_000 : null;
}

/** Best-effort process-specific CPU/RSS metrics; unsupported values remain null. */
export async function readProcessMetrics(pid, {
	platform = process.platform,
	spawnSyncImpl = spawnSync,
	readFileImpl = readFile,
} = {}) {
	if (!Number.isInteger(pid) || pid <= 0) return { cpuTimeMs: null, peakRssBytes: null, rssBytes: null, reliability: "unsupported" };
	if (platform === "linux") {
		try {
			const [stat, status] = await Promise.all([
				readFileImpl(`/proc/${pid}/stat`, "utf8"),
				readFileImpl(`/proc/${pid}/status`, "utf8"),
			]);
			const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
			const utime = Number(fields[11]);
			const stime = Number(fields[12]);
			const ticksResult = spawnSyncImpl("getconf", ["CLK_TCK"], { encoding: "utf8" });
			const ticks = ticksResult?.status === 0 && !ticksResult?.error ? Number(String(ticksResult.stdout).trim()) : null;
			const cpuSupported = Number.isFinite(ticks) && ticks > 0
				&& Number.isFinite(utime) && utime >= 0
				&& Number.isFinite(stime) && stime >= 0;
			const highWaterKb = Number(status.match(/^VmHWM:\s+(\d+)\s+kB$/m)?.[1]);
			const currentKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
			const peakRssBytes = Number.isFinite(highWaterKb) ? highWaterKb * 1024 : null;
			const rssBytes = Number.isFinite(currentKb) ? currentKb * 1024 : null;
			return {
				cpuTimeMs: cpuSupported ? ((utime + stime) / ticks) * 1_000 : null,
				peakRssBytes,
				rssBytes,
				cpuReliability: cpuSupported ? "reliable" : "unsupported",
				peakRssReliability: peakRssBytes === null ? "unsupported" : "reliable",
				rssReliability: rssBytes === null ? "unsupported" : "reliable",
				reliability: cpuSupported && peakRssBytes !== null ? "reliable" : (cpuSupported || peakRssBytes !== null || rssBytes !== null ? "partial" : "unsupported"),
			};
		} catch { /* unsupported or process exited */ }
	}
	if (platform === "win32") {
		try {
			const script = `Get-Process -Id ${pid} | Select-Object CPU,PeakWorkingSet64,WorkingSet64 | ConvertTo-Json -Compress`;
			const result = spawnSyncImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				encoding: "utf8",
				windowsHide: true,
				timeout: 2_000,
			});
			const value = JSON.parse(result.stdout);
			const cpuTimeMs = Number.isFinite(value.CPU) ? value.CPU * 1_000 : null;
			const peakRssBytes = Number.isFinite(value.PeakWorkingSet64) ? value.PeakWorkingSet64 : null;
			const rssBytes = Number.isFinite(value.WorkingSet64) ? value.WorkingSet64 : null;
			return {
				cpuTimeMs,
				peakRssBytes,
				rssBytes,
				cpuReliability: cpuTimeMs === null ? "unsupported" : "lower-confidence",
				peakRssReliability: peakRssBytes === null ? "unsupported" : "lower-confidence",
				rssReliability: rssBytes === null ? "unsupported" : "lower-confidence",
				reliability: "lower-confidence",
			};
		} catch { /* unsupported or process exited */ }
	}
	if (platform === "darwin") {
		try {
			const result = spawnSyncImpl("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
			const cpuTimeMs = result.status === 0 && !result.error ? parseProcessTime(result.stdout) : null;
			if (cpuTimeMs !== null) return {
				cpuTimeMs,
				peakRssBytes: null,
				rssBytes: null,
				cpuReliability: "partial",
				peakRssReliability: "unsupported",
				rssReliability: "unsupported",
				reliability: "partial",
			};
		} catch { /* unsupported or process exited */ }
	}
	return {
		cpuTimeMs: null,
		peakRssBytes: null,
		rssBytes: null,
		cpuReliability: "unsupported",
		peakRssReliability: "unsupported",
		rssReliability: "unsupported",
		reliability: "unsupported",
	};
}
