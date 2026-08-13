import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { syncCustomElements } from "./_setup/custom-elements.js";

beforeAll(async () => {
	await import("../../src/app/session-manager.js");
	await import("../../src/ui/tools/index.js");
	await import("../../src/ui/components/Messages.js");
	await import("../../src/ui/lazy/safe-markdown-block.js");
	syncCustomElements();
	await customElements.whenDefined("assistant-message");
});

afterEach(() => { document.body.innerHTML = ""; });

async function settle(root: ParentNode): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		const elements = Array.from(root.querySelectorAll("*")) as Array<Element & { updateComplete?: Promise<unknown> }>;
		await Promise.all(elements.map((element) => element.updateComplete ?? Promise.resolve()));
	}
}

async function mount(work: unknown, parentId = "root-agent-a", terminalRoot = false) {
	const host = document.createElement("div");
	const message = document.createElement("assistant-message") as any;
	message.message = {
		role: "assistant",
		content: [{ type: "toolCall", id: parentId, name: "Agent", arguments: { prompt: "private child prompt" } }],
		timestamp: 100,
	};
	message.embeddedSubagentWork = work;
	if (terminalRoot) {
		message.toolResultsById = new Map([[parentId, {
			role: "toolResult", toolCallId: parentId, toolName: "Agent", isError: false, content: [], timestamp: 101,
		}]]);
	}
	host.append(message);
	document.body.append(host);
	await settle(host);
	return host;
}

describe("Claude SDK embedded subagent card", () => {
	it("renders exact-parent child activity inside the native Agent tool card", async () => {
		const host = await mount({
			"root-agent-a": {
				parentToolUseId: "root-agent-a",
				phase: "running",
				identities: [{ parentToolUseId: "root-agent-a", agentId: "sdk-child-1", agentType: "Backend parity reviewer" }],
				messages: [{
					id: "sdk-child-message-1", role: "assistant", parentToolUseId: "root-agent-a", parentAgentId: "sdk-child-1",
					content: [
						{ type: "text", text: "Checking the recovery boundary." },
						{ type: "toolCall", id: "child-read", name: "mcp__bobbit__read", arguments: { path: "src/server/a.ts" } },
					],
				}],
				pendingToolCallIds: ["child-read"],
			},
		});

		const outer = host.querySelector('[data-tool-name="Agent"]') as HTMLElement;
		const card = outer.querySelector<HTMLElement>('[data-subagent-parent-tool-use-id="root-agent-a"]');
		expect(card).toBeTruthy();
		expect(card?.dataset.subagentCount).toBe("1");
		expect(card?.textContent).toContain("Backend parity reviewer");
		expect(card?.textContent).toContain("Working");
		expect(card?.querySelector('[data-tool-name="read"]')).toBeTruthy();
		expect(host.textContent).not.toContain("private child prompt");
	});

	it("shows unknown child state honestly and settles its dangling tool when the root Agent is terminal", async () => {
		const host = await mount({
			"root-agent-a": {
				parentToolUseId: "root-agent-a", phase: "unknown",
				identities: [{ parentToolUseId: "root-agent-a", agentId: "sdk-child-unknown", agentType: "Recovery helper" }],
				messages: [{
					id: "unknown-tool-call", role: "assistant", parentToolUseId: "root-agent-a", parentAgentId: "sdk-child-unknown",
					content: [{ type: "toolCall", id: "unknown-dangling", name: "grep", arguments: { pattern: "x" } }],
				}],
				pendingToolCallIds: ["unknown-dangling"],
			},
		}, "root-agent-a", true);
		const card = host.querySelector("embedded-agent-card") as HTMLElement;
		expect(card.textContent).toContain("Status unavailable");
		expect(card.textContent).not.toContain("Working");
		expect(card.querySelector('[data-tool-name="grep"]')?.textContent).toContain("Tool call ended before a result was received.");
	});

	it("never mounts a partition with a different or absent parent", async () => {
		const host = await mount({
			"root-agent-other": {
				parentToolUseId: "root-agent-other", phase: "running",
				identities: [{ parentToolUseId: "root-agent-other", agentId: "sdk-child-other", agentType: "Must stay hidden" }],
				messages: [{ id: "hidden-child", role: "assistant", parentToolUseId: "root-agent-other", parentAgentId: "sdk-child-other", content: [{ type: "text", text: "unattached child prose" }] }],
				pendingToolCallIds: [],
			},
		});

		expect(host.querySelector("embedded-agent-card")).toBeNull();
		expect(host.textContent).not.toContain("unattached child prose");
	});

	it("preserves user collapse while status updates and marks terminal failure accessibly", async () => {
		const work = {
			"root-agent-a": {
				parentToolUseId: "root-agent-a", phase: "running",
				identities: [{ parentToolUseId: "root-agent-a", agentId: "sdk-child-1", agentType: "Backend parity reviewer" }],
				messages: [{ id: "first-update", role: "assistant", parentToolUseId: "root-agent-a", parentAgentId: "sdk-child-1", content: [{ type: "text", text: "first update" }] }],
				pendingToolCallIds: [],
			},
		};
		const host = await mount(work);
		const card = host.querySelector("embedded-agent-card") as any;
		const toggle = card.querySelector("button") as HTMLButtonElement;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		toggle.click();
		await card.updateComplete;
		expect(toggle.getAttribute("aria-expanded")).toBe("false");

		card.activities = [{
			parentToolUseId: "root-agent-a",
			agentId: "sdk-child-1",
			displayLabel: "Backend parity reviewer",
			state: "failed",
			failureReason: "Subagent failed",
			orderedMessages: [{ type: "toolCall", id: "dangling", name: "grep", arguments: { pattern: "x" } }],
		}];
		await settle(host);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(card.querySelector('[role="alert"]')?.textContent).toContain("Subagent failed");
		expect(card.textContent).not.toMatch(/Authorization|Bearer|sk-ant|\/home\/node\/\.claude\/credentials\.json/);
		expect(card.querySelector('[data-tool-name="grep"]')?.textContent).toContain("Tool call ended before a result was received.");
	});
});
