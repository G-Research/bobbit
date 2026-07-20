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

async function drainMicrotasks(turns = 8): Promise<void> {
	for (let turn = 0; turn < turns; turn++) await Promise.resolve();
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
});
