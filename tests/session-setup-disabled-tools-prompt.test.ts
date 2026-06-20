/**
 * Regression: `bobbit.disabledTools` must be filtered OUT of the resolved
 * allowlist BEFORE the system prompt / tool-docs / skills catalog are assembled
 * and cached — not only later in resolveToolActivation. Otherwise the initial
 * system prompt and the persisted prompt-sections snapshot advertise a tool the
 * live tool surface has already removed (a "prompt leak").
 *
 * The fix lives in session-setup.ts::_resolvePrompt (applyDisabledToolsFilter is
 * applied for the normal/delegate branches AND re-applied after the assistant
 * branch recomputes its role-restricted allowlist). It MUST preserve the
 * `undefined` (unrestricted) vs `[]` (explicit no-tools) distinction: undefined
 * stays undefined, and a list filtered to nothing stays `[]` — never widened
 * back to all tools.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolvePrompt, type SessionSetupPlan } from "../src/server/agent/session-setup.ts";
import type { EffectiveTool } from "../src/server/agent/tool-activation.ts";

function tools(...names: string[]): EffectiveTool[] {
	return names.map(name => ({ kind: "yaml" as const, name }));
}

interface Captured { called: boolean; allowedTools?: string[]; }

function makeCtx(opts: {
	disabledTools?: string[];
	toolManager?: unknown;
	roleManager?: unknown;
	captured: Captured;
}): any {
	return {
		resolveGoalMetadata: (_goalId?: string) =>
			opts.disabledTools ? { "bobbit.disabledTools": opts.disabledTools } : {},
		goalManager: { getGoal: () => ({ title: "G", state: "in-progress", spec: "spec" }) },
		taskManager: { getTask: () => undefined },
		toolManager: opts.toolManager ?? null,
		roleManager: opts.roleManager ?? null,
		mcpManager: null,
		groupPolicyStore: null,
		configCascade: null,
		projectConfigStore: null,
		systemPromptPath: undefined,
		buildWorkflowList: () => "",
		assemblePrompt: (_id: string, p: { allowedTools?: string[] }) => {
			opts.captured.called = true;
			opts.captured.allowedTools = p.allowedTools;
			return undefined;
		},
	};
}

function normalPlan(effectiveAllowedTools: EffectiveTool[] | undefined): SessionSetupPlan {
	return {
		id: "sess",
		mode: "normal",
		goalId: "g1",
		effectiveAllowedTools,
		bridgeOptions: {},
	} as unknown as SessionSetupPlan;
}

describe("session-setup _resolvePrompt — bobbit.disabledTools filtered before prompt assembly", () => {
	it("normal session: a disabled tool is absent from the allowlist passed to assemblePrompt", () => {
		const captured: Captured = { called: false };
		const plan = normalPlan(tools("read", "write", "browser_navigate"));
		resolvePrompt(plan, makeCtx({ disabledTools: ["browser_navigate"], captured }));

		assert.ok(captured.called, "assemblePrompt must be invoked");
		assert.deepEqual(captured.allowedTools, ["read", "write"], "prompt must not advertise the disabled tool");
		assert.deepEqual(plan.effectiveAllowedTools!.map(t => t.name), ["read", "write"]);
	});

	it("matches case-insensitively (disabled set is lower-cased)", () => {
		const captured: Captured = { called: false };
		const plan = normalPlan(tools("Read", "Browser_Navigate"));
		resolvePrompt(plan, makeCtx({ disabledTools: ["browser_navigate"], captured }));
		assert.deepEqual(captured.allowedTools, ["Read"]);
	});

	it("preserves undefined (unrestricted): no allowlist in ⇒ none out, never widened", () => {
		const captured: Captured = { called: false };
		const plan = normalPlan(undefined);
		resolvePrompt(plan, makeCtx({ disabledTools: ["browser_navigate"], captured }));
		assert.equal(captured.allowedTools, undefined);
		assert.equal(plan.effectiveAllowedTools, undefined);
	});

	it("preserves [] (explicit no tools): never widened back to all tools", () => {
		const captured: Captured = { called: false };
		const plan = normalPlan([]);
		resolvePrompt(plan, makeCtx({ disabledTools: ["browser_navigate"], captured }));
		assert.deepEqual(captured.allowedTools, []);
		assert.deepEqual(plan.effectiveAllowedTools, []);
	});

	it("absent metadata is byte-identical (no filtering)", () => {
		const captured: Captured = { called: false };
		const plan = normalPlan(tools("read", "browser_navigate"));
		resolvePrompt(plan, makeCtx({ captured }));
		assert.deepEqual(captured.allowedTools, ["read", "browser_navigate"]);
	});

	it("delegate session: plan allowlist is filtered before the delegate prompt is assembled", () => {
		const captured: Captured = { called: false };
		const plan = {
			id: "sess-del",
			mode: "delegate",
			instructions: "do x",
			effectiveAllowedTools: tools("read", "browser_navigate"),
			bridgeOptions: {},
		} as unknown as SessionSetupPlan;
		resolvePrompt(plan, makeCtx({ disabledTools: ["browser_navigate"], captured }));
		assert.ok(captured.called, "assemblePrompt must be invoked");
		assert.deepEqual(plan.effectiveAllowedTools!.map(t => t.name), ["read"]);
	});

	it("assistant session: re-filters after recomputing the role-restricted allowlist", () => {
		const captured: Captured = { called: false };
		// A toolManager whose available tools include the to-be-disabled tool;
		// computeEffectiveAllowedTools (no role policies, default allow) returns
		// both, so without the post-recompute re-filter the prompt would leak it.
		const toolManager = {
			getAvailableTools: () => [
				{ name: "read", group: "filesystem" },
				{ name: "browser_navigate", group: "browser" },
			],
			getToolByName: () => undefined,
			getToolProviders: () => new Map(),
		};
		const roleManager = { getRole: (n: string) => (n === "assistant" ? { toolPolicies: {} } : undefined) };
		const plan = {
			id: "sess-asst",
			mode: "normal",
			assistantType: "role",
			goalId: "g1",
			effectiveAllowedTools: undefined,
			bridgeOptions: {},
		} as unknown as SessionSetupPlan;

		resolvePrompt(plan, makeCtx({ disabledTools: ["browser_navigate"], toolManager, roleManager, captured }));

		assert.ok(captured.called, "assemblePrompt must be invoked");
		assert.ok(captured.allowedTools && captured.allowedTools.length > 0, "assistant recompute must yield a concrete allowlist");
		assert.ok(!captured.allowedTools!.includes("browser_navigate"), "assistant recompute must not re-advertise the disabled tool");
		assert.ok(captured.allowedTools!.includes("read"), "non-disabled tool still present");
	});
});
