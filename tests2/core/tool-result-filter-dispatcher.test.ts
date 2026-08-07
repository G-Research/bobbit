import { describe, expect, it } from "vitest";
import { ActionError } from "../../src/server/extension-host/action-dispatcher.ts";
import {
	MAX_TOOL_RESULT_FILTER_GLOBAL_WORKERS,
	MAX_TOOL_RESULT_FILTER_SESSION_CALLS,
	MAX_TOOL_RESULT_FILTER_WORKER_TIMEOUT_MS,
	ToolResultFilterAdmission,
	ToolResultFilterDispatcher,
} from "../../src/server/agent/tool-result-filter-dispatcher.ts";

const projectId = "project-a";
const canary = "EP14_REJECTED_RESULT_CANARY_never_escape";
const input = {
	projectId, sessionId: "session-a", toolCallId: "call-a", toolName: "bash",
	result: { content: [{ type: "text", text: canary }], details: { result: canary }, isError: false, usage: { inputTokens: 10 } },
} as any;

function hook(id: string) {
	return {
		id, listName: id, packRoot: `/packs/${id}`, sourceFile: `/packs/${id}/hooks/${id}.yaml`, module: "index.mjs",
		mode: "decide", events: ["afterToolResult"], capabilities: ["filter:tool-result"], budget: { timeoutMs: 100, maxTokens: 10 },
	};
}
function grant(id: string) {
	return { packId: id, hookId: id, capability: "filter:tool-result", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "admin" };
}
function registry(...hooks: ReturnType<typeof hook>[]) {
	return { list: () => hooks.map(item => ({ packId: item.id, hooks: [item] })) } as any;
}
function proposal(action: "pass" | "replace" | "redact" | "reject", id: string) {
	return {
		kind: "tool-result-filter", version: 1, action, ruleId: id, reasonCode: `reason-${id}`,
		...((action === "replace" || action === "redact") ? { replacement: { content: [{ type: "text", text: `safe-${id}` }], isError: true } } : {}),
	};
}

