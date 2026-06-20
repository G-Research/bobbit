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
import { ModuleHost } from "../src/server/extension-host/module-host-worker.ts";
import { createServerHostApi } from "../src/server/extension-host/server-host-api.ts";
import { createPackStore } from "../src/server/extension-host/pack-store.ts";

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-hub-")));
}

let seq = 0;
function fixtureProvider(tmp: string, id: string, body: string, budget: { maxTokens?: number; timeoutMs?: number } = {}): ProviderContribution {
	const file = path.join(tmp, `${id}-${seq++}.mjs`);
	fs.writeFileSync(file, body);
	return {
		id,
		kind: "memory",
		module: path.basename(file),
		hooks: ["sessionSetup"],
		budget: { maxTokens: budget.maxTokens ?? 400, timeoutMs: budget.timeoutMs ?? 1_000 },
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
			const slow = fixtureProvider(tmp, "slow", `export default { async sessionSetup() { await new Promise((r) => setTimeout(r, 5000)); return { blocks: [{ id: "slow", title: "slow", authority: "memory", content: "late", reason: "r", priority: 10 }] }; } };`, { timeoutMs: 200 });
			const fast = fixtureProvider(tmp, "fast", `export default { async sessionSetup() { return { blocks: [{ id: "fast", title: "fast", authority: "memory", content: "ok", reason: "r", priority: 9 }] }; } };`);

			const t0 = performance.now();
			const result = await hub(tmp, [slow, fast], moduleHost).dispatch("sessionSetup", base(tmp));
			const elapsed = performance.now() - t0;

			// The slow provider sleeps 5000ms but its budget timeout is 200ms; the timeout
			// MUST cut it off so dispatch returns long before the sleep would finish. The
			// 3000ms bound is deliberately generous (vs the 5000ms sleep) so it stays green
			// under concurrent suite load while still proving the sleep was interrupted. The
			// timeout-actually-fired invariant is pinned precisely by the diagnostic below.
			assert.ok(elapsed < 3_000, `dispatch should return well before the 5000ms sleep (timeout cut it off), got ${elapsed}ms`);
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

	it("injects ctx.runtime for a provider with a runtime linkage and omits it otherwise", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			// Each provider echoes its received ctx.runtime so the test can assert injection.
			const echo = `export default { async sessionSetup(ctx) { return { blocks: [{ id: "rt", title: "rt", authority: "memory", priority: 1, reason: "r", content: JSON.stringify(ctx.runtime ?? null) }] }; } };`;
			const linked = fixtureProvider(tmp, "linked", echo);
			linked.runtime = "hindsight";
			linked.config = { mode: "managed", apiKey: "tok" };
			const unlinked = fixtureProvider(tmp, "unlinked", echo);

			const calls: Array<{ packId: string; runtimeId: string; config: Record<string, unknown> }> = [];
			const lifecycleHub = new LifecycleHub({
				registry: registry([linked, unlinked]),
				moduleHost,
				trace: new ContextTraceStore(path.join(tmp, "state")),
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "t" }),
				runtimeResolver: async ({ packId, runtimeId, config }) => {
					calls.push({ packId, runtimeId, config });
					return { baseUrl: "http://127.0.0.1:48080", headers: { Authorization: "Bearer tok" }, status: "running" };
				},
			});

			const result = await lifecycleHub.dispatch("sessionSetup", base(tmp));
			const byId = new Map(result.blocks.map((b) => [b.providerId, JSON.parse(b.content)]));
			assert.deepEqual(byId.get("linked"), { baseUrl: "http://127.0.0.1:48080", headers: { Authorization: "Bearer tok" }, status: "running" });
			assert.equal(byId.get("unlinked"), null, "a provider without a runtime linkage receives no ctx.runtime");
			// The resolver is consulted ONLY for the linked provider, with its runtimeId + config.
			assert.equal(calls.length, 1);
			assert.equal(calls[0].runtimeId, "hindsight");
			assert.equal(calls[0].config.mode, "managed");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("a runtime resolver that returns undefined / throws leaves ctx.runtime unset (non-fatal)", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const echo = `export default { async sessionSetup(ctx) { return { blocks: [{ id: "rt", title: "rt", authority: "memory", priority: 1, reason: "r", content: JSON.stringify(ctx.runtime ?? null) }] }; } };`;
			const absent = fixtureProvider(tmp, "absent", echo);
			absent.runtime = "hindsight";
			const boom = fixtureProvider(tmp, "boom", echo);
			boom.runtime = "hindsight";

			const hubAbsent = new LifecycleHub({
				registry: registry([absent]),
				moduleHost,
				trace: new ContextTraceStore(path.join(tmp, "state")),
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "t" }),
				runtimeResolver: async () => undefined,
			});
			const r1 = await hubAbsent.dispatch("sessionSetup", base(tmp));
			assert.equal(JSON.parse(r1.blocks[0].content), null, "undefined resolution leaves ctx.runtime unset");

			const hubThrow = new LifecycleHub({
				registry: registry([boom]),
				moduleHost,
				trace: new ContextTraceStore(path.join(tmp, "state")),
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "t" }),
				runtimeResolver: async () => { throw new Error("supervisor blew up"); },
			});
			const r2 = await hubThrow.dispatch("sessionSetup", base(tmp));
			assert.deepEqual(r2.diagnostics, [], "a resolver throw is non-fatal");
			assert.equal(JSON.parse(r2.blocks[0].content), null, "a resolver throw leaves ctx.runtime unset");
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
});
