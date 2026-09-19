import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { throwIfCleanupRejected } from "../../../e2e/test-utils/cleanup.js";

const CONTRACT_PREFIX = "WINDOWS_CLEANUP_CONTRACT";
const CLEANUP_MODULE_URL = new URL("../../../../scripts/testing-v2/owned-path-cleanup.mjs", import.meta.url).href;

type TraversalEvidence = {
	type: string;
	path: string;
	target?: string;
	action?: string;
	outcome?: string;
	operation?: string;
	code?: string;
};

type CleanupAttempt = {
	attempt: number;
	elapsedMs: number;
	code?: string;
	syscall?: string;
	path?: string;
	dest?: string;
	stage?: string;
	deadlineMs?: number;
	message?: string;
	traversal?: TraversalEvidence[];
};

type RemoveResult = {
	removed: boolean;
	attempts: number;
	history: CleanupAttempt[];
};

type RemoveOptions = {
	ownerRoot: string;
	allowOwnerRoot?: boolean;
	owner?: { kind: string; id: string };
	lifecycle?: Record<string, unknown>;
	platform?: NodeJS.Platform;
	maxAttempts?: number;
	deadlineMs?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	traversalConcurrency?: number;
	subprocessThreadPoolSize?: number;
	seams?: {
		remove?: (target: string, traversal: TraversalEvidence[]) => Promise<void>;
		fs?: Partial<{
			lstat: (target: string) => Promise<unknown>;
			readlink: (target: string) => Promise<string>;
			readdir: (target: string, options: { withFileTypes: true }) => Promise<unknown[]>;
			rmdir: (target: string) => Promise<void>;
			unlink: (target: string) => Promise<void>;
			rm: (target: string, options: { recursive: true; force: true }) => Promise<void>;
		}>;
		sleep?: (delayMs: number) => Promise<void>;
		now?: () => number;
	};
};

type ShutdownPhase = {
	name: string;
	owners: Array<() => void | Promise<void>>;
};

type OwnedCleanupControl = {
	child: EventEmitter & {
		send(message: unknown, callback: (error?: Error | null) => void): void;
	};
	ownershipReady: Promise<void>;
	killTree(signal?: "SIGTERM" | "SIGKILL", graceMs?: number): void;
	waitForTreeExit(timeoutMs?: number): Promise<boolean>;
};

type CleanupContract = {
	removeOwnedPath(target: string, options: RemoveOptions): Promise<RemoveResult>;
	removeOwnedPathInSubprocess(target: string, options: RemoveOptions, seams?: {
		forkProcess?: (...args: unknown[]) => EventEmitter & {
			send(message: unknown, callback: (error?: Error | null) => void): void;
			kill(signal?: string): boolean | void;
		};
		spawnOwned?: (
			modulePath: string,
			env: NodeJS.ProcessEnv,
			onSpawned: (tracked: OwnedCleanupControl) => void,
		) => OwnedCleanupControl | Promise<OwnedCleanupControl>;
		setTimer?: (callback: () => void, delayMs: number) => unknown;
		clearTimer?: (timer: unknown) => void;
		setJoinTimer?: (callback: () => void, delayMs: number) => unknown;
		clearJoinTimer?: (timer: unknown) => void;
		now?: () => number;
	}): Promise<RemoveResult>;
	shutdownResourcesThenRemove(options: {
		phases: ShutdownPhase[];
		remove: () => void | Promise<void>;
	}): Promise<void>;
};

