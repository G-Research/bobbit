import { describe, expect, it } from "vitest";
import { ActionError } from "../../src/server/extension-host/action-dispatcher.ts";
import { ToolResultFilterDispatcher } from "../../src/server/agent/tool-result-filter-dispatcher.ts";

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
		kind: "tool-result-filter", version: 1, action, ruleId: `rule-${id}`, reasonCode: `reason-${id}`,
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
			expect.objectContaining({ source: expect.objectContaining({ hookId: "reject" }), outcome: "applied", reasonCode: "reason-reject", ruleId: "rule-reject" }),
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
});
