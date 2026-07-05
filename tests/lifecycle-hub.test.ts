import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ContextTraceStore } from "../src/server/agent/context-trace-store.ts";
import { LifecycleHub, type HookCtx } from "../src/server/agent/lifecycle-hub.ts";
import type { ProviderContribution } from "../src/server/agent/pack-contributions.ts";
import type { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import { ModuleHost, type InvokeRequest } from "../src/server/extension-host/module-host-worker.ts";
import { createServerHostApi } from "../src/server/extension-host/server-host-api.ts";
import { createPackStore } from "../src/server/extension-host/pack-store.ts";

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-hub-")));
}

let seq = 0;
// The per-provider budget timer in ModuleHost.invoke starts the moment the worker
// is CREATED, so it bounds worker-thread spawn + tsx transpilation of the bootstrap
// AND pack module, not just handler execution. In isolation that startup fits inside
// a tight budget, but under full-suite concurrent load (many tsx test processes each
// spawning module-host workers) it routinely exceeds ~1s — which used to 504 every
// non-timeout provider hook here (diagnostics flagged "timed out", blocks empty).
// Default to a generous 30s budget (matching ModuleHost's own default) so these
// tests assert PRODUCT behavior, not wall-clock worker-startup jitter. Tests that
// deliberately exercise the timeout path pass an explicit small `timeoutMs`.
function fixtureProvider(tmp: string, id: string, body: string, budget: { maxTokens?: number; timeoutMs?: number } = {}): ProviderContribution {
	const file = path.join(tmp, `${id}-${seq++}.mjs`);
	fs.writeFileSync(file, body);
	return {
		id,
		kind: "memory",
		module: path.basename(file),
		hooks: ["sessionSetup"],
		budget: { maxTokens: budget.maxTokens ?? 400, timeoutMs: budget.timeoutMs ?? 30_000 },
		config: { enabled: true },
		listName: id,
		sourceFile: path.join(tmp, "pack.yaml"),
		packRoot: tmp,
	};
}

/** Provider contribution for tests that stub `moduleHost.invoke` — no module
 * file is ever imported, so none is written. The module basename IS the
 * provider id, which is how the deferred-controlled stub host identifies which
 * invocation belongs to which provider (via `req.url`). */
function stubProvider(tmp: string, id: string, budget: { maxTokens?: number; timeoutMs: number }): ProviderContribution {
	return {
		id,
		kind: "memory",
		module: `${id}.mjs`,
		hooks: ["sessionSetup"],
		budget: { maxTokens: budget.maxTokens ?? 400, timeoutMs: budget.timeoutMs },
		config: { enabled: true },
		listName: id,
		sourceFile: path.join(tmp, "pack.yaml"),
		packRoot: tmp,
	};
}

function registry(providers: ProviderContribution[]): PackContributionRegistry {
	return { listProviders: () => providers } as unknown as PackContributionRegistry;
}

function base(tmp: string, sessionId = "sess-1"): Omit<HookCtx, "budget" | "config" | "gateway"> {
	return { sessionId, projectId: "project-1", scope: "project", cwd: tmp };
}

function hub(tmp: string, providers: ProviderContribution[], moduleHost: ModuleHost, globalMaxTokens = 4_000): LifecycleHub {
	return new LifecycleHub({
		registry: registry(providers),
		moduleHost,
		trace: new ContextTraceStore(path.join(tmp, "state")),
		gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
		globalMaxTokens,
	});
}