async function loadCleanupContract(): Promise<CleanupContract> {
	let imported: Record<string, unknown>;
	try {
		imported = await import(/* @vite-ignore */ CLEANUP_MODULE_URL) as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			`${CONTRACT_PREFIX}_MISSING: expected shared cleanup module scripts/testing-v2/owned-path-cleanup.mjs (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	for (const name of ["removeOwnedPath", "removeOwnedPathInSubprocess", "shutdownResourcesThenRemove"] as const) {
		if (typeof imported[name] !== "function") {
			throw new Error(`${CONTRACT_PREFIX}_MISSING: shared cleanup module must export ${name}`);
		}
	}
	return imported as CleanupContract;
}

function fsError(
	code: string,
	target: string,
	message = `${code}: fixture removal failed`,
	dest?: string,
): NodeJS.ErrnoException {
	return Object.assign(new Error(message), {
		code,
		syscall: "rmdir",
		path: target,
		...(dest ? { dest } : {}),
	});
}

function controlledOwner(name: string, events: string[]) {
	let release!: () => void;
	let started!: () => void;
	const barrier = new Promise<void>(resolve => { release = resolve; });
	const didStart = new Promise<void>(resolve => { started = resolve; });
	return {
		didStart,
		release,
		async shutdown(): Promise<void> {
			events.push(`${name}:start`);
			started();
			await barrier;
			events.push(`${name}:end`);
		},
	};
}

describe("owned path cleanup contract", () => {
	it("isolates the filesystem pool and waits for the cleanup child to exit", async () => {
		const { removeOwnedPathInSubprocess } = await loadCleanupContract();
		const ownerRoot = path.resolve("subprocess-cleanup-owner");
		const child = new EventEmitter() as EventEmitter & {
			send(message: unknown, callback: (error?: Error | null) => void): void;
			kill(signal?: string): boolean | void;
		};
		let request: unknown;
		child.send = (message, callback) => {
			request = message;
			callback();
		};
		child.kill = vi.fn();
		const forkProcess = vi.fn(() => child);
		let settled = false;
		const running = removeOwnedPathInSubprocess(ownerRoot, {
			ownerRoot,
			allowOwnerRoot: true,
			subprocessThreadPoolSize: 32,
		}, { forkProcess });
		void running.then(() => { settled = true; });

		await Promise.resolve();
		expect(forkProcess).toHaveBeenCalledWith(
			expect.stringContaining("owned-path-cleanup.mjs"),
			["--owned-path-cleanup-child"],
			expect.objectContaining({
				env: expect.objectContaining({ UV_THREADPOOL_SIZE: "32" }),
				execArgv: [],
				stdio: ["ignore", "inherit", "inherit", "ipc"],
			}),
		);
		expect(request).toEqual({
			target: ownerRoot,
			options: { ownerRoot, allowOwnerRoot: true },
		});
		child.emit("message", { ok: true, result: { removed: true, attempts: 1, history: [] } });
		await Promise.resolve();
		expect(settled, "the parent must not settle while the cleanup process can still own filesystem work").toBe(false);
		child.emit("close", 0, null);
		await expect(running).resolves.toEqual({ removed: true, attempts: 1, history: [] });
		expect(settled).toBe(true);
	});

	it("escalates a timed-out owned tree and rejects only after close plus verified exit", async () => {
		const { removeOwnedPathInSubprocess } = await loadCleanupContract();
		const ownerRoot = path.resolve("stalled-subprocess-owner");
		const child = new EventEmitter() as OwnedCleanupControl["child"];
		let sendCallback: ((error?: Error | null) => void) | undefined;
		child.send = (_message, callback) => {
			sendCallback = callback;
			callback();
		};
		let proveForcedExit!: (exited: boolean) => void;
		const forcedExit = new Promise<boolean>(resolve => { proveForcedExit = resolve; });
		const control: OwnedCleanupControl = {
			child,
			ownershipReady: Promise.resolve(),
			killTree: vi.fn(),
			waitForTreeExit: vi.fn()
				.mockResolvedValueOnce(false)
				.mockImplementationOnce(() => forcedExit),
		};
		let now = 5_000;
		let deadlineCallback: (() => void) | undefined;
		const timerToken = {};
		const setTimer = vi.fn((callback: () => void, _delayMs: number) => {
			deadlineCallback = callback;
			return timerToken;
		});
		const clearTimer = vi.fn();
		let settled = false;
		const running = removeOwnedPathInSubprocess(ownerRoot, {
			ownerRoot,
			deadlineMs: 50,
			lifecycle: { gateway: "closed", watcher: "awaited" },
		}, {
			spawnOwned: (_modulePath, _env, onSpawned) => { onSpawned(control); return control; },
			setTimer,
			clearTimer,
			now: () => now,
		});
		void running.then(() => { settled = true; }, () => { settled = true; });
		await new Promise<void>(resolve => setImmediate(resolve));

		expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 1_050);
		now += 1_050;
		deadlineCallback!();
		await Promise.resolve();
		expect(control.killTree).toHaveBeenNthCalledWith(1, "SIGTERM", 250);
		expect(control.killTree).toHaveBeenNthCalledWith(2, "SIGKILL", 0);
		expect(settled, "signals are requests, not proof that deletion stopped").toBe(false);

		child.emit("close", null, "SIGKILL");
		await Promise.resolve();
		expect(settled, "close alone is not verified tree exit").toBe(false);
		proveForcedExit(true);
		const failure = await running.then(() => undefined, (error: unknown) => error) as Error & {
			code: string;
			stage: string;
			lifecycle: Record<string, unknown>;
		};
		expect(failure).toMatchObject({
			name: "OwnedPathCleanupSubprocessError",
			code: "ECLEANUPSUBPROCESSTIMEOUT",
			stage: "await-result",
			target: ownerRoot,
			ownerRoot,
			deadlineMs: 1_050,
			lifecycle: {
				cleanup: { gateway: "closed", watcher: "awaited" },
				subprocess: expect.objectContaining({
					terminationRequested: true,
					terminationReason: "await-result",
					treeExitVerified: true,
					treeExitAttempts: 2,
					closed: true,
					closeSignal: "SIGKILL",
					killAttempts: [
						expect.objectContaining({ signal: "SIGTERM", phase: "graceful", requested: true }),
						expect.objectContaining({ signal: "SIGKILL", phase: "forced", requested: true }),
					],
				}),
			},
		});
		expect(failure.message).toContain(path.basename(ownerRoot));
		expect(clearTimer).toHaveBeenCalledWith(timerToken);

		// Even hostile late callbacks cannot act on the tree after settlement.
		sendCallback!(new Error("late send failure"));
		deadlineCallback!();
		child.emit("message", { unexpected: "late result" });
		expect(control.killTree).toHaveBeenCalledTimes(2);
	});

	it("reports bounded termination diagnostics when tree exit cannot be proven", async () => {
		const { removeOwnedPathInSubprocess } = await loadCleanupContract();
		const ownerRoot = path.resolve("unverified-subprocess-owner");
		const child = new EventEmitter() as OwnedCleanupControl["child"];
		child.send = (_message, callback) => callback();
		const control: OwnedCleanupControl = {
			child,
			ownershipReady: Promise.resolve(),
			killTree: vi.fn(),
			waitForTreeExit: vi.fn().mockResolvedValue(false),
		};
		let deadlineCallback!: () => void;
		const running = removeOwnedPathInSubprocess(ownerRoot, { ownerRoot, deadlineMs: 0 }, {
			spawnOwned: (_modulePath, _env, onSpawned) => { onSpawned(control); return control; },
			setTimer: callback => { deadlineCallback = callback; return {}; },
			clearTimer: () => {},
			now: () => 0,
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		deadlineCallback();

		const failure = await running.then(() => undefined, (error: unknown) => error);
		expect(failure).toMatchObject({
			code: "ECLEANUPSUBPROCESSTERMINATION",
			stage: "termination-proof-after-await-result",
			lifecycle: {
				subprocess: expect.objectContaining({
					treeExitVerified: false,
					treeExitAttempts: 2,
					closed: false,
					killAttempts: [
						expect.objectContaining({ signal: "SIGTERM", requested: true }),
						expect.objectContaining({ signal: "SIGKILL", requested: true }),
					],
				}),
			},
		});
		expect(control.waitForTreeExit).toHaveBeenNthCalledWith(1, 250);
		expect(control.waitForTreeExit).toHaveBeenNthCalledWith(2, 3_000);
	});

	it.each([
		{ stage: "send-request", acknowledgeSend: false, publishResult: false },
		{ stage: "await-close-after-result", acknowledgeSend: true, publishResult: true },
	])("enforces the same deadline when stalled at $stage", async ({ stage, acknowledgeSend, publishResult }) => {
		const { removeOwnedPathInSubprocess } = await loadCleanupContract();
		const ownerRoot = path.resolve(`stalled-${stage}`);
		const child = new EventEmitter() as EventEmitter & {
			send(message: unknown, callback: (error?: Error | null) => void): void;
			kill(signal?: string): boolean;
		};
		child.send = (_message, callback) => {
			if (acknowledgeSend) callback();
			if (publishResult) child.emit("message", { ok: true, result: { removed: true, attempts: 1, history: [] } });
		};
		child.kill = vi.fn(() => true);
		let deadlineCallback: (() => void) | undefined;
		const running = removeOwnedPathInSubprocess(ownerRoot, {
			ownerRoot,
			deadlineMs: 0,
		}, {
			forkProcess: () => child,
			setTimer: callback => {
				deadlineCallback = callback;
				return {};
			},
			clearTimer: () => {},
			now: () => 0,
		});
		await new Promise<void>(resolve => setImmediate(resolve));

		deadlineCallback!();
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		child.emit("close", null, "SIGKILL");
		await expect(running).rejects.toMatchObject({
			code: "ECLEANUPSUBPROCESSTIMEOUT",
			stage,
			lifecycle: {
				subprocess: expect.objectContaining({
					terminationReason: stage,
					closed: true,
				}),
			},
		});
	});

	it.each([
		{ name: "synchronous send throw", synchronous: true },
		{ name: "send callback failure", synchronous: false },
	])("terminates and drains the child after a $name", async ({ synchronous }) => {
		const { removeOwnedPathInSubprocess } = await loadCleanupContract();
		const ownerRoot = path.resolve(`send-failure-${synchronous ? "throw" : "callback"}`);
		const child = new EventEmitter() as EventEmitter & {
			send(message: unknown, callback: (error?: Error | null) => void): void;
			kill(signal?: string): boolean;
		};
		const sendFailure = new Error(`send ${synchronous ? "threw" : "callback failed"}`);
		child.send = (_message, callback) => {
			if (synchronous) throw sendFailure;
			callback(sendFailure);
		};
		child.kill = vi.fn(() => true);
		let settled = false;
		const running = removeOwnedPathInSubprocess(ownerRoot, { ownerRoot }, { forkProcess: () => child });
		void running.then(() => { settled = true; }, () => { settled = true; });
		await Promise.resolve();

		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		await Promise.resolve();
		expect(settled).toBe(false);
		child.emit("close", null, "SIGKILL");
		await expect(running).rejects.toMatchObject({
			code: "ECLEANUPSUBPROCESSSEND",
			stage: synchronous ? "send-request" : "send-request-callback",
			cause: sendFailure,
		});
		expect(child.kill).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ label: "BigInt", lifecycle: { sequence: 1n } },
		{ label: "circular data", lifecycle: (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })() },
	])("rejects JSON-incompatible $label before spawning", async ({ lifecycle }) => {
		const { removeOwnedPathInSubprocess } = await loadCleanupContract();
		const ownerRoot = path.resolve("json-incompatible-owner");
		const forkProcess = vi.fn();

		let failure: unknown;
		try {
			removeOwnedPathInSubprocess(ownerRoot, { ownerRoot, lifecycle }, { forkProcess });
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			code: "ECLEANUPIPCJSON",
			stage: "serialize-request",
			target: ownerRoot,
		});
		expect(forkProcess).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "missing", message: undefined, expectsKill: false, expectedCode: "ECLEANUPSUBPROCESSNORESULT" },
		{ label: "malformed", message: { ok: true, result: { removed: false } }, expectsKill: true, expectedCode: "ECLEANUPSUBPROCESSPROTOCOL" },
	])("rejects a $label child result with close evidence", async ({ message, expectsKill, expectedCode }) => {
		const { removeOwnedPathInSubprocess } = await loadCleanupContract();
		const ownerRoot = path.resolve(`result-${expectedCode}`);
		const child = new EventEmitter() as EventEmitter & {
			send(message: unknown, callback: (error?: Error | null) => void): void;
			kill(signal?: string): boolean;
		};
		child.send = (_request, callback) => callback();
		child.kill = vi.fn(() => true);
		const running = removeOwnedPathInSubprocess(ownerRoot, { ownerRoot }, { forkProcess: () => child });
		if (message !== undefined) child.emit("message", message);
		await Promise.resolve();
		expect(child.kill).toHaveBeenCalledTimes(expectsKill ? 1 : 0);
		child.emit("close", expectsKill ? null : 1, expectsKill ? "SIGKILL" : null);

		await expect(running).rejects.toMatchObject({
			code: expectedCode,
			target: ownerRoot,
			lifecycle: {
				subprocess: expect.objectContaining({ closed: true }),
			},
		});
	});

	it("retries transient Windows removal failures with capped exponential delays", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("fixture-run-root");
		const target = path.join(ownerRoot, "worker-a");
		const codes = ["EBUSY", "EPERM", "ENOTEMPTY"];
		const removals: string[] = [];
		const delays: number[] = [];
		let now = 1_000;

		const result = await removeOwnedPath(target, {
			ownerRoot,
			platform: "win32",
			maxAttempts: 5,
			deadlineMs: 500,
			initialDelayMs: 10,
			maxDelayMs: 40,
			seams: {
				remove: async candidate => {
					removals.push(candidate);
					const code = codes.shift();
					if (code) throw fsError(code, candidate);
				},
				sleep: async delayMs => {
					delays.push(delayMs);
					now += delayMs;
				},
				now: () => now,
			},
		});

		expect(result, `${CONTRACT_PREFIX}_TRANSIENT_RETRY: cleanup must eventually succeed`).toMatchObject({
			removed: true,
			attempts: 4,
		});
		expect(removals).toEqual([target, target, target, target]);
		expect(delays).toEqual([10, 20, 40]);
		expect(result.history.map(({ attempt, elapsedMs, code }) => ({ attempt, elapsedMs, code: code ?? "OK" }))).toEqual([
			{ attempt: 1, elapsedMs: 0, code: "EBUSY" },
			{ attempt: 2, elapsedMs: 10, code: "EPERM" },
			{ attempt: 3, elapsedMs: 30, code: "ENOTEMPTY" },
			{ attempt: 4, elapsedMs: 70, code: "OK" },
		]);
	});

	it("uses the default deadline budget beyond eight transient failures", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("default-policy-run-root");
		const target = path.join(ownerRoot, "locked-worker");
		const delays: number[] = [];
		let now = 1_000;
		let attempts = 0;

		const result = await removeOwnedPath(target, {
			ownerRoot,
			seams: {
				remove: async candidate => {
					attempts++;
					if (attempts <= 8) throw fsError("EBUSY", candidate, `locked-attempt-${attempts}`);
				},
				sleep: async delayMs => {
					delays.push(delayMs);
					now += delayMs;
				},
				now: () => now,
			},
		});

		expect(result).toMatchObject({ removed: true, attempts: 9 });
		expect(delays).toEqual([25, 50, 100, 200, 400, 500, 500, 500]);
		expect(result.history.map(({ attempt, elapsedMs, code }) => ({
			attempt,
			elapsedMs,
			code: code ?? "OK",
		}))).toEqual([
			{ attempt: 1, elapsedMs: 0, code: "EBUSY" },
			{ attempt: 2, elapsedMs: 25, code: "EBUSY" },
			{ attempt: 3, elapsedMs: 75, code: "EBUSY" },
			{ attempt: 4, elapsedMs: 175, code: "EBUSY" },
			{ attempt: 5, elapsedMs: 375, code: "EBUSY" },
			{ attempt: 6, elapsedMs: 775, code: "EBUSY" },
			{ attempt: 7, elapsedMs: 1_275, code: "EBUSY" },
			{ attempt: 8, elapsedMs: 1_775, code: "EBUSY" },
			{ attempt: 9, elapsedMs: 2_275, code: "OK" },
		]);
	});

	it.each([
		{ platform: "linux" as const, code: "ENOTEMPTY" },
		{ platform: "darwin" as const, code: "EPERM" },
	])("retries $code on $platform with the same bounded history", async ({ platform, code }) => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve(`${platform}-run-root`);
		const target = path.join(ownerRoot, "worker-a");
		const removals: string[] = [];
		const delays: number[] = [];
		let now = 1_000;

		const result = await removeOwnedPath(target, {
			ownerRoot,
			platform,
			maxAttempts: 3,
			deadlineMs: 100,
			initialDelayMs: 7,
			maxDelayMs: 20,
			seams: {
				remove: async candidate => {
					removals.push(candidate);
					if (removals.length === 1) throw fsError(code, candidate);
				},
				sleep: async delayMs => {
					delays.push(delayMs);
					now += delayMs;
				},
				now: () => now,
			},
		});

		expect(result).toMatchObject({ removed: true, attempts: 2 });
		expect(removals).toEqual([target, target]);
		expect(delays).toEqual([7]);
		expect(result.history.map(({ attempt, elapsedMs, code: attemptCode }) => ({
			attempt,
			elapsedMs,
			code: attemptCode ?? "OK",
		}))).toEqual([
			{ attempt: 1, elapsedMs: 0, code },
			{ attempt: 2, elapsedMs: 7, code: "OK" },
		]);
	});

	it("does not retry after an overslept delay crosses the monotonic deadline", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("overslept-run-root");
		const target = path.join(ownerRoot, "locked-worker");
		const lifecycle = { processTree: "stopped", gateway: "closed" };
		let now = 2_000;
		const remove = vi.fn(async candidate => {
			if (remove.mock.calls.length === 1) {
				throw fsError("EBUSY", candidate, "worker lock still held");
			}
		});

		const failure = await removeOwnedPath(target, {
			ownerRoot,
			owner: { kind: "coordinator", id: "overslept-run" },
			lifecycle,
			platform: "win32",
			maxAttempts: 3,
			deadlineMs: 10,
			initialDelayMs: 5,
			seams: {
				remove,
				sleep: async () => { now += 11; },
				now: () => now,
			},
		}).then(() => undefined, (error: unknown) => error);

		expect(remove, `${CONTRACT_PREFIX}_ABSOLUTE_DEADLINE: cleanup must not retry after its deadline`).toHaveBeenCalledOnce();
		expect(failure).toMatchObject({
			name: "OwnedPathCleanupError",
			attempts: 1,
			elapsedMs: 11,
			lifecycle: {
				...lifecycle,
				cleanupDeadline: expect.objectContaining({
					code: "ECLEANUPDEADLINE",
					stage: "retry-delay",
				}),
			},
			history: [
				expect.objectContaining({
					attempt: 1,
					elapsedMs: 0,
					code: "EBUSY",
					message: "worker lock still held",
				}),
				expect.objectContaining({
					attempt: 1,
					elapsedMs: 11,
					code: "ECLEANUPDEADLINE",
					stage: "retry-delay",
				}),
			],
		});
		expect((failure as Error).message).toContain("overslept-run");
		expect((failure as Error).message).toContain("worker lock still held");
	});

	it("stops at the monotonic deadline and reports every failure plus lifecycle state", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("diagnostic-run-root");
		const target = path.join(ownerRoot, "locked-consumer");
		const destination = path.join(target, "rename-destination");
		const delays: number[] = [];
		let now = 5_000;
		let attempts = 0;

		const failure = await removeOwnedPath(target, {
			ownerRoot,
			owner: { kind: "coordinator", id: "run-42" },
			lifecycle: {
				browser: "closed",
				processTree: { pid: 4242, state: "termination-requested" },
				gateway: "close-pending",
			},
			platform: "win32",
			maxAttempts: 99,
			deadlineMs: 25,
			initialDelayMs: 10,
			maxDelayMs: 20,
			seams: {
				remove: async candidate => {
					attempts++;
					throw fsError(attempts === 1 ? "EBUSY" : "EPERM", candidate, `locked-attempt-${attempts}`, destination);
				},
				sleep: async delayMs => {
					delays.push(delayMs);
					now += delayMs;
				},
				now: () => now,
			},
		}).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure, `${CONTRACT_PREFIX}_DEADLINE_DIAGNOSTICS: terminal cleanup must reject`).toBeInstanceOf(Error);
		expect(attempts).toBe(2);
		expect(delays).toEqual([10]);
		const diagnostic = failure as Error & {
			target?: string;
			ownerRoot?: string;
			attempts?: number;
			elapsedMs?: number;
			history?: CleanupAttempt[];
			lifecycle?: Record<string, unknown>;
		};
		expect(diagnostic).toMatchObject({
			target,
			ownerRoot,
			attempts: 2,
			elapsedMs: 10,
			lifecycle: {
				browser: "closed",
				processTree: { pid: 4242, state: "termination-requested" },
				gateway: "close-pending",
			},
		});
		expect(diagnostic.history).toEqual([
			expect.objectContaining({ attempt: 1, elapsedMs: 0, code: "EBUSY", syscall: "rmdir", path: target, dest: destination, message: "locked-attempt-1" }),
			expect.objectContaining({ attempt: 2, elapsedMs: 10, code: "EPERM", syscall: "rmdir", path: target, dest: destination, message: "locked-attempt-2" }),
		]);
		const text = diagnostic.message;
		for (const evidence of [target, ownerRoot, "run-42", "EBUSY", "EPERM", "locked-attempt-1", "locked-attempt-2", "4242", "close-pending"]) {
			expect(text, `${CONTRACT_PREFIX}_DEADLINE_DIAGNOSTICS: missing ${evidence}`).toContain(evidence);
		}
	});

	it("does not retry non-transient failures and treats an already absent target as removed", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("error-policy-run-root");
		const rejectedTarget = path.join(ownerRoot, "rejected");
		const absentTarget = path.join(ownerRoot, "absent");
		const sleep = vi.fn(async () => {});
		const rejectRemove = vi.fn(async () => { throw fsError("EIO", rejectedTarget); });

		const failure = await removeOwnedPath(rejectedTarget, {
			ownerRoot,
			platform: "win32",
			maxAttempts: 5,
			seams: { remove: rejectRemove, sleep, now: () => 0 },
		}).then(() => undefined, (error: unknown) => error);
		expect(failure, `${CONTRACT_PREFIX}_ERROR_POLICY: EIO must fail immediately`).toBeInstanceOf(Error);
		expect(rejectRemove).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();

		const absent = await removeOwnedPath(absentTarget, {
			ownerRoot,
			platform: "win32",
			seams: {
				remove: async () => { throw fsError("ENOENT", absentTarget); },
				sleep,
				now: () => 0,
			},
		});
		expect(absent).toMatchObject({ removed: true, attempts: 1 });
		expect(sleep).not.toHaveBeenCalled();
	});

	it("rejects non-owned paths and requires explicit permission to remove the owner root", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("ownership-run-root");
		const sibling = path.resolve(`${ownerRoot}-sibling`);
		const remove = vi.fn(async () => {});

		await expect(removeOwnedPath(sibling, {
			ownerRoot,
			seams: { remove },
		}), `${CONTRACT_PREFIX}_OWNERSHIP: sibling-prefix escape must be rejected`).rejects.toThrow(/owned|contain|outside|refus/i);
		await expect(removeOwnedPath(ownerRoot, {
			ownerRoot,
			seams: { remove },
		}), `${CONTRACT_PREFIX}_OWNERSHIP: workers must not remove the coordinator root`).rejects.toThrow(/owner root|coordinator|permission|refus/i);
		expect(remove).not.toHaveBeenCalled();

		await expect(removeOwnedPath(ownerRoot, {
			ownerRoot,
			allowOwnerRoot: true,
			owner: { kind: "coordinator", id: "coordinator-7" },
			seams: { remove },
		})).resolves.toMatchObject({ removed: true, attempts: 1 });
		expect(remove).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledWith(ownerRoot, []);
	});

	it.each([
		{ platform: "win32" as const, linkType: "junction" as const, enabled: process.platform === "win32" },
		{ platform: process.platform, linkType: "dir" as const, enabled: process.platform !== "win32" },
	].filter(testCase => testCase.enabled))("removes a real $linkType without traversing its external sentinel", async ({ platform, linkType }) => {
		const { removeOwnedPath } = await loadCleanupContract();
		const fixtureBase = await mkdtemp(path.join(os.tmpdir(), "bobbit-owned-cleanup-"));
		const external = await mkdtemp(path.join(os.tmpdir(), "bobbit-owned-cleanup-sentinel-"));
		const sentinel = path.join(external, "keep.txt");
		await writeFile(sentinel, "external sentinel");

		try {
			for (const targetKind of ["child", "coordinator-root"] as const) {
				const ownerRoot = path.join(fixtureBase, targetKind);
				const target = targetKind === "child" ? path.join(ownerRoot, "worker") : ownerRoot;
				const link = path.join(target, "node_modules");
				await mkdir(target, { recursive: true });
				await writeFile(path.join(target, "ordinary.txt"), "owned");
				await symlink(external, link, linkType);

				const result = await removeOwnedPath(target, {
					ownerRoot,
					platform,
					...(targetKind === "coordinator-root"
						? { allowOwnerRoot: true, owner: { kind: "coordinator", id: "sentinel-test" } }
						: {}),
				});

				expect(await readFile(sentinel, "utf8")).toBe("external sentinel");
				await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
				const evidence = result.history.flatMap(attempt => attempt.traversal ?? []);
				expect(evidence).toEqual(expect.arrayContaining([
					expect.objectContaining({
						path: link,
						target: expect.any(String),
						action: "unlink",
						outcome: "removed",
					}),
				]));
			}
		} finally {
			// If an assertion interrupts the tested cleanup, unlink the view before
			// recursively removing fixture storage so the sentinel remains external.
			for (const link of [
				path.join(fixtureBase, "child", "worker", "node_modules"),
				path.join(fixtureBase, "coordinator-root", "node_modules"),
			]) {
				await unlink(link).catch(() => {});
			}
			await rm(fixtureBase, { recursive: true, force: true });
			await rm(external, { recursive: true, force: true });
		}
	});

	it.each([
		{ platform: "win32" as const, linkType: "junction" as const, enabled: process.platform === "win32" },
		{ platform: process.platform, linkType: "dir" as const, enabled: process.platform !== "win32" },
	].filter(testCase => testCase.enabled))("rejects owner-root $linkType rebinding after the target is captured", async ({ platform, linkType }) => {
		const { removeOwnedPath } = await loadCleanupContract();
		const fixtureBase = await mkdtemp(path.join(os.tmpdir(), "bobbit-owned-cleanup-root-rebind-"));
		const ownerRoot = path.join(fixtureBase, "owner");
		const detachedOwner = path.join(fixtureBase, "detached-owner");
		const target = path.join(ownerRoot, "worker", "tree");
		const sentinel = path.join(target, "keep.txt");
		const detachedSentinel = path.join(detachedOwner, "worker", "tree", "keep.txt");
		await mkdir(target, { recursive: true });
		await writeFile(sentinel, "external sentinel");
		let rebound = false;
		const unlinkEntry = vi.fn(unlink);
		const rmdirEntry = vi.fn(rmdir);

		try {
			const failure = await removeOwnedPath(target, {
				ownerRoot,
				platform,
				maxAttempts: 1,
				traversalConcurrency: 1,
				seams: {
					fs: {
						readdir: async (candidate, options) => {
							const entries = await readdir(candidate, options);
							if (!rebound && path.resolve(candidate) === path.resolve(target)) {
								rebound = true;
								await rename(ownerRoot, detachedOwner);
								await symlink(detachedOwner, ownerRoot, linkType);
							}
							return entries;
						},
						unlink: unlinkEntry,
						rmdir: rmdirEntry,
					},
				},
			}).then(() => undefined, (error: unknown) => error);

			expect(rebound).toBe(true);
			expect(failure).toMatchObject({
				name: "OwnedPathCleanupError",
				history: [expect.objectContaining({ code: "EUNSAFEPATH" })],
			});
			expect(unlinkEntry, "owner-root rebinding must fail before unlink").not.toHaveBeenCalled();
			expect(rmdirEntry, "owner-root rebinding must fail before rmdir").not.toHaveBeenCalled();
			expect(await readFile(detachedSentinel, "utf8")).toBe("external sentinel");
		} finally {
			if (rebound) await unlink(ownerRoot).catch(() => {});
			await rm(fixtureBase, { recursive: true, force: true });
		}
	});

	it("expires during first-attempt wide traversal and stops queue admission", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("deadline-wide-owner");
		const children = Array.from({ length: 2_000 }, (_, index) => `entry-${index}.txt`);
		const fakeDirectoryStats = {
			dev: 11,
			ino: 1,
			isDirectory: () => true,
			isSymbolicLink: () => false,
		};
		let ticks = 0;
		const lstatEntry = vi.fn(async () => fakeDirectoryStats);
		const readdirEntry = vi.fn(async () => children.map(name => ({ name })));
		const unlinkEntry = vi.fn(async () => {});
		const rmdirEntry = vi.fn(async () => {});

		const failure = await removeOwnedPath(ownerRoot, {
			ownerRoot,
			allowOwnerRoot: true,
			owner: { kind: "coordinator", id: "wide-deadline" },
			lifecycle: { coordinator: "groups-settled" },
			platform: "linux",
			deadlineMs: 40,
			traversalConcurrency: 32,
			seams: {
				now: () => ticks++,
				fs: {
					lstat: lstatEntry,
					readdir: readdirEntry,
					unlink: unlinkEntry,
					rmdir: rmdirEntry,
				},
			},
		}).then(() => undefined, (error: unknown) => error);

		expect(failure).toMatchObject({
			name: "OwnedPathCleanupError",
			attempts: 1,
			lifecycle: {
				coordinator: "groups-settled",
				cleanupDeadline: {
					code: "ECLEANUPDEADLINE",
					stage: "queue-admission-entry",
					deadlineMs: 40,
				},
			},
			history: [expect.objectContaining({
				code: "ECLEANUPDEADLINE",
				stage: "queue-admission-entry",
				deadlineMs: 40,
				path: expect.stringContaining("entry-"),
			})],
		});
		expect(readdirEntry).toHaveBeenCalledOnce();
		expect(lstatEntry.mock.calls.length).toBeLessThan(100);
		expect(unlinkEntry).not.toHaveBeenCalled();
		expect(rmdirEntry).not.toHaveBeenCalled();
		expect((failure as Error).message).toContain("ECLEANUPDEADLINE");
		expect((failure as Error).message).toContain("queue-admission-entry");
	});

	it("drains already-started metadata work at expiry and performs no calls after settlement", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("deadline-drain-owner");
		const childPaths = [path.join(ownerRoot, "a.txt"), path.join(ownerRoot, "b.txt")];
		const directoryStats = {
			dev: 12,
			ino: 1,
			isDirectory: () => true,
			isSymbolicLink: () => false,
		};
		const leafStats = (ino: number) => ({
			dev: 12,
			ino,
			isDirectory: () => false,
			isSymbolicLink: () => false,
		});
		let clock = 0;
		const releases = new Map<string, () => void>();
		const started = new Map<string, Promise<void>>();
		const startedResolvers = new Map<string, () => void>();
		for (const child of childPaths) {
			started.set(child, new Promise(resolve => startedResolvers.set(child, resolve)));
		}
		const calls: string[] = [];
		const lstatEntry = vi.fn(async (candidate: string) => {
			calls.push(`lstat:${candidate}`);
			if (candidate === ownerRoot) return directoryStats;
			const childIndex = childPaths.indexOf(candidate);
			if (childIndex < 0) throw fsError("ENOENT", candidate);
			startedResolvers.get(candidate)!();
			await new Promise<void>(resolve => releases.set(candidate, resolve));
			return leafStats(childIndex + 2);
		});
		const unlinkEntry = vi.fn(async (candidate: string) => { calls.push(`unlink:${candidate}`); });
		const rmdirEntry = vi.fn(async (candidate: string) => { calls.push(`rmdir:${candidate}`); });
		let settled = false;
		const running = removeOwnedPath(ownerRoot, {
			ownerRoot,
			allowOwnerRoot: true,
			owner: { kind: "coordinator", id: "drain-deadline" },
			platform: "linux",
			deadlineMs: 10,
			traversalConcurrency: 2,
			seams: {
				now: () => clock,
				fs: {
					lstat: lstatEntry,
					readdir: async () => childPaths.map(candidate => ({ name: path.basename(candidate) })),
					unlink: unlinkEntry,
					rmdir: rmdirEntry,
				},
			},
		});
		void running.then(() => { settled = true; }, () => { settled = true; });
		await Promise.all([...started.values()]);
		clock = 10;
		releases.get(childPaths[0])!();
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(settled, "cleanup must await every started filesystem operation").toBe(false);
		releases.get(childPaths[1])!();
		const failure = await running.then(() => undefined, (error: unknown) => error);
		expect(failure).toMatchObject({
			name: "OwnedPathCleanupError",
			history: [expect.objectContaining({
				code: "ECLEANUPDEADLINE",
				stage: "lstat",
				path: expect.stringMatching(/[ab]\.txt$/),
			})],
		});
		expect(unlinkEntry).not.toHaveBeenCalled();
		expect(rmdirEntry).not.toHaveBeenCalled();
		const callsAtSettlement = calls.length;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(calls).toHaveLength(callsAtSettlement);
	});

	it("keeps deep-tree metadata work linear and uses only the configured traversal concurrency", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("linear-cleanup-owner");
		const target = path.join(ownerRoot, "node_modules");
		type FakeNode = { kind: "directory" | "leaf"; ino: number; children: string[] };
		const nodes = new Map<string, FakeNode>();
		let nextIno = 1;
		const directory = (candidate: string, children: string[]) => {
			nodes.set(candidate, { kind: "directory", ino: nextIno++, children });
		};
		const leaf = (candidate: string) => {
			nodes.set(candidate, { kind: "leaf", ino: nextIno++, children: [] });
		};

		const depth = 80;
		directory(ownerRoot, [path.basename(target)]);
		let current = target;
		for (let index = 0; index < depth; index++) {
			const childDirectoryName = `d${index}`;
			const children = index === depth - 1 ? [`f${index}.js`] : [`f${index}.js`, childDirectoryName];
			directory(current, children);
			leaf(path.join(current, `f${index}.js`));
			if (index < depth - 1) current = path.join(current, childDirectoryName);
		}
		const entryCount = depth * 2;
		let lstatCalls = 0;
		let active = 0;
		let maxActive = 0;
		const fakeStats = (node: FakeNode) => ({
			dev: 1,
			ino: node.ino,
			isDirectory: () => node.kind === "directory",
			isSymbolicLink: () => false,
		});
		const missing = (candidate: string) => Object.assign(new Error(`missing: ${candidate}`), { code: "ENOENT", path: candidate });

		const result = await removeOwnedPath(target, {
			ownerRoot,
			platform: "linux",
			traversalConcurrency: 4,
			seams: {
				fs: {
					lstat: async candidate => {
						lstatCalls++;
						active++;
						maxActive = Math.max(maxActive, active);
						await new Promise<void>(resolve => setImmediate(resolve));
						active--;
						const node = nodes.get(candidate);
						if (!node) throw missing(candidate);
						return fakeStats(node);
					},
					readdir: async candidate => {
						const node = nodes.get(candidate);
						if (!node) throw missing(candidate);
						return node.children.map(name => ({ name }));
					},
					unlink: async candidate => {
						if (!nodes.delete(candidate)) throw missing(candidate);
					},
					rmdir: async candidate => {
						if (!nodes.delete(candidate)) throw missing(candidate);
					},
				},
			},
		});

		expect(result).toMatchObject({ removed: true, attempts: 1 });
		expect(nodes.has(target)).toBe(false);
		expect(maxActive).toBeGreaterThan(1);
		expect(maxActive).toBeLessThanOrEqual(4);
		expect(
			lstatCalls,
			`${CONTRACT_PREFIX}_LINEAR_TRAVERSAL: metadata work must stay O(entries), not O(entries × depth)`,
		).toBeLessThan(entryCount * 20);
	});

	it("fails closed before deleting through a replaced parent path", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = await mkdtemp(path.join(os.tmpdir(), "bobbit-owned-cleanup-replacement-"));
		const target = path.join(ownerRoot, "tree");
		const nested = path.join(target, "nested");
		const detached = path.join(ownerRoot, "detached-original");
		const replacement = path.join(ownerRoot, "replacement");
		const victim = path.join(nested, "victim.txt");
		await mkdir(nested, { recursive: true });
		await writeFile(victim, "owned");
		await mkdir(replacement);
		await writeFile(path.join(replacement, "victim.txt"), "external sentinel");
		let swapped = false;
		const unlinkEntry = vi.fn(unlink);

		try {
			const failure = await removeOwnedPath(target, {
				ownerRoot,
				traversalConcurrency: 1,
				seams: {
					fs: {
						lstat: async candidate => {
							const stats = await lstat(candidate);
							if (!swapped && path.resolve(candidate) === path.resolve(victim)) {
								swapped = true;
								await rename(nested, detached);
								await rename(replacement, nested);
							}
							return stats;
						},
						unlink: unlinkEntry,
					},
				},
			}).then(() => undefined, (error: unknown) => error);

			expect(swapped).toBe(true);
			expect(failure).toMatchObject({
				name: "OwnedPathCleanupError",
				history: [expect.objectContaining({ code: "EUNSAFEPATH" })],
			});
			expect(unlinkEntry, "replacement content must fail identity validation before unlink").not.toHaveBeenCalled();
			expect(await readFile(path.join(nested, "victim.txt"), "utf8")).toBe("external sentinel");
			expect(await readFile(path.join(detached, "victim.txt"), "utf8")).toBe("owned");
		} finally {
			await rm(ownerRoot, { recursive: true, force: true });
		}
	});

	it("fails closed when a directory reparse identity cannot be established", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("uncertain-reparse-run-root");
		const readlinkFailure = Object.assign(new Error("reparse query denied"), {
			code: "EIO",
			syscall: "readlink",
			path: ownerRoot,
		});
		const recursiveRemove = vi.fn(async () => {});
		const readdir = vi.fn(async () => []);
		const unlinkEntry = vi.fn(async () => {});
		const rmdirEntry = vi.fn(async () => {});
		const fakeDirectoryStats = {
			dev: 7,
			ino: 42,
			isDirectory: () => true,
			isSymbolicLink: () => false,
		};

		const failure = await removeOwnedPath(ownerRoot, {
			ownerRoot,
			allowOwnerRoot: true,
			owner: { kind: "coordinator", id: "uncertain-reparse" },
			platform: "win32",
			seams: {
				fs: {
					lstat: async () => fakeDirectoryStats,
					readlink: async () => { throw readlinkFailure; },
					readdir,
					unlink: unlinkEntry,
					rmdir: rmdirEntry,
					rm: recursiveRemove,
				},
			},
		}).then(() => undefined, (error: unknown) => error);

		expect(failure).toMatchObject({
			name: "OwnedPathCleanupError",
			attempts: 1,
			history: [expect.objectContaining({
				code: "EUNSAFEPATH",
				traversal: [expect.objectContaining({
					type: "reparse-detection-failure",
					path: ownerRoot,
					operation: "readlink-directory-probe",
					code: "EIO",
				})],
			})],
		});
		expect((failure as Error).message).toContain("reparse-detection-failure");
		expect((failure as Error).message).toContain("reparse query denied");
		expect(readdir).not.toHaveBeenCalled();
		expect(unlinkEntry).not.toHaveBeenCalled();
		expect(rmdirEntry).not.toHaveBeenCalled();
		expect(recursiveRemove, "an unresolved reparse point must never reach a recursive remover").not.toHaveBeenCalled();
	});

	it("preserves concurrent cleanup causes and exposes every child diagnostic", async () => {
		const { removeOwnedPath } = await loadCleanupContract();
		const ownerRoot = path.resolve("aggregate-diagnostics-run-root");
		const firstTarget = path.join(ownerRoot, "locked-first");
		const secondTarget = path.join(ownerRoot, "locked-second");
		const firstLifecycle = { gateway: "shutdown resolved", resource: "first watcher pending" };
		const secondLifecycle = { gateway: "shutdown resolved", resource: "second browser pending" };

		const results = await Promise.allSettled([
			removeOwnedPath(firstTarget, {
				ownerRoot,
				lifecycle: firstLifecycle,
				maxAttempts: 1,
				seams: {
					remove: async candidate => { throw fsError("EBUSY", candidate, "first path remained locked"); },
					now: () => 0,
				},
			}),
			removeOwnedPath(secondTarget, {
				ownerRoot,
				lifecycle: secondLifecycle,
				maxAttempts: 1,
				seams: {
					remove: async candidate => { throw fsError("EPERM", candidate, "second path denied"); },
					now: () => 0,
				},
			}),
		]);
		const originalReasons = results
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map(result => result.reason);

		let failure: unknown;
		try {
			throwIfCleanupRejected(results, "fixture path cleanup failed");
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(AggregateError);
		const aggregate = failure as AggregateError;
		expect(aggregate.errors).toHaveLength(2);
		expect(aggregate.errors[0]).toBe(originalReasons[0]);
		expect(aggregate.errors[1]).toBe(originalReasons[1]);
		for (const evidence of [
			firstTarget,
			secondTarget,
			"EBUSY",
			"EPERM",
			"history",
			"lifecycle",
			"first watcher pending",
			"second browser pending",
		]) {
			expect(aggregate.message, `aggregate diagnostic missing ${evidence}`).toContain(evidence);
		}
	});
});

describe("resource shutdown ordering", () => {
	it("does not begin removal until every ordered resource-owner barrier has settled", async () => {
		const { shutdownResourcesThenRemove } = await loadCleanupContract();
		const events: string[] = [];
		const browser = controlledOwner("browser", events);
		const server = controlledOwner("fixture-server", events);
		const processTree = controlledOwner("process-tree", events);
		const contexts = controlledOwner("mcp-watchers-contexts", events);
		const gateway = controlledOwner("gateway-http-ws", events);
		const remove = vi.fn(async () => { events.push("remove"); });

		const teardown = shutdownResourcesThenRemove({
			phases: [
				{ name: "browser", owners: [browser.shutdown] },
				{ name: "fixture-servers", owners: [server.shutdown] },
				{ name: "process-trees", owners: [processTree.shutdown] },
				{ name: "mcp-watchers-contexts", owners: [contexts.shutdown] },
				{ name: "gateway-http-ws", owners: [gateway.shutdown] },
			],
			remove,
		});

		await browser.didStart;
		expect(events).toEqual(["browser:start"]);
		expect(remove).not.toHaveBeenCalled();
		browser.release();

		await server.didStart;
		expect(events).toEqual(["browser:start", "browser:end", "fixture-server:start"]);
		expect(remove).not.toHaveBeenCalled();
		server.release();

		await processTree.didStart;
		expect(events.at(-1)).toBe("process-tree:start");
		expect(remove).not.toHaveBeenCalled();
		processTree.release();

		await contexts.didStart;
		expect(events.at(-1)).toBe("mcp-watchers-contexts:start");
		expect(remove).not.toHaveBeenCalled();
		contexts.release();

		await gateway.didStart;
		expect(events.at(-1)).toBe("gateway-http-ws:start");
		expect(remove).not.toHaveBeenCalled();
		gateway.release();

		await teardown;
		expect(events).toEqual([
			"browser:start", "browser:end",
			"fixture-server:start", "fixture-server:end",
			"process-tree:start", "process-tree:end",
			"mcp-watchers-contexts:start", "mcp-watchers-contexts:end",
			"gateway-http-ws:start", "gateway-http-ws:end",
			"remove",
		]);
	});

	it("drains later owners after a phase failure, aggregates diagnostics, and skips removal", async () => {
		const { shutdownResourcesThenRemove } = await loadCleanupContract();
		const events: string[] = [];
		const remove = vi.fn(async () => {});
		const failure = await shutdownResourcesThenRemove({
			phases: [
				{
					name: "process-trees",
					owners: [
						async () => { events.push("process-failed"); throw new Error("pid 4242 did not exit"); },
						async () => { events.push("process-peer-drained"); },
					],
				},
				{ name: "mcp-watchers-contexts", owners: [async () => { events.push("contexts-drained"); }] },
				{ name: "gateway-http-ws", owners: [async () => { events.push("gateway-drained"); }] },
			],
			remove,
		}).then(() => undefined, (error: unknown) => error);

		expect(events).toEqual(["process-failed", "process-peer-drained", "contexts-drained", "gateway-drained"]);
		expect(remove, `${CONTRACT_PREFIX}_SHUTDOWN_ORDER: unsafe deletion must not follow a failed owner shutdown`).not.toHaveBeenCalled();
		expect(failure, `${CONTRACT_PREFIX}_SHUTDOWN_ORDER: owner failures must be reported`).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/process-trees/i);
		expect((failure as Error).message).toContain("pid 4242 did not exit");
	});
});
