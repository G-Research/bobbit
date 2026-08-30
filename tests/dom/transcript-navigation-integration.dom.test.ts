import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests2/dom/_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAskResponseEnvelope } from "../../src/shared/ask-envelope.js";
import { deriveTranscriptNavigation } from "../../src/ui/transcript-history.js";
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

	it("hides every navigation action from keyboard and AT until the shell is visible", async () => {
		const session = new FixtureSession();
		session.state.messages = [];
		const element = document.createElement("agent-interface") as any;
		element.session = session;
		element.gitRepoKnown = "no";
		document.body.appendChild(element);
		await settle(element);

		let shell = element.querySelector("[data-transcript-navigation-anchor]") as HTMLElement;
		expect(shell.getAttribute("aria-hidden")).toBe("true");
		expect(shell.hasAttribute("inert")).toBe(true);
		expect(Array.from(shell.querySelectorAll<HTMLButtonElement>("button")).map((button) => button.tabIndex))
			.toEqual([-1, -1]);

		element._showJumpToLastPrompt = true;
		element.requestUpdate();
		await settle(element);
		shell = element.querySelector("[data-transcript-navigation-anchor]") as HTMLElement;
		expect(shell.hasAttribute("aria-hidden")).toBe(false);
		expect(shell.hasAttribute("inert")).toBe(false);
		expect(Array.from(shell.querySelectorAll<HTMLButtonElement>("button")).map((button) => button.tabIndex))
			.toEqual([0, 0]);
	});

	it("materializes only unresolved candidates before selecting by real geometry", async () => {
		const list = document.createElement("message-list") as any;
		const targetA = document.createElement("assistant-message");
		targetA.dataset.transcriptTarget = "message:a";
		const targetB = document.createElement("assistant-message");
		targetB.dataset.transcriptTarget = "message:b";
		const materialized = new Set<string>();
		const block = (targetId: string) => ({
			localName: "deferred-block",
			dataset: { transcriptTarget: targetId },
			forceResolve: vi.fn(() => materialized.add(targetId)),
			updateComplete: Promise.resolve(true),
		});
		const blockA = block("message:a");
		const blockB = block("message:b");
		const unrelatedBlock = block("message:unrelated");
		list.querySelectorAll = vi.fn((selector: string) => selector.startsWith("deferred-block")
			? [unrelatedBlock, blockB, blockA]
			: [
				...(materialized.has("message:a") ? [targetA] : []),
				...(materialized.has("message:b") ? [targetB] : []),
			]);

		const resolved = await list.resolveTranscriptTargets(["message:a", "message:b"]);
		expect(resolved.get("message:a")).toBe(targetA);
		expect(resolved.get("message:b")).toBe(targetB);
		expect(blockA.forceResolve).toHaveBeenCalledTimes(1);
		expect(blockB.forceResolve).toHaveBeenCalledTimes(1);
		expect(unrelatedBlock.forceResolve).not.toHaveBeenCalled();

		const ask = (id: string, toolId: string) => ({
			id,
			role: "assistant",
			content: [{ type: "toolCall", id: toolId, name: "ask_user_choices", arguments: { questions: QUESTIONS } }],
		});
		const result = (id: string, toolId: string) => ({
			id,
			role: "toolResult",
			toolCallId: toolId,
			toolName: "ask_user_choices",
			content: [{ type: "text", text: JSON.stringify({ status: "posted", tool_use_id: toolId }) }],
			isError: false,
		});
		const messages = [
			ask("ask-nearest", "tool-nearest"),
			result("result-nearest", "tool-nearest"),
			ask("ask-newest", "tool-newest"),
			result("result-newest", "tool-newest"),
		];
		const navigation = deriveTranscriptNavigation(messages as any[]);
		expect(navigation.unresolvedQuestions).toHaveLength(2);
		const [nearestEntry, newestEntry] = navigation.unresolvedQuestions;
		const nearestTarget = document.createElement("assistant-message");
		nearestTarget.dataset.transcriptTarget = nearestEntry.targetId;
		nearestTarget.getBoundingClientRect = () => ({ top: 50, bottom: 95 } as DOMRect);
		const newestTarget = document.createElement("assistant-message");
		newestTarget.dataset.transcriptTarget = newestEntry.targetId;
		newestTarget.getBoundingClientRect = () => ({ top: 20, bottom: 70 } as DOMRect);
		const nearestPlaceholder = document.createElement("deferred-block");
		nearestPlaceholder.dataset.transcriptTarget = nearestEntry.targetId;
		nearestPlaceholder.getBoundingClientRect = () => ({ top: 0, bottom: 20 } as DOMRect);
		const newestPlaceholder = document.createElement("deferred-block");
		newestPlaceholder.dataset.transcriptTarget = newestEntry.targetId;
		newestPlaceholder.getBoundingClientRect = () => ({ top: 40, bottom: 99 } as DOMRect);

		let candidatesResolved = false;
		const candidateList = {
			resolveTranscriptTargets: vi.fn(async () => { candidatesResolved = true; return new Map(); }),
		};
		const scrollContainer = document.createElement("div") as any;
		scrollContainer.getBoundingClientRect = () => ({ top: 100, bottom: 700 } as DOMRect);
		scrollContainer.querySelector = (selector: string) => selector === "message-list" ? candidateList : null;
		scrollContainer.querySelectorAll = () => candidatesResolved
			? [nearestTarget, newestTarget]
			: [nearestPlaceholder, newestPlaceholder];

		const element = document.createElement("agent-interface") as any;
		element.session = { state: { messages } };
		element._scrollContainer = scrollContainer;
		element._isAtBottom = true;
		element._escapedFromLock = false;
		element._scrollToTranscriptTarget = vi.fn(async () => undefined);
		await element._handleJumpToUnansweredClick();

		expect(candidateList.resolveTranscriptTargets).toHaveBeenCalledWith(
			navigation.unresolvedQuestions.map((entry) => entry.targetId),
		);
		expect(element._scrollToTranscriptTarget).toHaveBeenCalledWith(nearestEntry.targetId, nearestEntry);
		expect(element._isAtBottom).toBe(false);
		expect(element._escapedFromLock).toBe(true);
	});

	it("re-reads target geometry while deferred content shifts a downward jump", async () => {
		const element = document.createElement("agent-interface") as any;
		const scrollContainer = document.createElement("div");
		element._scrollContainer = scrollContainer;
		element._getTopPromptNavOffsetPx = () => 40;
		element._refreshJumpButton = vi.fn();

		Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 5_000 });
		Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 500 });
		scrollContainer.scrollTop = 100;
		scrollContainer.getBoundingClientRect = () => ({ top: 20, bottom: 520 } as DOMRect);

		const target = document.createElement("user-message");
		let targetTop = 620;
		target.getBoundingClientRect = () => ({ top: targetTop, bottom: targetTop + 200 } as DOMRect);
		const sampledTargets: number[] = [];
		element._springScrollTo = vi.fn(async (readTarget: () => number) => {
			sampledTargets.push(readTarget());
			// Advancing the viewport by 200px would move the target up by 200px,
			// but materializing deferred rows above it adds another 400px.
			scrollContainer.scrollTop = 300;
			targetTop = 820;
			sampledTargets.push(readTarget());
		});

		await element._scrollTranscriptElementIntoView(target);

		expect(element._springScrollTo).toHaveBeenCalledWith(expect.any(Function));
		expect(sampledTargets).toEqual([660, 1_060]);
	});

	it("escapes follow-tail before spring targeting with highlight", async () => {
		const list = document.createElement("message-list") as any;
		const target = document.createElement("assistant-message");
		target.dataset.transcriptTarget = "message:selected";
		list.resolveTranscriptTarget = vi.fn(async () => target);

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
