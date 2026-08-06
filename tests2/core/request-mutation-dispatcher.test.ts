import { describe, expect, it } from "vitest";
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
});
