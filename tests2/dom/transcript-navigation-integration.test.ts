import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAskResponseEnvelope } from "../../src/shared/ask-envelope.js";
import { ensureBgProcessPill, ensureContinueSessionChooser, ensureCostPopover, ensureGitStatusWidget, ensureGoalStatusWidget } from "../../src/app/lazy-widgets.js";
import "../../src/ui/components/AgentInterface.js";
import "../../src/ui/components/MessageList.js";
import "../../src/ui/components/Messages.js";
import "../../src/ui/lazy/safe-markdown-block.js";

const TOOL_ID = "tool_ask_navigation_dom";
const QUESTIONS = [
	{ question: "Favorite color?", options: ["red", "blue"], tab_label: "Color" },
	{ question: "Team size?", options: ["small", "large"], tab_label: "Team size" },
];

function askMessage(id = "ask-message") {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: TOOL_ID, name: "ask_user_choices", arguments: { questions: QUESTIONS } }],
	};
}

function postedResult() {
	return {
		id: "ask-result",
		role: "toolResult",
		toolCallId: TOOL_ID,
		toolName: "ask_user_choices",
		content: [{ type: "text", text: JSON.stringify({ status: "posted", tool_use_id: TOOL_ID }) }],
		isError: false,
	};
}

class FixtureSession {
	sessionId = "transcript-navigation-dom";
	private listeners = new Set<(event: any) => void>();
	state: any = {
		messages: [
			{ id: "prompt", role: "user", content: "Set up navigation" },
			askMessage(),
			postedResult(),
		],
		tools: [],
		pendingToolCalls: new Set<string>(),
		streamingMessage: { id: "stream", role: "assistant", content: [{ type: "text", text: "Still working" }] },
		isStreaming: true,
		status: "streaming",
		model: { provider: "mock", id: "mock-model", name: "Mock" },
		thinkingLevel: "off",
		usage: null,
		cost: 0,
	};

	subscribe(listener: (event: any) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: any) {
		for (const listener of this.listeners) listener(event);
	}

	getQueue() { return []; }
	abort() {}
	async prompt() {}
}

async function settle(root: ParentNode = document.body): Promise<void> {
	for (let index = 0; index < 5; index++) {
		await Promise.resolve();
		const updatables = Array.from(root.querySelectorAll("*")) as Array<Element & { updateComplete?: Promise<unknown> }>;
		await Promise.all(updatables.map((element) => element.updateComplete?.catch?.(() => undefined) ?? undefined));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

beforeAll(async () => {
	await Promise.all([
		ensureGitStatusWidget(),
		ensureGoalStatusWidget(),
		ensureBgProcessPill(),
		ensureCostPopover(),
		ensureContinueSessionChooser(),
	]);
	(globalThis as any).ResizeObserver ??= class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	(HTMLElement.prototype as any).getAnimations ??= () => [];
	(HTMLCanvasElement.prototype as any).getAnimations = () => [];
	(HTMLCanvasElement.prototype as any).getContext = () => ({
		clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
		createLinearGradient: () => ({ addColorStop() {} }),
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		putImageData() {}, drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
	});
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("AgentInterface transcript navigation integration", () => {
	it("updates an open history dialog on committed messages and removes the unanswered segment immediately after an answer envelope", async () => {
		const session = new FixtureSession();
		const element = document.createElement("agent-interface") as any;
		element.session = session;
		element.gitRepoKnown = "no";
		document.body.appendChild(element);
		await element.updateComplete;
		await settle(element);

		const unanswered = element.querySelector("[data-testid='jump-to-unanswered-question']") as HTMLButtonElement | null;
		expect(unanswered?.getAttribute("aria-label")).toContain("1 unanswered question");
		expect(unanswered?.querySelector(".transcript-unanswered-count")?.textContent).toBe("1");

		(element.querySelector("[data-testid='jump-to-transcript-history']") as HTMLButtonElement).click();
		await settle(element);
		expect(element.querySelector("transcript-history-popover[open] [role='dialog']")).not.toBeNull();
		expect(element.querySelector(".transcript-history-row[data-entry-id*='question']")?.textContent).toContain("Unanswered");

		// A cumulative token update must not disturb the committed unanswered projection.
		session.state.streamingMessage = { id: "stream", role: "assistant", content: [{ type: "text", text: "Still working, longer" }] };
		session.emit({ type: "message_update", message: session.state.streamingMessage });
		await settle(element);
		expect(element.querySelector("[data-testid='jump-to-unanswered-question']")).not.toBeNull();

		const envelope = {
			id: "answer-envelope",
			role: "user",
			content: buildAskResponseEnvelope(TOOL_ID, [
				{ question: "Favorite color?", selected: "red", other_text: null },
				{ question: "Team size?", selected: "small", other_text: null },
			]),
		};
		session.state.messages = [...session.state.messages, envelope];
		session.emit({ type: "message_end", message: envelope });
		await settle(element);

		expect(element.querySelector("[data-testid='jump-to-unanswered-question']")).toBeNull();
		const questionRow = element.querySelector(".transcript-history-row[data-entry-id*='question']") as HTMLElement | null;
		expect(questionRow).not.toBeNull();
		expect(questionRow?.textContent).not.toContain("Unanswered");
		expect(session.state.isStreaming).toBe(true);
	});

	it("resolves only the selected deferred target and escapes follow-tail before spring targeting with highlight", async () => {
		const list = document.createElement("message-list") as any;
		const target = document.createElement("assistant-message");
		target.dataset.transcriptTarget = "message:selected";
		let selectedResolved = false;
		const selectedBlock = {
			dataset: { transcriptTarget: "message:selected" },
			forceResolve: vi.fn(() => { selectedResolved = true; }),
			updateComplete: Promise.resolve(true),
		};
		const otherBlock = {
			dataset: { transcriptTarget: "message:other" },
			forceResolve: vi.fn(),
			updateComplete: Promise.resolve(true),
		};
		list.querySelectorAll = vi.fn(() => [otherBlock, selectedBlock]);
		list.querySelector = vi.fn((selector: string) => selectedResolved && selector.includes("message\\:selected") ? target : null);
		list._findResolvedTranscriptTarget = () => selectedResolved ? target : null;

		await expect(list.resolveTranscriptTarget("message:selected")).resolves.toBe(target);
		expect(selectedBlock.forceResolve).toHaveBeenCalledTimes(1);
		expect(otherBlock.forceResolve).not.toHaveBeenCalled();

		const element = document.createElement("agent-interface") as any;
		const scrollContainer = document.createElement("div");
		scrollContainer.querySelector = (selector: string) => selector === "message-list" ? list : null;
		element._scrollContainer = scrollContainer;
		element._isAtBottom = true;
		element._escapedFromLock = false;
		const spring = vi.fn(async (_node: HTMLElement, highlight: boolean) => {
			if (highlight) target.classList.add("transcript-navigation-highlight");
		});
		element._scrollTranscriptElementIntoView = spring;

		await element._scrollToTranscriptTarget("message:selected", {
			id: "question-entry",
			targetId: "message:selected",
			ordinal: 0,
			kind: "question",
			authorLabel: "Assistant",
			typeLabel: "Multiple-choice question",
			excerpt: "Favorite color?",
			unresolved: true,
		});

		expect(element._isAtBottom).toBe(false);
		expect(element._escapedFromLock).toBe(true);
		expect(spring).toHaveBeenCalledWith(target, true);
		expect(target.classList.contains("transcript-navigation-highlight")).toBe(true);
		expect(element._transcriptJumpStatus).toContain("Jumped to unanswered question");
	});
});
