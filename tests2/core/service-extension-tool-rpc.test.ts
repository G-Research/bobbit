import { describe, expect, it } from "vitest";
import {
	ServiceToolAdapterRegistry,
	ServiceToolOperationScheduler,
	ServiceToolRpcError,
	validateServiceToolPayload,
	validateServiceToolRequest,
	validateServiceToolResponse,
	validateServiceToolResult,
} from "../../src/server/extension-host/service-extension-tool-rpc.ts";

const operation = {
	validatePayload: (value: unknown) => typeof value === "object" && value !== null && (value as { query?: unknown }).query === "ok",
	validateResult: (value: unknown) => typeof value === "object" && value !== null && (value as { count?: unknown }).count === 1,
};

function request(overrides: Record<string, unknown> = {}) {
	return { component: ".", serviceId: "language", operation: "search", payload: { query: "ok" }, ...overrides };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
	return { promise, resolve, reject };
}

describe("service extension tool RPC", () => {
	it("normalizes the closed request and clones bounded JSON values", () => {
		const input = request();
		const normalized = validateServiceToolRequest(input);
		expect(normalized).toEqual({ ...input, discriminator: "default" });
		expect(normalized.payload).not.toBe(input.payload);
		expect(validateServiceToolResponse({ state: "ready", value: { count: 1 } })).toEqual({ state: "ready", value: { count: 1 } });
	});

	it("rejects caller-selected identity fields, paths, invalid discriminators, and unbounded JSON", () => {
		let tooDeep: unknown = 1;
		for (let depth = 0; depth <= 16; depth++) tooDeep = { nested: tooDeep };
		for (const candidate of [
			{ ...request(), packId: "other" },
			request({ component: "../worktree" }),
			request({ serviceId: "../service" }),
			request({ discriminator: "TypeScript" }),
			request({ operation: "http://127.0.0.1" }),
			request({ payload: { query: "ok", nested: tooDeep } }),
		]) expect(() => validateServiceToolRequest(candidate)).toThrow(ServiceToolRpcError);
		expect(() => validateServiceToolResponse({ state: "ready", value: new Date() })).toThrow(ServiceToolRpcError);
	});

	it("resolves only a registered exact pack/service/discriminator operation", () => {
		const registry = new ServiceToolAdapterRegistry();
		registry.register({ packId: "test-pack", serviceId: "language", operations: { search: operation } });
		const resolved = registry.resolve("test-pack", request());
		expect(resolved.request.discriminator).toBe("default");
		expect(validateServiceToolPayload(resolved.operation, resolved.request.payload)).toEqual({ query: "ok" });
		expect(validateServiceToolResult(resolved.operation, { count: 1 })).toEqual({ count: 1 });
		expect(() => registry.resolve("other-pack", request())).toThrow(/unavailable/);
		expect(() => registry.resolve("test-pack", request({ operation: "fetch" }))).toThrow(/unavailable/);
		expect(() => validateServiceToolPayload(resolved.operation, { query: "no" })).toThrow(/payload is invalid/);
		expect(() => validateServiceToolResult(resolved.operation, { count: 2 })).toThrow(/result is invalid/);
	});

	it("runs an exact instance FIFO under the global cap", async () => {
		const scheduler = new ServiceToolOperationScheduler({ maxConcurrent: 1, maxQueuedPerInstance: 2 });
		const first = deferred<number>();
		const order: string[] = [];
		const one = scheduler.run("instance-a", async () => { order.push("first"); return first.promise; });
		const two = scheduler.run("instance-a", async () => { order.push("second"); return 2; });
		await new Promise(resolve => setImmediate(resolve));
		expect(order).toEqual(["first"]);
		first.resolve(1);
		await expect(one).resolves.toBe(1);
		await expect(two).resolves.toBe(2);
		expect(order).toEqual(["first", "second"]);
	});

	it("fences queued work and aborts active work when its exact instance changes", async () => {
		const scheduler = new ServiceToolOperationScheduler({ maxConcurrent: 1 });
		let aborted = false;
		const active = scheduler.run("instance-a", signal => new Promise<number>((_resolve, reject) => {
			signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
		}));
		const waiting = scheduler.run("instance-a", async () => 2);
		await new Promise(resolve => setImmediate(resolve));
		scheduler.invalidate("instance-a");
		await expect(active).rejects.toMatchObject({ code: "cancelled" });
		await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
		expect(aborted).toBe(true);
	});
});