describe("LifecycleHub", () => {
	it("merges provider blocks, applies budgets, and forces provenance", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const p1 = fixtureProvider(tmp, "p1", `export default { async sessionSetup(ctx) { return { blocks: [{ id: "a", title: "A", providerId: "spoof", authority: "memory", content: "alpha " + ctx.sessionId, reason: "r1", priority: 10, tokenEstimate: 999 }] }; } };`);
			const p2 = fixtureProvider(tmp, "p2", `export default { async sessionSetup() { return { blocks: [{ id: "b", title: "B", authority: "skill", content: "beta", reason: "r2", priority: 9 }] }; } };`);

			const result = await hub(tmp, [p1, p2], moduleHost).dispatch("sessionSetup", base(tmp));

			assert.deepEqual(result.diagnostics, []);
			assert.deepEqual(result.blocks.map((b) => b.id), ["a", "b"]);
			assert.deepEqual(result.blocks.map((b) => b.providerId), ["p1", "p2"]);
			assert.equal(result.blocks[0].tokenEstimate, Math.ceil(result.blocks[0].content.length / 4));
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("times out one provider without preventing later providers", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			// The slow provider would take 30s to "complete"; its 200ms budget must cut it
		// off long before that. We keep the completion path far beyond any plausible
		// worker-startup time so the elapsed bound proves the timeout fired (rather than
		// asserting a tight wall-clock value that flakes when fast's worker startup is
		// slow under load). The timeout=true diagnostic + fast block are the wall-clock-
		// independent core assertions.
		const slow = fixtureProvider(tmp, "slow", `export default { async sessionSetup() { await new Promise((r) => setTimeout(r, 30000)); return { blocks: [{ id: "slow", title: "slow", authority: "memory", content: "late", reason: "r", priority: 10 }] }; } };`, { timeoutMs: 200 });
			const fast = fixtureProvider(tmp, "fast", `export default { async sessionSetup() { return { blocks: [{ id: "fast", title: "fast", authority: "memory", content: "ok", reason: "r", priority: 9 }] }; } };`);

			const t0 = performance.now();
			const result = await hub(tmp, [slow, fast], moduleHost).dispatch("sessionSetup", base(tmp));
			const elapsed = performance.now() - t0;

			// Far below the slow provider's 30s completion ⇒ the 200ms timeout cut it off,
			// yet generous enough to absorb fast's worker-startup jitter under load.
			assert.ok(elapsed < 5_000, `dispatch should return well before the slow provider's 30s completion, got ${elapsed}ms`);
			assert.equal(result.blocks.length, 1);
			assert.equal(result.blocks[0].providerId, "fast");
			assert.equal(result.diagnostics.length, 1);
			assert.equal(result.diagnostics[0].providerId, "slow");
			assert.equal(result.diagnostics[0].timeout, true);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("reports thrown provider errors and continues", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const bad = fixtureProvider(tmp, "bad", `export default { async sessionSetup() { throw new Error("boom"); } };`);
			const good = fixtureProvider(tmp, "good", `export default { async sessionSetup() { return { blocks: [{ id: "good", title: "good", authority: "memory", content: "ok", reason: "r", priority: 1 }] }; } };`);

			const result = await hub(tmp, [bad, good], moduleHost).dispatch("sessionSetup", base(tmp));

			assert.equal(result.blocks.length, 1);
			assert.equal(result.blocks[0].providerId, "good");
			assert.equal(result.diagnostics.length, 1);
			assert.equal(result.diagnostics[0].providerId, "bad");
			assert.match(result.diagnostics[0].error ?? "", /boom/);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("drops malformed blocks with a diagnostic while keeping valid blocks", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const provider = fixtureProvider(tmp, "mixed", `export default { async sessionSetup() { return { blocks: [null, { id: 1, title: "bad", authority: "memory", content: "x", reason: "r", priority: 1 }, { id: "ok", title: "ok", authority: "generic", content: "kept", reason: "r", priority: 2 }] }; } };`);

			const result = await hub(tmp, [provider], moduleHost).dispatch("sessionSetup", base(tmp));

			assert.deepEqual(result.blocks.map((b) => b.id), ["ok"]);
			assert.equal(result.diagnostics.length, 1);
			assert.equal(result.diagnostics[0].providerId, "mixed");
			assert.equal(result.diagnostics[0].error, "malformed block(s) dropped");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("provider hooks receive a store-only host: capabilities.store true, store round-trips, session/agents denied", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		const packStore = createPackStore({ rootDir: path.join(tmp, "state") });
		try {
			// The provider reads its capability flags, round-trips a value through
			// ctx.host.store, and confirms the masked-off session namespace is denied.
			const provider = fixtureProvider(tmp, "storeprov", `export default { async sessionSetup(ctx) {
				const caps = ctx.host.capabilities;
				const okStore = caps.store === true;
				const sessionFlag = caps.session === true;
				const agentsFlag = caps.agents === true;
				await ctx.host.store.put("marker", { v: ctx.sessionId });
				const got = await ctx.host.store.get("marker");
				let sessionDenied = false;
				try { await ctx.host.session.readTranscript(); } catch { sessionDenied = true; }
				return { blocks: [{ id: "store", title: "store", authority: "memory", priority: 1, reason: "r", content: JSON.stringify({ okStore, sessionFlag, agentsFlag, got, sessionDenied }) }] };
			} };`, { timeoutMs: 4_000 });

			const lifecycleHub = new LifecycleHub({
				registry: registry([provider]),
				moduleHost,
				trace: new ContextTraceStore(path.join(tmp, "state")),
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
				providerHostApi: ({ sessionId, packId }) => createServerHostApi({
					sessionId,
					packId,
					contributionId: "",
					packStore,
					capabilityMask: { store: true, session: false, agents: false },
				}),
			});

			const result = await lifecycleHub.dispatch("sessionSetup", base(tmp, "store-sess"));
			assert.deepEqual(result.diagnostics, []);
			assert.equal(result.blocks.length, 1);
			const payload = JSON.parse(result.blocks[0].content);
			assert.equal(payload.okStore, true, "capabilities.store === true for provider hooks");
			assert.equal(payload.sessionFlag, false, "session capability is false for provider hooks");
			assert.equal(payload.agentsFlag, false, "agents capability is false for provider hooks");
			assert.deepEqual(payload.got, { v: "store-sess" }, "store round-trips through the parent host");
			assert.equal(payload.sessionDenied, true, "masked-off session namespace is unavailable");

			// The value really landed in the pack-scoped store under the derived packId.
			const packId = path.basename(tmp);
			assert.deepEqual(await packStore.get(packId, "marker"), { v: "store-sess" });
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("records one trace entry per dispatch", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const trace = new ContextTraceStore(path.join(tmp, "state"));
			const provider = fixtureProvider(tmp, "p1", `export default { async sessionSetup() { return { blocks: [{ id: "ok", title: "ok", authority: "memory", content: "kept", reason: "r", priority: 1 }] }; } };`);
			const lifecycleHub = new LifecycleHub({
				registry: registry([provider]),
				moduleHost,
				trace,
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
			});

			await lifecycleHub.dispatch("sessionSetup", base(tmp, "trace-sess"));
			const rows = trace.readTrace("trace-sess");

			assert.equal(rows.length, 1);
			assert.equal(rows[0].hook, "sessionSetup");
			assert.equal(rows[0].sessionId, "trace-sess");
			assert.deepEqual(rows[0].providers.map((p) => ({ id: p.id, blocks: p.blocks, omitted: p.omitted })), [{ id: "p1", blocks: 1, omitted: 0 }]);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	// EXT-04 — shared-deadline fan-out. dispatch() used to await providers one at
	// a time (see FINDINGS.md EXT-04), so N providers' timeouts/latencies stacked
	// serially. These pins prove (a) providers now genuinely run concurrently and
	// (b) merged block/trace ORDER still reflects registration order, never
	// completion timing — the two properties the CLF coordination note calls out
	// as the ones a future parallel-dispatch consumer must not break.
	//
	// The concurrency seam is `moduleHost.invoke` — `dispatch()` either fans the
	// invokes out (`Promise.allSettled`) or awaits them one at a time; ModuleHost
	// itself spawns an independent worker PER invoke with no internal queue, so
	// LifecycleHub is the only place serialization could creep back in. These two
	// pins therefore stub ModuleHost with CONTROLLABLE DEFERREDS (the VER-07
	// precedent — see tests/verification-harness-parallel-reviews.test.ts): an
	// invocation only completes when the test releases it, so concurrency and
	// completion order are proven BY CONSTRUCTION. The former versions raced real
	// worker-thread spawn + tsx transpile against fixed wall-clock margins
	// (1200ms / 400ms sleeps), which flaked under full-suite concurrent load —
	// worker startup routinely ate the margin.
	it("dispatches providers concurrently against a shared deadline, not serial timeout-stacking", async () => {
		const tmp = tmpDir();
		try {
			// Deferred-controlled module host: records each invocation's provider id
			// + the per-invoke timeout it was handed, and holds the invocation OPEN
			// until the test releases it.
			const started: string[] = [];
			const timeouts = new Map<string, number | undefined>();
			const releases = new Map<string, (result: unknown) => void>();
			let onBothInFlight!: () => void;
			const bothInFlight = new Promise<void>((resolve) => { onBothInFlight = resolve; });
			const stubHost = {
				invoke(req: InvokeRequest, timeoutMs?: number): Promise<unknown> {
					const id = path.basename(new URL(req.url).pathname, ".mjs");
					started.push(id);
					timeouts.set(id, timeoutMs);
					if (started.length === 2) onBothInFlight();
					return new Promise((resolve) => { releases.set(id, resolve); });
				},
				dispose() {},
			} as unknown as ModuleHost;

			const first = stubProvider(tmp, "first", { timeoutMs: 1_000 });
			const second = stubProvider(tmp, "second", { timeoutMs: 2_000 });

			const dispatched = hub(tmp, [first, second], stubHost).dispatch("sessionSetup", base(tmp));
			let dispatchSettled = false;
			void dispatched.finally(() => { dispatchSettled = true; });

			// (a) CONCURRENCY, by construction: BOTH invocations are observed
			// in-flight while NEITHER has been released. Serial await-one-at-a-time
			// dispatch could never call invoke() for `second` until `first`
			// resolved — this await would deadlock (test timeout), it cannot
			// spuriously pass under load.
			await bothInFlight;
			assert.deepEqual([...started].sort(), ["first", "second"], "both providers in flight before any completion");

			// (b) SHARED deadline, not stacking: each invocation carries its OWN
			// provider budget as the per-invoke timeout (deadline enforcement is
			// delegated to ModuleHost per invoke, measured from its own start) —
			// there is no hub-level serial accumulation to stack.
			assert.equal(timeouts.get("first"), 1_000);
			assert.equal(timeouts.get("second"), 2_000);

			// Releasing only ONE provider must NOT settle dispatch — it waits for
			// the slowest (max of deadlines), not the first completion.
			releases.get("second")!({ blocks: [{ id: "second", title: "second", authority: "memory", content: "s", reason: "r", priority: 1 }] });
			await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
			assert.equal(dispatchSettled, false, "dispatch must still be pending while a provider is in flight");

			releases.get("first")!({ blocks: [{ id: "first", title: "first", authority: "memory", content: "f", reason: "r", priority: 1 }] });
			const result = await dispatched;
			assert.deepEqual(result.diagnostics, []);
			// Registration order preserved even though `second` completed first.
			assert.deepEqual(result.blocks.map((b) => b.id), ["first", "second"]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("keeps registration-order determinism when a later-registered provider finishes first", async () => {
		const tmp = tmpDir();
		try {
			const trace = new ContextTraceStore(path.join(tmp, "state"));
			// `slow` is registered FIRST but finishes LAST; `fast` is registered
			// SECOND but finishes FIRST — sequencing FORCED by deferreds (the old
			// version used a real 400ms sleep, which under load could invert and
			// silently stop exercising the finishes-first scenario). Equal
			// priority ⇒ the tie-break is original registration index, so both the
			// returned blocks AND the persisted trace row order must reflect
			// registration, never completion.
			const releases = new Map<string, (result: unknown) => void>();
			let onBothInFlight!: () => void;
			const bothInFlight = new Promise<void>((resolve) => { onBothInFlight = resolve; });
			const stubHost = {
				invoke(req: InvokeRequest): Promise<unknown> {
					const id = path.basename(new URL(req.url).pathname, ".mjs");
					return new Promise((resolve) => {
						releases.set(id, resolve);
						if (releases.size === 2) onBothInFlight();
					});
				},
				dispose() {},
			} as unknown as ModuleHost;

			const slow = stubProvider(tmp, "slow", { timeoutMs: 10_000 });
			const fast = stubProvider(tmp, "fast", { timeoutMs: 10_000 });

			const lifecycleHub = new LifecycleHub({
				registry: registry([slow, fast]),
				moduleHost: stubHost,
				trace,
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
			});

			const dispatched = lifecycleHub.dispatch("sessionSetup", base(tmp, "order-sess"));
			await bothInFlight;
			// GUARANTEED completion inversion: fast (registered second) fully
			// resolves before slow is released.
			releases.get("fast")!({ blocks: [{ id: "fast", title: "fast", authority: "memory", content: "f", reason: "r", priority: 5 }] });
			releases.get("slow")!({ blocks: [{ id: "slow", title: "slow", authority: "memory", content: "s", reason: "r", priority: 5 }] });

			const result = await dispatched;
			assert.deepEqual(result.blocks.map((b) => b.id), ["slow", "fast"]);

			const rows = trace.readTrace("order-sess");
			assert.deepEqual(rows[0].providers.map((p) => p.id), ["slow", "fast"]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	// EXT-06 — fair-share transparency. A provider that returned valid candidate
	// blocks but ends up with ZERO kept blocks purely because the shared budget
	// had no room left for it (no error, no timeout, nothing malformed) used to be
	// silent — see FINDINGS.md EXT-06. This pins the new starvation marker landing
	// in BOTH the returned diagnostics and the persisted context trace.
	it("marks a fully-starved provider (all its blocks lost to the shared budget) in diagnostics and the trace", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const trace = new ContextTraceStore(path.join(tmp, "state"));
			const big = fixtureProvider(tmp, "big", `export default { async sessionSetup() { return { blocks: [{ id: "big", title: "big", authority: "memory", content: "${"x".repeat(600)}", reason: "r", priority: 10 }] }; } };`);
			const small = fixtureProvider(tmp, "small", `export default { async sessionSetup() { return { blocks: [{ id: "small", title: "small", authority: "memory", content: "${"y".repeat(600)}", reason: "r", priority: 1 }] }; } };`);

			const lifecycleHub = new LifecycleHub({
				registry: registry([big, small]),
				moduleHost,
				trace,
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
				globalMaxTokens: 50,
			});

			const result = await lifecycleHub.dispatch("sessionSetup", base(tmp, "starve-sess"));

			assert.deepEqual(result.blocks.map((b) => b.id), ["big"]);
			const starvedDiag = result.diagnostics.find((d) => d.providerId === "small");
			assert.ok(starvedDiag, "the fully-starved provider should get a diagnostics entry");
			assert.match(starvedDiag!.error ?? "", /budget/i);

			const rows = trace.readTrace("starve-sess");
			const smallRow = rows[0].providers.find((p) => p.id === "small")!;
			assert.equal(smallRow.blocks, 0);
			assert.ok(smallRow.omitted > 0);
			assert.match(smallRow.error ?? "", /budget/i);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