describe("ToolResultFilterDispatcher", () => {
	it("does not import a declared filter without its exact live grant", async () => {
		let imports = 0;
		const dispatcher = new ToolResultFilterDispatcher({ registry: registry(hook("filter")), grantsForProject: () => [], moduleHost: { invoke: async () => { imports++; return proposal("reject", "filter"); } } as any });
		expect(dispatcher.hasEligibleFilters(projectId)).toBe(false);
		const result = await dispatcher.filter(input);
		expect(result).toMatchObject({ action: "pass", result: { content: [{ text: canary }] } });
		expect(imports).toBe(0);
	});

	it("applies reject before redact or replace and never retains original metadata", async () => {
		const dispatcher = new ToolResultFilterDispatcher({
			registry: registry(hook("replace"), hook("redact"), hook("reject")),
			grantsForProject: () => [grant("replace"), grant("redact"), grant("reject")] as any,
			moduleHost: { invoke: async (request: any) => proposal(request.packRoot.slice("/packs/".length) as any, request.packRoot.slice("/packs/".length)) } as any,
		});
		const result = await dispatcher.filter(input);
		expect(result.action).toBe("reject");
		expect(result.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Tool result withheld/) }] });
		expect(result.result).not.toHaveProperty("details");
		expect(result.result).not.toHaveProperty("usage");
		expect(JSON.stringify(result)).not.toContain(canary);
		expect(result.outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: expect.objectContaining({ hookId: "reject" }), outcome: "applied", reasonCode: "filter-rejected", ruleId: "reject" }),
			expect.objectContaining({ source: expect.objectContaining({ hookId: "replace" }), outcome: "superseded" }),
		]));
	});

	it("returns only a complete replacement and discards original details and usage", async () => {
		const dispatcher = new ToolResultFilterDispatcher({
			registry: registry(hook("redact")), grantsForProject: () => [grant("redact")] as any,
			moduleHost: { invoke: async () => proposal("redact", "redact") } as any,
		});
		const result = await dispatcher.filter(input);
		expect(result).toMatchObject({ action: "redact", result: { content: [{ text: "safe-redact" }], isError: true } });
		expect(result.result).not.toHaveProperty("details");
		expect(result.result).not.toHaveProperty("usage");
		expect(JSON.stringify(result)).not.toContain(canary);
	});

	it("fails closed when all currently eligible filters timeout, throw, or return malformed data", async () => {
		const dispatcher = new ToolResultFilterDispatcher({
			registry: registry(hook("timeout"), hook("throwing"), hook("malformed")), grantsForProject: () => [grant("timeout"), grant("throwing"), grant("malformed")] as any,
			moduleHost: { invoke: async (request: any) => {
				if (request.packRoot.endsWith("timeout")) throw new ActionError(504, "timed out");
				if (request.packRoot.endsWith("throwing")) throw new Error("untrusted extension failure");
				return { action: "reject", rawError: canary };
			} } as any,
		});
		const result = await dispatcher.filter(input);
		expect(result.action).toBe("reject");
		expect(JSON.stringify(result)).not.toContain(canary);
		expect(result.outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ reasonCode: "filter-timed-out" }),
			expect.objectContaining({ reasonCode: "filter-unavailable" }),
			expect.objectContaining({ reasonCode: "filter-malformed" }),
		]));
	});

	it("passes only when every selected filter is freshly revoked after it settles", async () => {
		let active = true;
		let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		const dispatcher = new ToolResultFilterDispatcher({
			registry: { list: () => active ? [{ packId: "filter", hooks: [hook("filter")] }] : [] } as any,
			grantsForProject: () => active ? [grant("filter")] as any : [],
			moduleHost: { invoke: async () => { await wait; return proposal("reject", "filter"); } } as any,
		});
		const pending = dispatcher.filter(input);
		active = false;
		release();
		const result = await pending;
		expect(result).toMatchObject({ action: "pass", result: { content: [{ text: canary }] } });
		expect(result.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "denied", reasonCode: "filter-disabled-or-revoked" })]));
	});

	it("fails closed when A is replaced by B before A settles", async () => {
		let activeHooks = [hook("a")];
		let activeGrants = [grant("a")];
		let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		const dispatcher = new ToolResultFilterDispatcher({
			registry: { list: () => activeHooks.map(item => ({ packId: item.id, hooks: [item] })) } as any,
			grantsForProject: () => activeGrants as any,
			moduleHost: { invoke: async () => { await wait; return proposal("reject", "a"); } } as any,
		});
		const pending = dispatcher.filter(input);
		activeHooks = [hook("b")];
		activeGrants = [grant("b")];
		release();
		const result = await pending;
		expect(result).toMatchObject({ action: "reject", reasonCode: "filter-authority-changed" });
		expect(JSON.stringify(result)).not.toContain(canary);
	});

	it("fails closed when B is added while A settles because B never executed", async () => {
		let activeHooks = [hook("a")];
		let activeGrants = [grant("a")];
		let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		const dispatcher = new ToolResultFilterDispatcher({
			registry: { list: () => activeHooks.map(item => ({ packId: item.id, hooks: [item] })) } as any,
			grantsForProject: () => activeGrants as any,
			moduleHost: { invoke: async () => { await wait; return proposal("pass", "a"); } } as any,
		});
		const pending = dispatcher.filter(input);
		activeHooks = [hook("a"), hook("b")];
		activeGrants = [grant("a"), grant("b")];
		release();
		const result = await pending;
		expect(result).toMatchObject({ action: "reject", reasonCode: "filter-authority-changed" });
		expect(JSON.stringify(result)).not.toContain(canary);
	});

	it("fails closed when the eligible priority order changes before workers settle", async () => {
		let activeHooks = [hook("a"), hook("b")];
		let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		const dispatcher = new ToolResultFilterDispatcher({
			registry: { list: () => activeHooks.map(item => ({ packId: item.id, hooks: [item] })) } as any,
			grantsForProject: () => [grant("a"), grant("b")] as any,
			moduleHost: { invoke: async (request: any) => { await wait; return proposal("pass", request.packRoot.endsWith("a") ? "a" : "b"); } } as any,
		});
		const pending = dispatcher.filter(input);
		activeHooks = [hook("b"), hook("a")];
		release();
		const result = await pending;
		expect(result).toMatchObject({ action: "reject", reasonCode: "filter-authority-changed" });
		expect(JSON.stringify(result)).not.toContain(canary);
	});

	it("keeps a stable eligible set and deterministically reduces its complete worker set", async () => {
		const dispatcher = new ToolResultFilterDispatcher({
			registry: registry(hook("a"), hook("b")), grantsForProject: () => [grant("a"), grant("b")] as any,
			moduleHost: { invoke: async (request: any) => proposal(request.packRoot.endsWith("a") ? "pass" : "redact", request.packRoot.endsWith("a") ? "a" : "b") } as any,
		});
		const result = await dispatcher.filter(input);
		expect(result).toMatchObject({ action: "redact", ruleId: "b", result: { content: [{ text: "safe-b" }] } });
		expect(JSON.stringify(result)).not.toContain(canary);
	});

	it("rejects worker-controlled metadata and publishes only source identity and core codes", async () => {
		const forgedRuleId = "EP14_FORGED_RULE_CANARY_must_not_escape";
		const forgedReasonCode = "EP14_FORGED_REASON_CANARY_must_not_escape";
		const dispatcher = new ToolResultFilterDispatcher({
			registry: registry(hook("filter")), grantsForProject: () => [grant("filter")] as any,
			moduleHost: { invoke: async () => ({ kind: "tool-result-filter", version: 1, action: "reject", ruleId: "filter", reasonCode: forgedReasonCode }) } as any,
		});
		const result = await dispatcher.filter(input);
		expect(result).toMatchObject({ action: "reject", reasonCode: "filter-rejected", ruleId: "filter" });
		expect(JSON.stringify(result)).not.toContain(forgedReasonCode);

		const forgedIdentity = new ToolResultFilterDispatcher({
			registry: registry(hook("filter")), grantsForProject: () => [grant("filter")] as any,
			moduleHost: { invoke: async () => ({ kind: "tool-result-filter", version: 1, action: "reject", ruleId: forgedRuleId, reasonCode: forgedReasonCode }) } as any,
		});
		const forged = await forgedIdentity.filter(input);
		expect(forged).toMatchObject({ action: "reject", reasonCode: "filter-unavailable" });
		expect(JSON.stringify(forged)).not.toContain(forgedRuleId);
		expect(JSON.stringify(forged)).not.toContain(forgedReasonCode);
		expect(forged.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ reasonCode: "filter-malformed" })]));
	});

	it("clamps every worker below the 2.5 second gate deadline", async () => {
		let timeout = 0;
		const slowHook = { ...hook("filter"), budget: { timeoutMs: 99_999, maxTokens: 10 } };
		const dispatcher = new ToolResultFilterDispatcher({
			registry: registry(slowHook), grantsForProject: () => [grant("filter")] as any,
			moduleHost: { invoke: async (_request: unknown, suppliedTimeout: number) => { timeout = suppliedTimeout; return proposal("pass", "filter"); } } as any,
		});
		await dispatcher.filter(input);
		expect(timeout).toBe(MAX_TOOL_RESULT_FILTER_WORKER_TIMEOUT_MS);
		expect(timeout).toBeLessThan(2_500);
	});

	it("fails closed on authority lookup failures but passes a successfully all-revoked snapshot", async () => {
		const registryFailure = new ToolResultFilterDispatcher({ registry: { list: () => { throw new Error("registry unavailable"); } } as any, grantsForProject: () => [], moduleHost: {} as any });
		expect(() => registryFailure.hasEligibleFilters(projectId)).toThrow("registry unavailable");
		expect((await registryFailure.filter(input)).action).toBe("reject");

		let reads = 0;
		const grantFailure = new ToolResultFilterDispatcher({
			registry: registry(hook("filter")),
			grantsForProject: () => { reads++; if (reads === 1) return [grant("filter")] as any; throw new Error("grants unavailable"); },
			moduleHost: { invoke: async () => proposal("pass", "filter") } as any,
		});
		const failed = await grantFailure.filter(input);
		expect(failed).toMatchObject({ action: "reject", reasonCode: "filter-authority-unavailable" });

		let finalReads = 0;
		const postFenceFailure = new ToolResultFilterDispatcher({
			registry: registry(hook("filter")),
			grantsForProject: () => { finalReads++; if (finalReads === 4) throw new Error("post-settle unavailable"); return [grant("filter")] as any; },
			moduleHost: { invoke: async () => proposal("pass", "filter") } as any,
		});
		expect(await postFenceFailure.filter(input)).toMatchObject({ action: "reject", reasonCode: "filter-authority-unavailable" });

		let active = true;
		let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		const revoked = new ToolResultFilterDispatcher({
			registry: { list: () => active ? [{ packId: "filter", hooks: [hook("filter")] }] : [] } as any,
			grantsForProject: () => active ? [grant("filter")] as any : [],
			moduleHost: { invoke: async () => { await wait; return proposal("pass", "filter"); } } as any,
		});
		const pending = revoked.filter(input);
		active = false;
		release();
		expect((await pending).action).toBe("pass");
	});

	it("isolates concurrent calls by their supplied tool call id", async () => {
		const dispatcher = new ToolResultFilterDispatcher({
			registry: registry(hook("filter")), grantsForProject: () => [grant("filter")] as any,
			moduleHost: { invoke: async (request: any) => proposal(request.ctx.toolCallId === "reject-call" ? "reject" : "redact", "filter") } as any,
		});
		const [rejected, redacted] = await Promise.all([
			dispatcher.filter({ ...input, toolCallId: "reject-call" }),
			dispatcher.filter({ ...input, toolCallId: "redact-call" }),
		]);
		expect(rejected.action).toBe("reject");
		expect(redacted).toMatchObject({ action: "redact", result: { content: [{ text: "safe-filter" }] } });
	});

	it("admits ordinary concurrent production calls and releases their slots", async () => {
		expect(MAX_TOOL_RESULT_FILTER_GLOBAL_WORKERS).toBe(64);
		expect(MAX_TOOL_RESULT_FILTER_SESSION_CALLS).toBe(64);
		let invocations = 0;
		const dispatcher = new ToolResultFilterDispatcher({
			registry: registry(hook("filter")), grantsForProject: () => [grant("filter")] as any,
			moduleHost: { invoke: async () => {
				invocations++;
				await new Promise(resolve => setTimeout(resolve, 5));
				return proposal("pass", "filter");
			} } as any,
		});
		const results = await Promise.all(Array.from({ length: 8 }, (_unused, index) =>
			dispatcher.filter({ ...input, toolCallId: `parallel-call-${index}` }),
		));
		expect(results.map(result => result.action)).toEqual(Array(8).fill("pass"));
		expect(invocations).toBe(8);
		expect((await dispatcher.filter({ ...input, toolCallId: "released-call" })).action).toBe("pass");
		expect(invocations).toBe(9);
	});

	it("atomically admits an entire candidate set and recovers permits after cancellation", async () => {
		const admission = new ToolResultFilterAdmission(2, 1);
		const controller = new AbortController();
		const dispatcher = new ToolResultFilterDispatcher({
			registry: registry(hook("first"), hook("second")), grantsForProject: () => [grant("first"), grant("second")] as any,
			moduleHost: { invoke: async (_request: any, _timeout: number, signal?: AbortSignal) => {
				if (signal) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				return proposal("pass", _request.packRoot.endsWith("first") ? "first" : "second");
			} } as any,
			admission,
		});
		const pending = dispatcher.filter(input, controller.signal);
		// The first call owns both permits, so a second call cannot invoke only one worker.
		const refused = await dispatcher.filter({ ...input, toolCallId: "second-call" });
		expect(refused).toMatchObject({ action: "reject", reasonCode: "filter-admission-rejected" });
		expect(JSON.stringify(refused)).not.toContain(canary);
		controller.abort();
		await expect(pending).resolves.toMatchObject({ action: "reject", reasonCode: "filter-aborted" });
		const recovered = await dispatcher.filter({ ...input, toolCallId: "recovered-call" });
		expect(recovered.action).toBe("pass");
	});
});
