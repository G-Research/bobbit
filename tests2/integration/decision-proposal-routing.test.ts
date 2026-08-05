import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import { DecisionRequestManager } from "../../src/server/agent/decision-request-manager.js";
import { DecisionRequestStore } from "../../src/server/agent/decision-request-store.js";
import type { ValidatedExtensionDecisionRequest } from "../../src/server/agent/decision-hook-contract.js";
import { createMemFs } from "../harness/mem-fs.js";

function proposalRequest(): ValidatedExtensionDecisionRequest {
	return {
		version: 1, key: "proposal", title: "Create draft", question: "Create a draft?",
		options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
		other: { maxLength: 20 }, default: { kind: "option", value: "no" }, scope: "goal",
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		effect: { kind: "proposal", proposals: {
			yes: { proposalType: "goal", args: { title: "Draft only" } },
			no: { proposalType: "goal", args: { title: "No draft" } },
			other: { proposalType: "goal", args: { title: "Other draft" } },
		} },
	};
}

describe("decision proposal routing", () => {
	it("creates only an editable proposal seed after the durable answer", async () => {
		const fs = createMemFs();
		const dir = path.join("/memfs", `decision-proposal-${Date.now()}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const calls: Array<{ sessionId: string; type: string; args: Record<string, unknown> }> = [];
		const manager = new DecisionRequestManager({
			storeForProject: () => store,
			proposalSeedService: {
				seedFromDecision: async (sessionId, type, args) => {
					calls.push({ sessionId, type, args });
					return { ok: true as const, status: 200 as const, rev: 4, fields: {} };
				},
			},
		});
		const created = await manager.create({ projectId: "project", sessionId: "session", goalId: "goal", cwd: "/work", event: "beforePrompt", packId: "pack", hookId: "hook" }, proposalRequest());
		assert.equal(store.get(created.requestId!)?.proposal, undefined);
		await manager.answer("project", created.requestId!, { kind: "option", value: "yes" });
		assert.deepEqual(calls, [{ sessionId: "session", type: "goal", args: { title: "Draft only" } }]);
		assert.deepEqual(store.get(created.requestId!)?.proposal, { status: "created", type: "goal", rev: 4 });
	});

	it("preserves the answer when proposal draft creation fails", async () => {
		const fs = createMemFs();
		const dir = path.join("/memfs", `decision-proposal-failure-${Date.now()}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const manager = new DecisionRequestManager({
			storeForProject: () => store,
			proposalSeedService: { seedFromDecision: async () => { throw new Error("isolated"); } },
		});
		const created = await manager.create({ projectId: "project", sessionId: "session", goalId: "goal", cwd: "/work", event: "beforePrompt", packId: "pack", hookId: "hook" }, proposalRequest());
		const result = await manager.answer("project", created.requestId!, { kind: "option", value: "yes" });
		assert.equal(result.status, "resolved");
		assert.equal(store.get(created.requestId!)?.proposal?.status, "failed");
	});
});
