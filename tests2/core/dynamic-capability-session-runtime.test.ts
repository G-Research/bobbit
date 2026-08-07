import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	persistOnce,
	resolveDynamicCapabilities,
	type SessionSetupPlan,
} from "../../src/server/agent/session-setup.ts";
import { createDynamicCapabilitySelection } from "../../src/server/agent/dynamic-capability-contract.ts";
import { SessionStore } from "../../src/server/agent/session-store.ts";
import { DecisionHookDispatcher } from "../../src/server/agent/decision-request-manager.ts";
import type { CapabilityStageResult } from "../../src/server/agent/lifecycle-hub.ts";
import { writeMcpProxyExtensions, type EffectiveTool } from "../../src/server/agent/tool-activation.ts";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function outcome(stage: "skills" | "mcp"): CapabilityStageResult["outcomes"][number] {
	return {
		kind: "decision", packId: "fixture-pack", hookId: `${stage}-selector`, event: "sessionSetup",
		outcome: "advised", capabilityStage: stage,
	} as CapabilityStageResult["outcomes"][number];
}

function plan(overrides: Partial<SessionSetupPlan> = {}): SessionSetupPlan {
	return {
		id: "dynamic-session", mode: "normal", title: "Dynamic test", cwd: "/fixture/project",
		projectId: "project-1", instructions: "select useful capabilities", bridgeOptions: {},
		effectiveAllowedTools: [
			{ kind: "yaml", name: "activate_skill" },
			{ kind: "mcp", name: "mcp_allowed" },
			{ kind: "mcp", name: "mcp_denied_by_role" },
		],
		...overrides,
	} as SessionSetupPlan;
}

function runtimeContext(selectCapabilities: (stage: "skills" | "mcp", context: any) => Promise<CapabilityStageResult>, telemetry = vi.fn()): any {
	return {
		lifecycleHub: { selectCapabilities },
		resolveDynamicSkillCandidates: () => ["skill_allowed", "skill_disabled"],
		recordDynamicCapabilitySelection: telemetry,
	};
}

function declaredSelector(id: string, selectors: readonly ("skills" | "mcp")[]): any {
	return {
		id, listName: id, packRoot: "/fixtures/dynamic-pack", sourceFile: `/fixtures/dynamic-pack/hooks/${id}.yaml`,
		module: "selector.mjs", mode: "decide", events: ["sessionSetup"], selectors,
		capabilities: [], budget: { timeoutMs: 100, maxTokens: 32 },
	};
}

