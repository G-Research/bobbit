import assert from "node:assert/strict";
import { describe, it } from "vitest";

import provider, { type GraphProviderContext } from "../../market-packs/code-intelligence/src/provider.ts";
import type { GraphHookResult } from "../../market-packs/code-intelligence/src/graph-runtime.ts";

const unscopedContext: GraphProviderContext = {
	projectId: "project",
	goalId: "goal",
	cwd: "/workspace/project",
	worktreePath: "/workspace/project",
};

const empty: GraphHookResult = { blocks: [] };

function result(id: string, title: string, content: string): GraphHookResult {
	return { blocks: [{ id, title, authority: "generic", priority: 1, reason: "test", content }] };
}

describe("Code Intelligence lifecycle provider", () => {
	it("fails closed without a verified project scope while retaining one bounded session guidance block", async () => {
		for (const context of [unscopedContext, { ...unscopedContext, scopeContext: { project: { id: "other-project" } } }]) {
			assert.deepEqual(await provider.goalProvisioned(context), empty);
			assert.deepEqual(await provider.afterTurn(context), empty);

			const setup = await provider.sessionSetup(context);
			assert.equal(setup.blocks.length, 1);
			assert.equal(setup.blocks[0]?.id, "code-intelligence-review-guidance");
			assert.ok(setup.blocks[0]?.content.length <= 800);
		}
	});

	it("delegates every lifecycle hook to an injected runtime", async () => {
		const calls: string[] = [];
		const graphRuntime: NonNullable<GraphProviderContext["graphRuntime"]> = {
			goalProvisioned: async () => {
				calls.push("goalProvisioned");
				return result("provisioned", "Provisioned", "provisioned");
			},
			sessionSetup: async () => {
				calls.push("sessionSetup");
				return result("code-intelligence-orientation", "Orientation", "orientation");
			},
			afterTurn: async () => {
				calls.push("afterTurn");
				return result("after-turn", "After turn", "after turn");
			},
		};
		const context = { ...unscopedContext, graphRuntime };

		assert.equal((await provider.goalProvisioned(context)).blocks[0]?.id, "provisioned");
		assert.equal((await provider.sessionSetup(context)).blocks[0]?.id, "code-intelligence-orientation");
		assert.equal((await provider.afterTurn(context)).blocks[0]?.id, "after-turn");
		assert.deepEqual(calls, ["goalProvisioned", "sessionSetup", "afterTurn"]);
	});

	it("does not swallow an injected runtime hook failure", async () => {
		const context: GraphProviderContext = {
			...unscopedContext,
			graphRuntime: {
				goalProvisioned: async () => empty,
				sessionSetup: async () => { throw new Error("runtime hook failed"); },
				afterTurn: async () => empty,
			},
		};

		await assert.rejects(() => provider.sessionSetup(context), /runtime hook failed/);
	});
});
