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

			assert.ok(elapsed < 1_000, `dispatch should return promptly, got ${elapsed}ms`);
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
