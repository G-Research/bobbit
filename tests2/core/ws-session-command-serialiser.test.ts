import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionCommandSerialiser } from "../../src/server/ws/session-command-serialiser.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

interface BoundedSerialiser {
	readonly size: number;
	readonly pendingCount: number;
	readonly pendingBytes: number;
	readonly controlCount: number;
	cancelActive(key: string): boolean;
	run<T>(key: string, command: (signal: AbortSignal) => Promise<T> | T, retainedBytes?: number): Promise<T>;
	serialise<T>(key: string, command: (signal: AbortSignal) => Promise<T> | T, retainedBytes?: number): Promise<T>;
	serialiseControl(
		key: string,
		command: () => Promise<void> | void,
	): { promise: Promise<void>; created: boolean };
}

function boundedSerialiser(limits: { maxPendingCommands: number; maxPendingBytes: number }): BoundedSerialiser {
	const Constructor = SessionCommandSerialiser as unknown as new (
		limits: { maxPendingCommands: number; maxPendingBytes: number },
	) => BoundedSerialiser;
	return new Constructor(limits);
}

async function drainMicrotasks(turns = 8): Promise<void> {
	for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

function expectStructuredQueueRejection(
	result: Promise<unknown>,
	limit: "count" | "bytes",
): Promise<unknown> {
	return expect(result).rejects.toMatchObject({
		name: "SessionCommandQueueFullError",
		code: "SESSION_COMMAND_QUEUE_FULL",
		limit,
	});
}

describe("SessionCommandSerialiser", () => {
	it("starts same-session commands strictly in submission order", async () => {
		const serialiser = new SessionCommandSerialiser();
		const firstMayFinish = deferred<void>();
		const firstStarted = deferred<void>();
		const events: string[] = [];

		const first = serialiser.run("session-a", async () => {
			events.push("first:start");
			firstStarted.resolve();
			await firstMayFinish.promise;
			events.push("first:end");
			return 1;
		});
		const second = serialiser.run("session-a", async () => {
			events.push("second");
			return 2;
		});
		const third = serialiser.run("session-a", () => {
			events.push("third");
			return 3;
		});

		await firstStarted.promise;
		await drainMicrotasks();
		expect(events).toEqual(["first:start"]);

		firstMayFinish.resolve();
		await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
		expect(events).toEqual(["first:start", "first:end", "second", "third"]);
	});

	it("holds default-resume extension posts and later commands behind delayed mention preprocessing", async () => {
		const serialiser = new SessionCommandSerialiser();
		const releaseMentionProbe = deferred<void>();
		const mentionProbeStarted = deferred<void>();
		const events: string[] = [];

		const prompt = serialiser.serialise("session-a", async () => {
			events.push("prompt:preprocess:start");
			mentionProbeStarted.resolve();
			await releaseMentionProbe.promise;
			events.push("prompt:enqueue");
		});
		const extensionResume = serialiser.serialise("session-a", async () => {
			events.push("extension:enqueue");
		});
		const laterPrompt = serialiser.serialise("session-a", async () => {
			events.push("later:enqueue");
		});

		await mentionProbeStarted.promise;
		await drainMicrotasks();
		expect(events).toEqual(["prompt:preprocess:start"]);

		releaseMentionProbe.resolve();
		await Promise.all([prompt, extensionResume, laterPrompt]);
		expect(events).toEqual([
			"prompt:preprocess:start",
			"prompt:enqueue",
			"extension:enqueue",
			"later:enqueue",
		]);
	});

	it("allows another session to run while one session's mention preprocessing is delayed", async () => {
		const serialiser = new SessionCommandSerialiser();
		const sessionAMayFinish = deferred<void>();
		const sessionAStarted = deferred<void>();
		const events: string[] = [];

		const sessionA = serialiser.run("session-a", async () => {
			events.push("a:mention-preprocess:start");
			sessionAStarted.resolve();
			await sessionAMayFinish.promise;
			events.push("a:mention-preprocess:end");
		});
		await sessionAStarted.promise;

		const sessionB = serialiser.run("session-b", async () => {
			events.push("b:extension-resume");
			return "session-b-result";
		});
		await drainMicrotasks();

		expect(events).toEqual(["a:mention-preprocess:start", "b:extension-resume"]);
		await expect(sessionB).resolves.toBe("session-b-result");
		expect(events).toEqual(["a:mention-preprocess:start", "b:extension-resume"]);

		sessionAMayFinish.resolve();
		await sessionA;
		expect(events).toEqual([
			"a:mention-preprocess:start",
			"b:extension-resume",
			"a:mention-preprocess:end",
		]);
	});

	it("accepts active first commands across sessions even when retained frame bytes exceed pending limits", async () => {
		const serialiser = boundedSerialiser({ maxPendingCommands: 1, maxPendingBytes: 4 });
		const releaseA = deferred<void>();
		const releaseB = deferred<void>();
		const startedA = deferred<void>();
		const startedB = deferred<void>();

		const activeA = serialiser.run("session-a", async () => {
			startedA.resolve();
			await releaseA.promise;
		}, 1_000_000);
		await startedA.promise;
		const pendingA = serialiser.run("session-a", async () => "pending-a", 4);
		const activeB = serialiser.run("session-b", async () => {
			startedB.resolve();
			await releaseB.promise;
			return "active-b";
		}, 1_000_000);

		try {
			await startedB.promise;
			expect(serialiser.size).toBe(2);
			expect(serialiser.pendingCount).toBe(1);
			expect(serialiser.pendingBytes).toBe(4);
		} finally {
			releaseA.resolve();
			releaseB.resolve();
			await Promise.allSettled([activeA, pendingA, activeB]);
		}
		expect(serialiser.size).toBe(0);
		expect(serialiser.pendingCount).toBe(0);
		expect(serialiser.pendingBytes).toBe(0);
	});

	it("rejects pending-count overflow atomically without retaining a key or poisoning accepted work", async () => {
		const serialiser = boundedSerialiser({ maxPendingCommands: 2, maxPendingBytes: 100 });
		const releaseActive = deferred<void>();
		const activeStarted = deferred<void>();
		let rejectedCommandRan = false;
		const active = serialiser.run("session-a", async () => {
			activeStarted.resolve();
			await releaseActive.promise;
			return "active";
		}, 1_000);
		await activeStarted.promise;
		const pendingOne = serialiser.run("session-a", async () => "one", 10);
		const pendingTwo = serialiser.run("session-a", async () => "two", 20);
		const rejected = serialiser.run("session-a", async () => {
			rejectedCommandRan = true;
			return "must-not-run";
		}, 0);

		try {
			expect(serialiser.pendingCount).toBe(2);
			expect(serialiser.pendingBytes).toBe(30);
			await expectStructuredQueueRejection(rejected, "count");
			expect(rejectedCommandRan).toBe(false);
			expect(serialiser.pendingCount).toBe(2);
			expect(serialiser.pendingBytes).toBe(30);
			expect(serialiser.size).toBe(1);
		} finally {
			releaseActive.resolve();
			await Promise.allSettled([active, pendingOne, pendingTwo, rejected]);
		}
		expect(serialiser.size).toBe(0);
		expect(serialiser.pendingCount).toBe(0);
		expect(serialiser.pendingBytes).toBe(0);
	});

	it("rejects aggregate pending frame-byte overflow atomically and releases every retained byte", async () => {
		const serialiser = boundedSerialiser({ maxPendingCommands: 10, maxPendingBytes: 10 });
		const releaseActive = deferred<void>();
		const activeStarted = deferred<void>();
		let rejectedCommandRan = false;
		const active = serialiser.run("session-a", async () => {
			activeStarted.resolve();
			await releaseActive.promise;
		}, 1_000);
		await activeStarted.promise;
		const withinBudget = serialiser.run("session-a", async () => "within", 6);
		const rejected = serialiser.run("session-a", async () => {
			rejectedCommandRan = true;
		}, 5);

		try {
			expect(serialiser.pendingCount).toBe(1);
			expect(serialiser.pendingBytes).toBe(6);
			await expectStructuredQueueRejection(rejected, "bytes");
			expect(rejectedCommandRan).toBe(false);
			expect(serialiser.pendingCount).toBe(1);
			expect(serialiser.pendingBytes).toBe(6);
		} finally {
			releaseActive.resolve();
			await Promise.allSettled([active, withinBudget, rejected]);
		}
		expect(serialiser.size).toBe(0);
		expect(serialiser.pendingCount).toBe(0);
		expect(serialiser.pendingBytes).toBe(0);
	});

	it("drops pending accounting when work starts and isolates a queued rejection from later commands", async () => {
		const serialiser = boundedSerialiser({ maxPendingCommands: 3, maxPendingBytes: 12 });
		const releaseActive = deferred<void>();
		const activeStarted = deferred<void>();
		const rejectingStarted = deferred<void>();
		const rejectNow = deferred<void>();
		const failure = new Error("queued command failed");
		const active = serialiser.run("session-a", async () => {
			activeStarted.resolve();
			await releaseActive.promise;
		}, 100);
		await activeStarted.promise;
		const rejecting = serialiser.run("session-a", async () => {
			rejectingStarted.resolve();
			await rejectNow.promise;
			throw failure;
		}, 5);
		const later = serialiser.run("session-a", async () => "recovered", 7);

		try {
			expect(serialiser.pendingCount).toBe(2);
			expect(serialiser.pendingBytes).toBe(12);
			releaseActive.resolve();
			await rejectingStarted.promise;
			expect(serialiser.pendingCount).toBe(1);
			expect(serialiser.pendingBytes).toBe(7);
			rejectNow.resolve();
			await expect(rejecting).rejects.toBe(failure);
			await expect(later).resolves.toBe("recovered");
		} finally {
			releaseActive.resolve();
			rejectNow.resolve();
			await Promise.allSettled([active, rejecting, later]);
		}
		expect(serialiser.size).toBe(0);
		expect(serialiser.pendingCount).toBe(0);
		expect(serialiser.pendingBytes).toBe(0);
	});

	it("admits one deduplicated control command behind a saturated ordinary queue", async () => {
		const serialiser = boundedSerialiser({ maxPendingCommands: 2, maxPendingBytes: 10 });
		const releaseActive = deferred<void>();
		const activeStarted = deferred<void>();
		const events: string[] = [];
		let duplicateControlRan = false;

		const active = serialiser.run("session-a", async () => {
			events.push("active:start");
			activeStarted.resolve();
			await releaseActive.promise;
			events.push("active:end");
			return "active";
		}, 1_000);
		await activeStarted.promise;
		const pendingOne = serialiser.run("session-a", () => {
			events.push("pending:one");
			return "one";
		}, 4);
		const pendingTwo = serialiser.run("session-a", () => {
			events.push("pending:two");
			return "two";
		}, 6);
		const control = serialiser.serialiseControl("session-a", () => {
			events.push("control");
		});
		const duplicateControl = serialiser.serialiseControl("session-a", () => {
			duplicateControlRan = true;
		});
		const rejectedOrdinary = serialiser.run("session-a", () => "must-not-run", 0);

		try {
			expect(control.created).toBe(true);
			expect(duplicateControl.created).toBe(false);
			expect(duplicateControl.promise).toBe(control.promise);
			expect(serialiser.pendingCount).toBe(2);
			expect(serialiser.pendingBytes).toBe(10);
			expect(serialiser.controlCount).toBe(1);
			await expectStructuredQueueRejection(rejectedOrdinary, "count");
			expect(serialiser.pendingCount).toBe(2);
			expect(serialiser.pendingBytes).toBe(10);
			expect(serialiser.controlCount).toBe(1);

			releaseActive.resolve();
			await expect(Promise.all([
				active,
				pendingOne,
				pendingTwo,
				control.promise,
				duplicateControl.promise,
			])).resolves.toEqual(["active", "one", "two", undefined, undefined]);
			expect(events).toEqual([
				"active:start",
				"active:end",
				"pending:one",
				"pending:two",
				"control",
			]);
			expect(duplicateControlRan).toBe(false);
		} finally {
			releaseActive.resolve();
			await Promise.allSettled([
				active,
				pendingOne,
				pendingTwo,
				control.promise,
				duplicateControl.promise,
				rejectedOrdinary,
			]);
		}

		expect(serialiser.size).toBe(0);
		expect(serialiser.pendingCount).toBe(0);
		expect(serialiser.pendingBytes).toBe(0);
		expect(serialiser.controlCount).toBe(0);
		const freshControl = serialiser.serialiseControl("session-a", () => {});
		expect(freshControl.created).toBe(true);
		await expect(freshControl.promise).resolves.toBeUndefined();
		expect(serialiser.size).toBe(0);
		expect(serialiser.controlCount).toBe(0);
	});

	it("reserves before a synchronous control callback begins and deduplicates same-turn calls", async () => {
		const serialiser = boundedSerialiser({ maxPendingCommands: 1, maxPendingBytes: 1 });
		let controlRuns = 0;

		const first = serialiser.serialiseControl("session-a", () => {
			controlRuns += 1;
		});
		const sameTurnDuplicate = serialiser.serialiseControl("session-a", () => {
			controlRuns += 100;
		});

		expect(first.created).toBe(true);
		expect(sameTurnDuplicate.created).toBe(false);
		expect(sameTurnDuplicate.promise).toBe(first.promise);
		expect(controlRuns).toBe(0);
		expect(serialiser.controlCount).toBe(1);
		await expect(Promise.all([first.promise, sameTurnDuplicate.promise]))
			.resolves.toEqual([undefined, undefined]);
		expect(controlRuns).toBe(1);
		expect(serialiser.controlCount).toBe(0);
		expect(serialiser.size).toBe(0);

		const laterControl = serialiser.serialiseControl("session-a", () => {
			controlRuns += 1;
		});
		expect(laterControl.created).toBe(true);
		await expect(laterControl.promise).resolves.toBeUndefined();
		expect(controlRuns).toBe(2);
		expect(serialiser.controlCount).toBe(0);
		expect(serialiser.size).toBe(0);
	});

	it("cleans a rejected control slot and continues after synchronous command failures", async () => {
		const serialiser = boundedSerialiser({ maxPendingCommands: 1, maxPendingBytes: 8 });
		const activeFailure = new Error("synchronous active failure");
		const controlFailure = new Error("synchronous control failure");
		const events: string[] = [];
		let duplicateControlRan = false;

		const active = serialiser.run("session-a", () => {
			events.push("active:reject");
			throw activeFailure;
		});
		const control = serialiser.serialiseControl("session-a", () => {
			events.push("control:reject");
			throw controlFailure;
		});
		const duplicateControl = serialiser.serialiseControl("session-a", () => {
			duplicateControlRan = true;
		});
		const later = serialiser.run("session-a", () => {
			events.push("later");
			return "recovered";
		}, 8);

		expect(serialiser.controlCount).toBe(1);
		expect(serialiser.pendingCount).toBe(1);
		expect(serialiser.pendingBytes).toBe(8);
		expect(control.created).toBe(true);
		expect(duplicateControl.created).toBe(false);
		expect(duplicateControl.promise).toBe(control.promise);
		const outcomes = await Promise.allSettled([
			active,
			control.promise,
			duplicateControl.promise,
			later,
		]);
		expect(outcomes).toEqual([
			{ status: "rejected", reason: activeFailure },
			{ status: "rejected", reason: controlFailure },
			{ status: "rejected", reason: controlFailure },
			{ status: "fulfilled", value: "recovered" },
		]);
		expect(events).toEqual(["active:reject", "control:reject", "later"]);
		expect(duplicateControlRan).toBe(false);
		expect(serialiser.size).toBe(0);
		expect(serialiser.pendingCount).toBe(0);
		expect(serialiser.pendingBytes).toBe(0);
		expect(serialiser.controlCount).toBe(0);

		const retryControl = serialiser.serialiseControl("session-a", () => {});
		expect(retryControl.created).toBe(true);
		await expect(retryControl.promise).resolves.toBeUndefined();
		expect(serialiser.controlCount).toBe(0);
	});

	it("rejects only the failed command and continues the same-session queue", async () => {
		const serialiser = new SessionCommandSerialiser();
		const failure = new Error("command failed");
		const firstMayReject = deferred<void>();
		const firstStarted = deferred<void>();
		const events: string[] = [];

		const rejected = serialiser.run("session-a", async () => {
			events.push("rejecting:start");
			firstStarted.resolve();
			await firstMayReject.promise;
			throw failure;
		});
		const rejectionAssertion = expect(rejected).rejects.toBe(failure);
		const later = serialiser.run("session-a", async () => {
			events.push("later");
			return "recovered";
		});

		await firstStarted.promise;
		await drainMicrotasks();
		expect(events).toEqual(["rejecting:start"]);

		firstMayReject.resolve();
		await rejectionAssertion;
		await expect(later).resolves.toBe("recovered");
		expect(events).toEqual(["rejecting:start", "later"]);
	});

	it("removes keys once their command queues become idle", async () => {
		const serialiser = new SessionCommandSerialiser();
		const sessionAMayFinish = deferred<void>();
		const sessionBMayFinish = deferred<void>();

		const firstA = serialiser.run("session-a", () => sessionAMayFinish.promise);
		const secondA = serialiser.run("session-a", async () => "second-a");
		const sessionB = serialiser.run("session-b", () => sessionBMayFinish.promise);
		expect(serialiser.size).toBe(2);

		sessionBMayFinish.resolve();
		await sessionB;
		expect(serialiser.size).toBe(1);

		sessionAMayFinish.resolve();
		await expect(Promise.all([firstA, secondA])).resolves.toEqual([undefined, "second-a"]);
		expect(serialiser.size).toBe(0);
	});

	it("passes each command abort signal into both mention preflight and resolution", () => {
		const handlerSource = fs.readFileSync(
			new URL("../../src/server/ws/handler.ts", import.meta.url),
			"utf8",
		);
		expect(handlerSource).toMatch(
			/preflightFileMentionAdmission\(\s*msg\.text,\s*fileMentionCwd,\s*\{\s*signal:\s*commandSignal\s*\}\s*\)/s,
		);
		expect(handlerSource).toMatch(
			/resolveFileMentions\(\s*msg\.text,\s*fileMentionCwd,\s*\{\s*signal:\s*commandSignal\s*\}\s*\)/s,
		);
	});
});
