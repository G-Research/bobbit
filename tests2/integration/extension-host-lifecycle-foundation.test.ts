import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enableTsWorkerResolver } from "../core/helpers/enable-ts-worker.ts";
import { ModuleHost, type InvokeRequest } from "../../src/server/extension-host/module-host-worker.ts";
import { createPackStore } from "../../src/server/extension-host/pack-store.ts";
import { createServerHostApi } from "../../src/server/extension-host/server-host-api.ts";
import type { StoreMutationOptions } from "../../src/shared/extension-host/host-api.ts";

enableTsWorkerResolver();
beforeAll(() => { enableTsWorkerResolver(); });

function fixtureRoot(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "extension-host-lifecycle-")));
}

describe("extension-host lifecycle foundation", () => {
	it("forwards the host-owned deadline as worker-local deadline metadata and AbortSignal", async () => {
		const root = fixtureRoot();
		const file = path.join(root, "provider.mjs");
		fs.writeFileSync(file, `export default { async sessionSetup(ctx) {
			return { hasSignal: !!ctx.signal && typeof ctx.signal.aborted === "boolean", deadlineEpochMs: ctx.deadline?.deadlineEpochMs, remaining: ctx.deadline?.remainingMs() };
		} };`);
		const deadlineEpochMs = Date.now() + 5_000;
		const host = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const result = await host.invoke({
				url: new URL(`file://${file}`).href,
				packRoot: root,
				epoch: 0,
				exportKind: "providers",
				member: "sessionSetup",
				ctx: { sessionId: "session-1", tool: "provider", capabilities: { callRoute: false, session: false, store: false, agents: false } } as unknown as InvokeRequest["ctx"],
				arg: undefined,
				workingDir: root,
				deadlineEpochMs,
			}, { deadlineEpochMs }) as { hasSignal: boolean; deadlineEpochMs: number; remaining: number };
			expect(result.hasSignal).toBe(true);
			expect(result.deadlineEpochMs).toBe(deadlineEpochMs);
			expect(result.remaining).toBeGreaterThan(0);
		} finally {
			host.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("exposes mutate to provider workers but replaces forged worker cancellation controls", async () => {
		const root = fixtureRoot();
		const file = path.join(root, "provider.mjs");
		const store = createPackStore({ rootDir: root });
		let received: StoreMutationOptions | undefined;
		const wrappedStore = {
			...store,
			mutate: async <T>(packId: string, key: string, value: T, opts?: StoreMutationOptions) => {
				received = opts;
				return store.mutate(packId, key, value, opts);
			},
		};
		const providerHost = createServerHostApi({
			sessionId: "session-1", packId: "foundation", contributionId: "providers/foundation",
			packStore: wrappedStore, capabilityMask: { store: true, session: false, agents: false },
		});
		fs.writeFileSync(file, `export default { async sessionSetup(ctx) {
			return ctx.host.store.mutate("record", { ok: true }, {
				expectedVersion: null, idempotencyKey: "worker-request",
				deadlineEpochMs: Date.now() + 86400000, signal: new AbortController().signal,
			});
		} };`);
		const deadlineEpochMs = Date.now() + 5_000;
		const host = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const result = await host.invoke({
				url: new URL(`file://${file}`).href, packRoot: root, epoch: 0, exportKind: "providers", member: "sessionSetup",
				ctx: { sessionId: "session-1", tool: "provider", host: providerHost, capabilities: { callRoute: false, session: false, store: true, agents: false } } as unknown as InvokeRequest["ctx"],
				arg: undefined, workingDir: root, deadlineEpochMs,
			}, { deadlineEpochMs });
			expect(result).toMatchObject({ status: "committed", committed: true, version: 1 });
			expect(received?.deadlineEpochMs).toBe(deadlineEpochMs);
			expect(received?.signal).toBeInstanceOf(AbortSignal);
			expect(await store.read("foundation", "record")).toMatchObject({ state: "present", value: { ok: true } });
		} finally {
			host.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fences queued unawaited provider puts and mutations after the invocation deadline", async () => {
		const root = fixtureRoot();
		const file = path.join(root, "provider.mjs");
		const store = createPackStore({ rootDir: root });
		await store.put("foundation", "put", "safe-put");
		await store.put("foundation", "mutate", "safe-mutate");
		let arrivals = 0;
		let arrived!: () => void;
		const bothArrived = new Promise<void>((resolve) => { arrived = resolve; });
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const wrappedStore = {
			...store,
			mutate: async <T>(packId: string, key: string, value: T, opts?: StoreMutationOptions) => {
				if (++arrivals === 2) arrived();
				await blocked;
				return store.mutate(packId, key, value, opts);
			},
		};
		const providerHost = createServerHostApi({
			sessionId: "session-1", packId: "foundation", contributionId: "providers/foundation",
			packStore: wrappedStore, capabilityMask: { store: true, session: false, agents: false },
		});
		fs.writeFileSync(file, `export default { async sessionSetup(ctx) {
			void ctx.host.store.put("put", "late-put", { deadlineEpochMs: Date.now() + 86400000 });
			void ctx.host.store.mutate("mutate", "late-mutate", { deadlineEpochMs: Date.now() + 86400000 });
			await new Promise((resolve) => setTimeout(resolve, 5000));
		} };`);
		const deadlineEpochMs = Date.now() + 1_500;
		const host = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const invocation = host.invoke({
				url: new URL(`file://${file}`).href, packRoot: root, epoch: 0, exportKind: "providers", member: "sessionSetup",
				ctx: { sessionId: "session-1", tool: "provider", host: providerHost, capabilities: { callRoute: false, session: false, store: true, agents: false } } as unknown as InvokeRequest["ctx"],
				arg: undefined, workingDir: root, deadlineEpochMs,
			}, { deadlineEpochMs });
			await bothArrived;
			await expect(invocation).rejects.toMatchObject({ status: 504 });
			release();
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(await store.get("foundation", "put")).toBe("safe-put");
			expect(await store.get("foundation", "mutate")).toBe("safe-mutate");
		} finally {
			release?.();
			host.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
