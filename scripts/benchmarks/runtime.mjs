import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";

export const RUN_PREFIX = "bobbit-benchmark-";
export const RUN_OWNER_MARKER = ".bobbit-benchmark-owner.json";
export const DEFAULT_GATEWAY_TIMEOUT_MS = 120_000;
export const DEFAULT_STOP_GRACE_MS = 5_000;
export const DEFAULT_LOG_TAIL_BYTES = 32 * 1024;

function isWithin(parent, candidate) {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalExistingDirectory(directory) {
	return realpathSync(path.resolve(directory));
}

function benchmarkTempParent(env, tempDirectory) {
	const inherited = env.BOBBIT_V2_RUN_ROOT?.trim();
	return canonicalExistingDirectory(inherited || tempDirectory);
}

/** Create the only recursively removable root used by a benchmark invocation. */
export async function createBenchmarkRunRoot({
	repoRoot = process.cwd(),
	env = process.env,
	tempDirectory = os.tmpdir(),
} = {}) {
	const parent = benchmarkTempParent(env, tempDirectory);
	const forbiddenState = path.join(path.resolve(repoRoot), ".bobbit");
	if (isWithin(forbiddenState, parent)) {
		throw new Error("Benchmark temporary roots may not use the repository .bobbit state tree");
	}
	const root = realpathSync(await mkdtemp(path.join(parent, RUN_PREFIX)));
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
		return { ...paths, ownerToken };
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
	if (!paths?.root || !paths?.samples || !isWithin(paths.root, paths.samples)) {
		throw new Error("Sample roots require owned benchmark paths");
	}
	const order = Number.isInteger(entry?.order) && entry.order >= 0 ? entry.order : 0;
	const directory = path.join(
		paths.samples,
		`${String(order).padStart(4, "0")}-${safeSegment(entry?.phase ?? "sample")}-${safeSegment(entry?.case ?? "case")}`,
	);
	if (!isWithin(paths.samples, directory)) throw new Error("Sample path escaped the owned samples root");
	await mkdir(directory, { recursive: false });
	if (fixtureRoot) {
		const canonicalFixture = realpathSync(path.resolve(fixtureRoot));
		if (!isWithin(paths.fixtures, canonicalFixture)) {
			throw new Error("Canonical fixtures must live beneath the owned fixture root");
		}
		await cp(canonicalFixture, path.join(directory, "fixture"), {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
	}
	return directory;
}

async function readOwner(paths) {
	const markerPath = path.join(paths.root, RUN_OWNER_MARKER);
	const marker = JSON.parse(await readFile(markerPath, "utf8"));
	if (marker?.ownerToken !== paths.ownerToken || marker?.pid !== process.pid) {
		throw new Error("Refusing to clean a benchmark root not owned by this process");
	}
}

/** Remove only an owner-marked benchmark root. */
export async function cleanupBenchmarkRunRoot(paths) {
	if (!paths?.root || !paths?.ownerToken) throw new Error("Missing benchmark root ownership metadata");
	if (!existsSync(paths.root)) return;
	const root = realpathSync(paths.root);
	if (path.basename(root).startsWith(RUN_PREFIX) !== true) {
		throw new Error("Refusing to clean a root without the benchmark prefix");
	}
	await readOwner({ ...paths, root });
	await rm(root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

export function createTailBuffer(maxBytes = DEFAULT_LOG_TAIL_BYTES) {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
	let buffer = Buffer.alloc(0);
	return {
		push(chunk) {
			const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			buffer = buffer.length === 0 ? next : Buffer.concat([buffer, next]);
			if (buffer.length > maxBytes) buffer = buffer.subarray(buffer.length - maxBytes);
		},
		text() { return buffer.toString("utf8"); },
		bytes() { return buffer.length; },
	};
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
	if (rootExited(runtime) || !runtime.child.pid) return false;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(runtime.child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		return true;
	}
	try {
		process.kill(-runtime.child.pid, 0);
		runtime.posixGroupOwned = true;
		process.kill(-runtime.child.pid, signal);
	} catch {
		try { runtime.child.kill(signal); } catch { /* process exited between observations */ }
	}
	return true;
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

/** Probe the existing authenticated 503-to-200 readiness boundary. */
export async function waitForGatewayReady({
	runtime,
	baseUrl,
	token,
	timeoutMs = DEFAULT_GATEWAY_TIMEOUT_MS,
	pollIntervalMs = 50,
	fetchImpl = fetch,
}) {
	const deadline = performance.now() + timeoutMs;
	let lastStatus = null;
	let lastError = null;
	while (performance.now() < deadline) {
		if (runtime.spawnError) throw new Error(`Gateway failed to spawn: ${runtime.spawnError.message}`, { cause: runtime.spawnError });
		if (rootExited(runtime)) {
			throw new Error(`Gateway exited before readiness (code ${runtime.child.exitCode ?? "unknown"})`);
		}
		try {
			const response = await fetchImpl(new URL("api/health", baseUrl), {
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
				signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, Math.ceil(deadline - performance.now())))),
			});
			lastStatus = response.status;
			if (response.ok) return { readyMs: performance.now() - runtime.startedAt, status: response.status };
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
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
	if (!runtime || runtime.closed) return { graceful: true, forced: false };
	if (baseUrl && !rootExited(runtime)) {
		try {
			await fetchImpl(new URL("api/shutdown", baseUrl), {
				method: "POST",
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
				signal: AbortSignal.timeout(Math.min(2_000, graceMs)),
			});
		} catch { /* signal escalation below remains authoritative */ }
		if (await waitForClose(runtime, graceMs)) return { graceful: true, forced: false };
	}
	if (rootExited(runtime)) {
		releaseStdio(runtime);
		return { graceful: true, forced: false };
	}
	runtime.shutdownStarted = signalOwnedTree(runtime, "SIGTERM");
	if (await waitForClose(runtime, graceMs)) return { graceful: true, forced: false };
	if (!rootExited(runtime) && process.platform !== "win32") {
		signalOwnedTree(runtime, "SIGKILL");
		runtime.finalGroupSignalSent = true;
	}
	const closed = await waitForClose(runtime, forcedCloseMs);
	if (!closed) releaseStdio(runtime);
	return { graceful: false, forced: true, closed };
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
export async function launchBenchmarkBrowser({ viewport = { width: 1280, height: 800 }, launchOptions = {} } = {}) {
	const { chromium } = await import("playwright");
	const browser = await chromium.launch({ headless: true, ...launchOptions });
	const context = await browser.newContext({ viewport });
	const page = await context.newPage();
	let cdp = null;
	try { cdp = await context.newCDPSession(page); } catch { /* optional Chromium metrics unsupported */ }
	return { browser, context, page, cdp, viewport };
}

export async function closeBenchmarkBrowser(runtime) {
	if (!runtime) return;
	try { await runtime.cdp?.detach(); } catch { /* best effort */ }
	try { await runtime.page?.close(); } catch { /* best effort */ }
	try { await runtime.context?.close(); } catch { /* best effort */ }
	try { await runtime.browser?.close(); } catch { /* best effort */ }
}

function parseProcessTime(value) {
	const parts = String(value).trim().split(":").map(Number);
	if (parts.some(valuePart => !Number.isFinite(valuePart))) return null;
	if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1_000;
	if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1_000;
	return parts.length === 1 ? parts[0] * 1_000 : null;
}

/** Best-effort process-specific CPU/RSS metrics; unsupported values remain null. */
export async function readProcessMetrics(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return { cpuTimeMs: null, peakRssBytes: null, rssBytes: null, reliability: "unsupported" };
	if (process.platform === "linux") {
		try {
			const [stat, status] = await Promise.all([
				readFile(`/proc/${pid}/stat`, "utf8"),
				readFile(`/proc/${pid}/status`, "utf8"),
			]);
			const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
			const ticksResult = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
			const ticks = Number(ticksResult.stdout) || 100;
			const highWaterKb = Number(status.match(/^VmHWM:\s+(\d+)\s+kB$/m)?.[1]);
			const currentKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
			return {
				cpuTimeMs: ((Number(fields[11]) + Number(fields[12])) / ticks) * 1_000,
				peakRssBytes: Number.isFinite(highWaterKb) ? highWaterKb * 1024 : null,
				rssBytes: Number.isFinite(currentKb) ? currentKb * 1024 : null,
				reliability: "reliable",
			};
		} catch { /* unsupported or process exited */ }
	}
	if (process.platform === "win32") {
		try {
			const script = `Get-Process -Id ${pid} | Select-Object CPU,PeakWorkingSet64,WorkingSet64 | ConvertTo-Json -Compress`;
			const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				encoding: "utf8",
				windowsHide: true,
				timeout: 2_000,
			});
			const value = JSON.parse(result.stdout);
			return {
				cpuTimeMs: Number.isFinite(value.CPU) ? value.CPU * 1_000 : null,
				peakRssBytes: Number.isFinite(value.PeakWorkingSet64) ? value.PeakWorkingSet64 : null,
				rssBytes: Number.isFinite(value.WorkingSet64) ? value.WorkingSet64 : null,
				reliability: "lower-confidence",
			};
		} catch { /* unsupported or process exited */ }
	}
	if (process.platform === "darwin") {
		try {
			const result = spawnSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
			return { cpuTimeMs: parseProcessTime(result.stdout), peakRssBytes: null, rssBytes: null, reliability: "partial" };
		} catch { /* unsupported or process exited */ }
	}
	return { cpuTimeMs: null, peakRssBytes: null, rssBytes: null, reliability: "unsupported" };
}
