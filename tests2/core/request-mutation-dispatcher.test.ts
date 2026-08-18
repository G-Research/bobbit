import { describe, expect, it } from "vitest";
import { ActionError } from "../../src/server/extension-host/action-dispatcher.ts";
import { RequestMutationDispatcher } from "../../src/server/agent/request-mutation-dispatcher.ts";

const projectId = "project-a";
const promptRequest = { projectId, sessionId: "session-a", text: "original" };
const toolRequest = { projectId, sessionId: "session-a", toolName: "bash" };

function registry() {
	return { list: () => [], listHooks: () => [] } as any;
}

describe("request mutation dispatcher core seam", () => {
	it("runs typed core shapers without extensions or grants", async () => {
		let promptCalls = 0;
		let toolCalls = 0;
		const dispatcher = new RequestMutationDispatcher({
			registry: registry(), moduleHost: { invoke: async () => { throw new Error("should not import"); } } as any, grantsForProject: () => [],
			coreShapers: [{
				id: "budget", priority: 10,
				shapePrompt: () => { promptCalls++; return { action: "replace", text: "core request", reason: "Prompt shaped" }; },
				inspectTool: () => { toolCalls++; return { action: "deny", reason: "Tool denied" }; },
			}],
		});
		expect(dispatcher.hasPromptHooks(projectId)).toBe(true);
		expect(dispatcher.hasToolSafetyHooks(projectId)).toBe(true);
		await expect(dispatcher.shapePrompt(promptRequest)).resolves.toMatchObject({ action: "replace", text: "core request", source: { packId: "core", hookId: "budget" } });
		await expect(dispatcher.inspectTool(toolRequest)).resolves.toMatchObject({ action: "deny", source: { packId: "core", hookId: "budget" } });
		expect({ promptCalls, toolCalls }).toEqual({ promptCalls: 1, toolCalls: 1 });
	});

	it("does not import an extension whose exact mutate grant is absent", async () => {
		let imports = 0;
		const item = hook("shape", "beforePrompt");
		const dispatcher = new RequestMutationDispatcher({
			registry: extensionRegistry(item), moduleHost: { invoke: async () => { imports++; return promptProposal("changed"); } } as any,
			grantsForProject: () => [],
		});
		expect(dispatcher.hasPromptHooks(projectId)).toBe(false);
		const result = await dispatcher.shapePrompt(promptRequest);
		expect(result).toMatchObject({ action: "pass" });
		expect(result).not.toHaveProperty("text");
		expect(result.outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({
				source: expect.objectContaining({ packId: "shape", hookId: "shape" }),
				outcome: "denied",
				reason: "Grant required",
			}),
		]));
		expect(imports).toBe(0);
	});

	it("rechecks a live grant after the worker returns", async () => {
		const item = hook("shape", "beforePrompt");
		let reads = 0;
		const dispatcher = new RequestMutationDispatcher({
			registry: extensionRegistry(item), moduleHost: { invoke: async () => promptProposal("changed") } as any,
			grantsForProject: () => ++reads === 1 ? [grant("shape")] as any : [],
		});
		const result = await dispatcher.shapePrompt(promptRequest);
		expect(result).toMatchObject({ action: "pass" });
		expect(result.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "denied", reason: "Grant required" })]));
	});

	it("fences a settled extension proposal after a concurrent grant revocation", async () => {
		const fast = hook("fast", "beforePrompt");
		const slow = hook("slow", "beforePrompt");
		let grantsActive = true;
		let releaseSlow!: () => void;
		const slowWorker = new Promise<void>(resolve => { releaseSlow = resolve; });
		let completeFastFence!: () => void;
		const fastFence = new Promise<void>(resolve => { completeFastFence = resolve; });
		let grantChecks = 0;
		const dispatcher = new RequestMutationDispatcher({
			registry: extensionRegistry(fast, slow),
			moduleHost: { invoke: async (request: any) => {
				if (request.packRoot === "/packs/slow") await slowWorker;
				return request.packRoot === "/packs/fast" ? promptProposal("stale replacement") : null;
			} } as any,
			grantsForProject: () => {
				if (++grantChecks === 3) completeFastFence();
				return grantsActive ? [grant("fast"), grant("slow")] as any : [];
			},
			coreShapers: [{ id: "core", priority: 10, shapePrompt: () => ({ action: "replace", text: "core replacement", reason: "Prompt shaped" }) }],
		});
		const pending = dispatcher.shapePrompt(promptRequest);
		await fastFence; // The fast worker has passed its individual post-worker fence.
		grantsActive = false;
		releaseSlow();
		const result = await pending;
		expect(result).toMatchObject({ action: "replace", text: "core replacement", source: { packId: "core", hookId: "core" } });
		expect(result.outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: expect.objectContaining({ hookId: "fast" }), outcome: "denied", reason: "Grant required" }),
		]));
	});

	it("fences a settled extension proposal after its live declaration disappears", async () => {
		const fast = hook("fast", "beforePrompt");
		const slow = hook("slow", "beforePrompt");
		let declared = true;
		let releaseSlow!: () => void;
		const slowWorker = new Promise<void>(resolve => { releaseSlow = resolve; });
		let completeFastFence!: () => void;
		const fastFence = new Promise<void>(resolve => { completeFastFence = resolve; });
		let grantChecks = 0;
		const dispatcher = new RequestMutationDispatcher({
			registry: { list: () => declared ? [fast, slow].map(item => ({ packId: item.id, hooks: [item] })) : [], listHooks: () => [] } as any,
			moduleHost: { invoke: async (request: any) => {
				if (request.packRoot === "/packs/slow") await slowWorker;
				return request.packRoot === "/packs/fast" ? promptProposal("stale replacement") : null;
			} } as any,
			grantsForProject: () => {
				if (++grantChecks === 3) completeFastFence();
				return [grant("fast"), grant("slow")] as any;
			},
		});
		const pending = dispatcher.shapePrompt(promptRequest);
		await fastFence; // The original declaration was still live for this worker's own fence.
		declared = false;
		releaseSlow();
		const result = await pending;
		expect(result).toMatchObject({ action: "pass" });
		expect(result.outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: expect.objectContaining({ hookId: "fast" }), outcome: "denied", reason: "Prompt mutation disabled" }),
		]));
	});

	it("isolates timeout, throw, and malformed hooks while applying the surviving replacement", async () => {
		const timeout = hook("timeout", "beforePrompt");
		const throwing = hook("throwing", "beforePrompt");
		const malformed = hook("malformed", "beforePrompt");
		const valid = hook("valid", "beforePrompt");
		const dispatcher = new RequestMutationDispatcher({
			registry: extensionRegistry(timeout, throwing, malformed, valid),
			moduleHost: { invoke: async (request: any) => {
				switch (request.packRoot) {
					case "/packs/timeout": throw new ActionError(504, "timed out");
					case "/packs/throwing": throw new Error("crashed");
					case "/packs/malformed": return { kind: "request-mutation", proposal: { kind: "prompt-shape", text: "no version" } };
					default: return promptProposal("survives");
				}
			} } as any,
			grantsForProject: () => [grant("timeout"), grant("throwing"), grant("malformed"), grant("valid")] as any,
		});
		const result = await dispatcher.shapePrompt(promptRequest);
		expect(result).toMatchObject({ action: "replace", text: "survives" });
		expect(result.outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: expect.objectContaining({ hookId: "timeout" }), outcome: "error", reason: "Timed out" }),
			expect.objectContaining({ source: expect.objectContaining({ hookId: "throwing" }), outcome: "error", reason: "Unavailable" }),
			expect.objectContaining({ source: expect.objectContaining({ hookId: "malformed" }), outcome: "dropped", reason: "Malformed result" }),
			expect.objectContaining({ source: expect.objectContaining({ hookId: "valid" }), outcome: "applied" }),
		]));
	});

	it("composes core and extension candidates with prompt priority and deny-over-warn", async () => {
		const promptHook = hook("extension-prompt", "beforePrompt");
		const toolHook = hook("extension-tool", "beforeToolCall");
		const dispatcher = new RequestMutationDispatcher({
			registry: extensionRegistry(promptHook, toolHook),
			moduleHost: { invoke: async (request: any) => request.packRoot === "/packs/extension-prompt" ? promptProposal("extension") : toolProposal("deny") } as any,
			grantsForProject: () => [grant("extension-prompt"), grant("extension-tool")] as any,
			coreShapers: [{
				id: "core", priority: 5,
				shapePrompt: () => ({ action: "replace", text: "core", reason: "Prompt shaped" }),
				inspectTool: () => ({ action: "warn", reason: "Tool warning" }),
			}],
		});
		await expect(dispatcher.shapePrompt(promptRequest)).resolves.toMatchObject({ action: "replace", text: "core", source: { packId: "core" } });
		await expect(dispatcher.inspectTool(toolRequest)).resolves.toMatchObject({ action: "deny", source: { packId: "extension-tool" } });
	});
});

function hook(id: string, event: "beforePrompt" | "beforeToolCall") {
	return {
		id, listName: id, packRoot: `/packs/${id}`, sourceFile: `/packs/${id}/hooks/${id}.yaml`, module: "index.mjs",
		mode: "decide", events: [event], capabilities: ["mutate"], budget: { timeoutMs: 100, maxTokens: 10 },
	};
}
function grant(id: string) {
	return { packId: id, hookId: id, capability: "mutate", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "admin" } as const;
}
function extensionRegistry(...hooks: ReturnType<typeof hook>[]) {
	return { list: () => hooks.map(item => ({ packId: item.id, hooks: [item] })), listHooks: () => hooks } as any;
}
function promptProposal(text: string) {
	return { kind: "request-mutation", proposal: { kind: "prompt-shape", version: 1, intent: "clarify", text, reasonId: "rewrite" } };
}
function toolProposal(decision: "warn" | "deny") {
	return { kind: "request-mutation", proposal: { kind: "tool-safety", version: 1, decision, reasonId: "policy" } };
}
