import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const CONTRACT_PREFIX = "WINDOWS_CLEANUP_CONTRACT";
const CLEANUP_MODULE_URL = new URL("../../../../scripts/testing-v2/owned-path-cleanup.mjs", import.meta.url).href;

type CleanupAttempt = {
	attempt: number;
	elapsedMs: number;
	code?: string;
	syscall?: string;
	path?: string;
	dest?: string;
	message?: string;
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
	seams?: {
		remove?: (target: string, options: { recursive: true; force: true }) => Promise<void>;
		sleep?: (delayMs: number) => Promise<void>;
		now?: () => number;
	};
};

type ShutdownPhase = {
	name: string;
	owners: Array<() => void | Promise<void>>;
};

type CleanupContract = {
	removeOwnedPath(target: string, options: RemoveOptions): Promise<RemoveResult>;
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
	for (const name of ["removeOwnedPath", "shutdownResourcesThenRemove"] as const) {
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
			lifecycle,
			history: [expect.objectContaining({
				attempt: 1,
				elapsedMs: 0,
				code: "EBUSY",
				message: "worker lock still held",
			})],
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
		expect(remove).toHaveBeenCalledWith(ownerRoot, { recursive: true, force: true });
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
