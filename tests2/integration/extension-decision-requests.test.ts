import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import { DecisionHookDispatcher, DecisionRequestManager } from "../../src/server/agent/decision-request-manager.js";
import { DecisionRequestStore } from "../../src/server/agent/decision-request-store.js";
import type { ValidatedExtensionDecisionRequest } from "../../src/server/agent/decision-hook-contract.js";
import type { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.js";
import type { ModuleHost } from "../../src/server/extension-host/module-host-worker.js";
import { createMemFs } from "../harness/mem-fs.js";

function request(key = "choice"): ValidatedExtensionDecisionRequest {
	return {
		version: 1, key, title: "Choose", question: "Choose one",
		options: [{ value: "safe", label: "Safe" }, { value: "fast", label: "Fast" }],
		other: { maxLength: 20 }, default: { kind: "option", value: "safe" },
		scope: "session", deadlineAt: new Date(Date.now() + 60_000).toISOString(), effect: { kind: "none" },
	};
}

function origin(overrides: Record<string, unknown> = {}) {
	return { projectId: "project", sessionId: "session", goalId: "goal", cwd: "/work", event: "beforePrompt" as const, packId: "pack", hookId: "hook", ...overrides };
}

describe("extension decision gateway seams", () => {
	it("isolates malformed answers and session-owned records without a prompt transport", async () => {
		const fs = createMemFs();
		const dir = path.join("/memfs", `decision-integration-${Date.now()}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const invalidations: string[] = [];
		const manager = new DecisionRequestManager({ storeForProject: () => store, invalidateSession: id => invalidations.push(id) });
		const created = await manager.create(origin(), request());
		assert.equal(created.status, "created");
		assert.equal(manager.get("project", created.requestId!)?.sessionId, "session");
		assert.equal((await manager.answer("project", created.requestId!, { kind: "option", value: "nope" })).status, "invalid");
		assert.equal(store.get(created.requestId!)?.status, "pending");
		assert.equal((await manager.answer("project", created.requestId!, { kind: "option", value: "fast" })).status, "resolved");
		assert.deepEqual(invalidations, ["session", "session"]);
	});

	it("requires a fresh decide grant before both dispatch and continuation", async () => {
		const fs = createMemFs();
		const dir = path.join("/memfs", `decision-grant-${Date.now()}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const manager = new DecisionRequestManager({ storeForProject: () => store });
		let granted = false;
		const hook = {
			id: "hook", mode: "decide", events: ["beforePrompt"], packRoot: "/packs/pack",
			sourceFile: "/packs/pack/hooks.yaml", module: "hook.mjs", capabilities: [], budget: { timeoutMs: 100, maxTokens: 1 },
		};
		const dispatcher = new DecisionHookDispatcher({
			manager,
			registry: { listHooks: () => [hook] } as unknown as PackContributionRegistry,
			moduleHost: { invoke: async () => ({ kind: "request", request: request() }) } as unknown as ModuleHost,
			grantsForProject: () => granted ? [{ packId: "pack", hookId: "hook", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "admin" }] : [],
		});
		assert.equal((await dispatcher.dispatch("beforePrompt", origin())).at(0)?.outcome, "denied");
		granted = true;
		await dispatcher.dispatch("beforePrompt", origin());
		const pending = store.listPending()[0]!;
		granted = false;
		assert.equal((await dispatcher.deliver({ ...pending, status: "resolved", resolution: { value: { kind: "option", value: "safe" }, actor: "user", reason: "answered" } })).toString(), "skipped");
	});
});
