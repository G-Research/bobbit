import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests/support/helpers/dom/setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { describe, expect, it, vi } from "vitest";
import "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import { AgentInterface } from "../../src/ui/components/AgentInterface.js";
import "../../src/ui/lazy/safe-markdown-block.js";
import { setRenderApp } from "../../src/app/state.js";

setRenderApp(() => {});

const OPEN = 1;

function makeRemoteAgent() {
	const agent = new RemoteAgent() as any;
	const sent: Array<Record<string, unknown>> = [];
	agent.ws = {
		readyState: OPEN,
		send: (frame: string) => sent.push(JSON.parse(frame)),
	};
	return { agent, sent };
}

describe("combined client model and thinking selection", () => {
	it("preserves clamped thinking when an application wrapper forwards only the model", () => {
		const selectedModel = {
			provider: "anthropic",
			id: "claude-selected",
			reasoning: true,
			thinkingLevelMap: { xhigh: null, max: null },
		};
		const { agent, sent } = makeRemoteAgent();
		agent._state.thinkingLevel = "xhigh";
		const originalSetModel = agent.setModel.bind(agent);
		agent.setModel = (model: any) => originalSetModel(model);
		const ui = document.createElement("agent-interface") as AgentInterface;

		(ui as any)._applyModelSelection(agent, selectedModel);

		expect(agent.state.model).toBe(selectedModel);
		expect(agent.state.thinkingLevel).toBe("high");
		expect(sent).toEqual([{
			type: "set_model",
			provider: "anthropic",
			modelId: "claude-selected",
			thinkingLevel: "high",
		}]);
	});

	it("clamps once, sends one combined frame, and corrects both optimistic fields", async () => {
		const selectedModel = {
			provider: "anthropic",
			id: "claude-selected",
			reasoning: true,
			thinkingLevelMap: { xhigh: null, max: null },
		};
		const pickerSession = {
			state: {
				model: { provider: "anthropic", id: "claude-old" },
				thinkingLevel: "xhigh",
			},
			setModel: vi.fn(),
			setThinkingLevel: vi.fn(),
		};
		const ui = document.createElement("agent-interface") as AgentInterface;

		(ui as any)._applyModelSelection(pickerSession, selectedModel);

		expect(pickerSession.setModel).toHaveBeenCalledTimes(1);
		expect(pickerSession.setModel).toHaveBeenCalledWith(selectedModel, "high");
		expect(pickerSession.setThinkingLevel).not.toHaveBeenCalled();

		const { agent, sent } = makeRemoteAgent();
		const verifiedModel = { provider: "anthropic", id: "claude-verified" };
		agent._state.model = verifiedModel;
		agent._state.thinkingLevel = "high";

		agent.setModel(selectedModel, "xhigh");

		expect(agent.state.model).toBe(selectedModel);
		expect(agent.state.thinkingLevel).toBe("xhigh");
		expect(sent).toEqual([{
			type: "set_model",
			provider: "anthropic",
			modelId: "claude-selected",
			thinkingLevel: "xhigh",
		}]);

		await agent.handleServerMessage({
			type: "state",
			data: { model: verifiedModel, thinkingLevel: "high" },
		});
		await agent.handleServerMessage({
			type: "error",
			code: "SET_MODEL_FAILED",
			message: "requested tuple was rejected",
		});

		expect(agent.state.model).toBe(verifiedModel);
		expect(agent.state.thinkingLevel).toBe("high");
		expect(sent.at(-1)).toEqual({ type: "get_state" });

		agent.setThinkingLevel("medium");
		expect(sent.at(-1)).toEqual({ type: "set_thinking_level", level: "medium" });

		const oneArgFallback = makeRemoteAgent();
		oneArgFallback.agent.setModel(selectedModel);
		expect(oneArgFallback.sent).toEqual([{
			type: "set_model",
			provider: "anthropic",
			modelId: "claude-selected",
			thinkingLevel: "medium",
		}]);
	});
});