function decideGrant(hookId: string): any {
	return { packId: "dynamic-pack", hookId, capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" };
}

describe("dynamic capability selection in the session setup runtime", () => {
	it("runs skills before MCP, forwards the fixed skills result, and snapshots only the runtime-selected surfaces", async () => {
		const calls: Array<{ stage: string; available: string[]; selectedSkills?: string[] }> = [];
		const telemetry = vi.fn();
		const ctx = runtimeContext(async (stage, received) => {
			calls.push({ stage, available: [...received.available], selectedSkills: received.selectedSkills && [...received.selectedSkills] });
			return stage === "skills"
				? { selected: ["skill_allowed"], authoritative: true, outcomes: [outcome("skills")] }
				: { selected: ["mcp_allowed"], authoritative: true, outcomes: [outcome("mcp")] };
		}, telemetry);
		const setupPlan = plan();

		await resolveDynamicCapabilities(setupPlan, ctx);

		expect(calls).toEqual([
			{ stage: "skills", available: ["skill_allowed", "skill_disabled"], selectedSkills: undefined },
			{ stage: "mcp", available: ["mcp_allowed", "mcp_denied_by_role"], selectedSkills: ["skill_allowed"] },
		]);
		expect(setupPlan.dynamicCapabilities).toMatchObject({
			version: 1, skillsAuthoritative: true, skills: ["skill_allowed"], mcpAuthoritative: true, mcp: ["mcp_allowed"],
		});
		expect(JSON.stringify(setupPlan.dynamicCapabilities)).not.toContain(setupPlan.instructions!);
		expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
			skillCandidateCount: 2, mcpCandidateCount: 2,
			skillsContextBytesSaved: expect.any(Number), mcpContextBytesSaved: expect.any(Number),
		}));
		expect(telemetry.mock.calls[0][0].skillsContextBytesSaved).toBeGreaterThanOrEqual(0);
		expect(telemetry.mock.calls[0][0].mcpContextBytesSaved).toBeGreaterThanOrEqual(0);
	});

	it("pins the same UTF-8-bounded query for both selector stages and the durable snapshot", async () => {
		const query = "😀".repeat(3 * 1024);
		const queries: string[] = [];
		const setupPlan = plan({ instructions: query });
		await resolveDynamicCapabilities(setupPlan, runtimeContext(async (stage, received) => {
			queries.push(received.query);
			return { selected: stage === "skills" ? ["skill_allowed"] : [], authoritative: stage === "skills", outcomes: [outcome(stage)] };
		}));

		expect(queries).toEqual(["😀".repeat(2 * 1024), "😀".repeat(2 * 1024)]);
		expect(setupPlan.dynamicCapabilities?.queryFingerprint)
			.toBe(createDynamicCapabilitySelection("😀".repeat(2 * 1024), ["skill_allowed"], [], { skills: true, mcp: false }).queryFingerprint);
	});

	it("preserves the legacy unrestricted optional surface when neither stage has an eligible selector", async () => {
		const selectCapabilities = vi.fn(async () => ({ selected: [], authoritative: false, outcomes: [] }));
		const telemetry = vi.fn();
		const setupPlan = plan();

		await resolveDynamicCapabilities(setupPlan, runtimeContext(selectCapabilities, telemetry));

		expect(selectCapabilities).toHaveBeenCalledTimes(2);
		expect(setupPlan.dynamicCapabilities).toBeUndefined();
		expect(telemetry).not.toHaveBeenCalled();
	});

	it("keeps both legacy surfaces when eligible selectors fail, while retaining their trace outcomes", async () => {
		const telemetry = vi.fn();
		const setupPlan = plan();
		await resolveDynamicCapabilities(setupPlan, runtimeContext(async (stage) => ({
			selected: [], authoritative: false, outcomes: [{ ...outcome(stage), outcome: "error" }],
		}), telemetry));

		expect(setupPlan.dynamicCapabilities).toBeUndefined();
		expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
			selection: undefined, skillsContextBytesSaved: 0, mcpContextBytesSaved: 0,
		}));
	});

	it("uses policy-derived candidate ceilings and cannot enable skills without activate_skill", async () => {
		const calls: Array<{ stage: string; available: string[] }> = [];
		const ctx = runtimeContext(async (stage, received) => {
			calls.push({ stage, available: [...received.available] });
			return { selected: [], authoritative: true, outcomes: [outcome(stage)] };
		});
		const setupPlan = plan({
			effectiveAllowedTools: [
				{ kind: "yaml", name: "read" },
				{ kind: "mcp", name: "mcp_allowed" },
			] as EffectiveTool[],
		});

		await resolveDynamicCapabilities(setupPlan, ctx);

		expect(calls).toEqual([
			{ stage: "skills", available: [] },
			{ stage: "mcp", available: ["mcp_allowed"] },
		]);
		expect(setupPlan.dynamicCapabilities).toMatchObject({ skillsAuthoritative: true, skills: [], mcpAuthoritative: true, mcp: [] });
	});

	it("isolates MCP proxy cache entries by immutable selection fingerprint as well as final names", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-dynamic-cache-"));
		roots.push(root);
		vi.stubEnv("BOBBIT_DIR", root);
		const manager = {
			getScopeKey: () => "dynamic-capability-cache-fixture",
			getToolInfos: () => [{
				name: "mcp__dynamiccache__read", serverName: "dynamiccache", mcpToolName: "read",
				group: "MCP: dynamiccache", description: "fixture", inputSchema: { type: "object", properties: {} },
			}],
			getServerStatuses: () => [],
		} as any;
		const selected = ["mcp_dynamiccache"];

		const first = writeMcpProxyExtensions(manager, selected, undefined, undefined, undefined, undefined, undefined, "a".repeat(64));
		expect(first).toHaveLength(1);
		const read = vi.spyOn(fs, "readFileSync");
		const second = writeMcpProxyExtensions(manager, selected, undefined, undefined, undefined, undefined, undefined, "b".repeat(64));

		expect(second).toEqual(first);
		expect(read).toHaveBeenCalledWith(first[0], "utf-8");
		expect(writeMcpProxyExtensions(manager, [], undefined, undefined, undefined, undefined, undefined, "b".repeat(64))).toEqual([]);
	});

	it("drops hook-proposed unknown ids before they can broaden the session MCP surface", async () => {
		const hook = declaredSelector("mcp-selector", ["mcp"]);
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: {
				list: () => [{ packId: "dynamic-pack", hooks: [hook] }],
				listHooks: () => [hook],
			} as any,
			moduleHost: { invoke: async () => ({
				add: ["mcp_allowed", "mcp_never", "mcp_invented"], reason: "bounded", confidence: 1,
			}) } as any,
			grantsForProject: () => [decideGrant("mcp-selector")],
		});
		const setupPlan = plan({
			effectiveAllowedTools: [{ kind: "yaml", name: "activate_skill" }, { kind: "mcp", name: "mcp_allowed" }] as EffectiveTool[],
		});
		const telemetry = vi.fn();
		const ctx = runtimeContext((stage, context) => dispatcher.selectCapabilities(stage, context), telemetry);

		await resolveDynamicCapabilities(setupPlan, ctx);

		expect(setupPlan.dynamicCapabilities).toMatchObject({ skillsAuthoritative: false, skills: [], mcpAuthoritative: true, mcp: ["mcp_allowed"] });
		expect(setupPlan.dynamicCapabilities?.mcp).not.toEqual(expect.arrayContaining(["mcp_never", "mcp_invented"]));
		expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
			mcpCandidateCount: 1,
			mcp: expect.objectContaining({ selected: ["mcp_allowed"] }),
		}));
	});

	it("isolates a failed skills selector, still evaluates MCP with an empty fixed set, and ignores observer failures", async () => {
		const calls: Array<{ stage: string; selectedSkills?: string[] }> = [];
		const telemetry = vi.fn(() => { throw new Error("metrics unavailable"); });
		const ctx = runtimeContext(async (stage, received) => {
			calls.push({ stage, selectedSkills: received.selectedSkills && [...received.selectedSkills] });
			if (stage === "skills") throw new Error("selector timeout");
			return { selected: ["mcp_allowed"], authoritative: true, outcomes: [outcome("mcp")] };
		}, telemetry);
		const setupPlan = plan();

		await expect(resolveDynamicCapabilities(setupPlan, ctx)).resolves.toBeUndefined();

		expect(calls).toEqual([
			{ stage: "skills", selectedSkills: undefined },
			{ stage: "mcp", selectedSkills: [] },
		]);
		expect(setupPlan.dynamicCapabilities).toMatchObject({ skillsAuthoritative: false, skills: [], mcpAuthoritative: true, mcp: ["mcp_allowed"] });
		expect(telemetry).toHaveBeenCalledOnce();
	});

	it("reuses a persisted write-once snapshot across setup replay without invoking selectors", async () => {
		const selection = createDynamicCapabilitySelection("select useful capabilities", ["skill_allowed"], ["mcp_allowed"], { skills: false, mcp: true });
		const selectCapabilities = vi.fn(async () => {
			throw new Error("a restored session must not rerun selectors");
		});
		const setupPlan = plan({ dynamicCapabilities: selection });

		await resolveDynamicCapabilities(setupPlan, runtimeContext(selectCapabilities));
		expect(selectCapabilities).not.toHaveBeenCalled();
		expect(setupPlan.dynamicCapabilities).toBe(selection);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-dynamic-selection-"));
		roots.push(root);
		const store = new SessionStore(root);
		persistOnce({
			id: setupPlan.id, title: setupPlan.title, cwd: setupPlan.cwd,
			createdAt: 1, lastActivity: 1,
		} as any, setupPlan, store);
		await store.flushAsync();
		const restored = new SessionStore(root).get(setupPlan.id);
		expect(restored?.dynamicCapabilities).toEqual(selection);
		expect(restored?.dynamicCapabilities).toMatchObject({ skillsAuthoritative: false, mcpAuthoritative: true });
	});

	it("adds the pre-spawn durability barrier only when a selector snapshot exists", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-setup.ts"), "utf8");
		const start = source.indexOf("export async function executePlan(");
		const end = source.indexOf("// Step 8: spawn agent", start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const preSpawn = source.slice(start, end);

		expect(preSpawn).toMatch(/persistOnce\(preSpawnSession, plan, ctx\.store\);\s*\/\/ A dynamic snapshot[\s\S]*?if \(plan\.dynamicCapabilities\) await ctx\.store\.flushAsync\(\);/);
	});

	it("uses group defaults rather than synthesizing general for role-less selector ceilings", async () => {
		const calls: Array<{ stage: string; available: string[] }> = [];
		const roleManager = { getRole: vi.fn(() => ({ toolPolicies: { mcp__sealed: "allow" } })) };
		const ctx = {
			...runtimeContext(async (stage, received) => {
				calls.push({ stage, available: [...received.available] });
				return { selected: [], authoritative: true, outcomes: [outcome(stage)] };
			}),
			roleManager,
			toolManager: { getAvailableTools: () => [] },
			mcpManager: {
				getToolInfos: () => [{ name: "mcp__sealed__read", group: "MCP: sealed", serverName: "sealed" }],
			},
			groupPolicyStore: { getGroupPolicy: (name: string) => name === "mcp__sealed" ? "never" : null },
		};

		await resolveDynamicCapabilities(plan({ effectiveAllowedTools: undefined, roleName: undefined }), ctx as any);

		expect(roleManager.getRole).not.toHaveBeenCalled();
		expect(calls).toEqual([
			{ stage: "skills", available: [] },
			{ stage: "mcp", available: [] },
		]);
	});
});
