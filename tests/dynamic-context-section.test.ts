import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPromptSections, type PromptParts } from "../src/server/agent/system-prompt.js";
import { fenceBlock, type ContextBlock } from "../src/server/agent/context-blocks.js";
import { resolveDynamicContext, type SessionSetupPlan } from "../src/server/agent/session-setup.js";

function block(id: string, content: string): ContextBlock {
	return {
		id,
		title: `Title ${id}`,
		providerId: "provider-demo:demo",
		authority: "generic",
		content,
		reason: "fixture",
		priority: 10,
		tokenEstimate: Math.ceil(content.length / 4),
	};
}

function parts(overrides: Partial<PromptParts> = {}): PromptParts {
	return {
		cwd: "/tmp/dynamic-context-test",
		goalTitle: "Dynamic context goal",
		goalState: "in-progress",
		goalSpec: "Build dynamic context.",
		workflowContext: "# Upstream Gates\n\nDesign approved.",
		...overrides,
	};
}

describe("Dynamic Context prompt section", () => {
	it("renders fenced ContextBlocks as the final prompt-inspector section", () => {
		const blocks = [block("one", "first context"), block("two", "second context")];
		const sections = getPromptSections(parts({ dynamicContext: blocks }));
		const last = sections.at(-1);

		assert.ok(last, "expected at least one prompt section");
		assert.equal(last.label, "Dynamic Context");
		assert.equal(last.source, "providers");
		assert.equal(last.content, blocks.map(fenceBlock).join("\n\n"));
		assert.ok(last.tokens > 0, "expected Dynamic Context token estimate");
	});

	it("adds no section when dynamicContext is absent or empty", () => {
		const baseline = getPromptSections(parts());
		const absent = getPromptSections(parts({ dynamicContext: undefined }));
		const empty = getPromptSections(parts({ dynamicContext: [] }));

		assert.deepEqual(absent, baseline);
		assert.deepEqual(empty, baseline);
		assert.equal(baseline.some((section) => section.label === "Dynamic Context"), false);
	});

	it("short-circuits dynamic context resolution when no LifecycleHub is configured", async () => {
		const plan = {
			id: "session-no-hub",
			mode: "normal",
			title: "No hub",
			cwd: "/tmp/no-hub",
			bridgeOptions: { cwd: "/tmp/no-hub" },
		} as SessionSetupPlan;

		await resolveDynamicContext(plan, {} as any);

		assert.equal(plan.dynamicContextBlocks, undefined);
	});
});
