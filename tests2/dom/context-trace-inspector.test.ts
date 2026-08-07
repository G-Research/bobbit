import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, describe, expect, it } from "vitest";
import "../../src/ui/components/ContextTraceInspector.js";
import type { ContextTraceInspector, ContextTraceState } from "../../src/ui/components/ContextTraceInspector.js";

const timestamp = Date.UTC(2025, 0, 2, 3, 4, 5);

function traceState(patch: Partial<ContextTraceState> & Pick<ContextTraceState, "status" | "items">): ContextTraceState {
	const base: ContextTraceState = {
		status: "idle",
		items: [],
		limit: 100,
		hasEarlier: false,
		isRefreshing: false,
		refreshError: false,
	};
	return { ...base, ...patch };
}

function mount(state: ContextTraceState): ContextTraceInspector {
	const inspector = document.createElement("context-trace-inspector") as ContextTraceInspector;
	inspector.state = state;
	document.body.appendChild(inspector);
	return inspector;
}

async function settle(inspector: ContextTraceInspector): Promise<void> {
	await inspector.updateComplete;
	await Promise.resolve();
}

function text(element: Element): string {
	return (element.textContent || "").replace(/\s+/g, " ").trim();
}

afterEach(() => { document.body.innerHTML = ""; });

describe("ContextTraceInspector", () => {
	it("renders newest-first normalized entries while preserving provider order", async () => {
		const inspector = mount(traceState({
			status: "ready",
			items: [
				{ kind: "trace", entry: { hook: "afterTurn", ts: timestamp + 1, providers: [
					{ id: "first-provider", latencyMs: 12, keptBlocks: 3, omittedBlocks: 1 },
					{ id: "second-provider", latencyMs: 27, keptBlocks: 4, omittedBlocks: 0, error: "Timed out" },
				] } },
				{ kind: "trace", entry: { hook: "beforePrompt", ts: timestamp, providers: [] } },
			],
			hasEarlier: true,
		}));
		await settle(inspector);

		const cards = [...inspector.querySelectorAll<HTMLElement>("[data-testid='context-trace-event']")];
		expect(cards).toHaveLength(2);
		expect(text(cards[0])).toContain("afterTurn");
		expect(text(cards[1])).toContain("beforePrompt");
		expect([...cards[0].querySelectorAll("[data-testid='context-trace-provider']")].map((row) => text(row))).toEqual([
			expect.stringContaining("first-provider"),
			expect.stringContaining("second-provider"),
		]);
		expect(text(cards[0])).toContain("12 ms");
		expect(text(cards[0])).toContain("Kept 3");
		expect(text(cards[0])).toContain("Omitted 1");
		expect(text(cards[0])).toContain("Timed out");
		expect(cards[0].querySelector("[role='status']")).toBeNull();
		expect(inspector.querySelector("time")?.getAttribute("datetime")).toBe(new Date(timestamp + 1).toISOString());
		expect(text(inspector)).toContain("Trace history is bounded; oldest events rotate out.");
	});

	it("renders safe extension activity in the event card with distinct denied and dropped labels", async () => {
		const inspector = mount(traceState({
			status: "ready",
			items: [{
				kind: "trace",
				entry: {
					hook: "beforePrompt",
					ts: timestamp,
					providers: [{ id: "alpha-provider", latencyMs: 2, keptBlocks: 1, omittedBlocks: 0 }],
					outcomes: [
						{ kind: "decision", packId: "extension-pack", hookId: "grant-check", event: "beforePrompt", outcome: "denied", reason: "Grant required", questionId: "a".repeat(64), actor: "extension" },
						{ kind: "advisory", hookId: "proposal", event: "beforePrompt", outcome: "superseded", reason: "Lower-priority selection", selectionKind: "thinking", selectionValue: "private-low", latencyMs: 4 },
						{ kind: "audit", hookId: "selected-model", event: "beforePrompt", outcome: "applied", value: "safe-model.2" },
						{ kind: "advisory", hookId: "applied-thinking", event: "afterTurn", outcome: "applied", selectionKind: "thinking", selectionValue: "high" },
					],
				},
			}],
		}));
		await settle(inspector);

		const card = inspector.querySelector<HTMLElement>("[data-testid='context-trace-event']")!;
		expect(text(card)).toContain("alpha-provider");
		expect(text(card)).toContain("Extension activity");
		expect(text(card)).toContain("Denied");
		expect(text(card)).toContain("Grant required");
		expect(text(card)).toContain("extension-pack");
		expect(text(card)).toContain("a".repeat(64));
		expect(text(card)).toContain("extension");
		expect(text(card)).toContain("Superseded");
		expect(text(card)).toContain("Lower-priority selection");
		expect(text(card)).toMatch(/Selection kind\s*thinking/);
		expect(text(card)).toMatch(/Selection value\s*high/);
		expect(text(card)).not.toContain("private-low");
		expect(text(card)).toContain("safe-model.2");
		expect(card.querySelectorAll("[data-testid='context-trace-outcome']")).toHaveLength(4);
		expect(card.querySelector(".context-trace-activity")?.getAttribute("aria-label")).toBe("Extension activity");
	});

	it("renders fixed dynamic capability-selection labels and excludes untrusted telemetry", async () => {
		const secret = "query proposal reason candidate-id denied-id /private/config token";
		const inspector = mount(traceState({
			status: "ready",
			items: [{
				kind: "trace",
				entry: {
					hook: "sessionSetup", ts: timestamp, providers: [],
					outcomes: [
						{
							kind: "decision", packId: "extension-pack", hookId: "select-skills", event: "sessionSetup", outcome: "applied",
							capabilityStage: "skills", selectionFingerprint: "a".repeat(64),
							candidateCount: 8, selectedCount: 2, selectorCount: 3, contextBytesSaved: 512,
						},
						{
							kind: "decision", hookId: "unsafe", event: "sessionSetup", outcome: "error",
							capabilityStage: "tools", selectionFingerprint: secret, candidateCount: -1, selectedCount: Infinity, selectorCount: -1, contextBytesSaved: -1,
							query: secret, proposal: { reason: secret, add: [secret] }, deniedIds: [secret], config: { secret },
						} as any,
					],
				},
			}],
		}));
		await settle(inspector);

		const output = text(inspector);
		expect(output).toContain("Skill selection");
		expect(output).toMatch(/Eligible capabilities\s*8/);
		expect(output).toMatch(/Selected capabilities\s*2/);
		expect(output).toMatch(/Eligible selectors\s*3/);
		expect(output).toMatch(/Context bytes saved\s*512/);
		expect(output).toContain("Selection fingerprint");
		expect(output).toContain("a".repeat(64));
		expect(output).not.toContain("tools");
		expect(output).not.toContain(secret);
	});

	it("shows stable loading, empty, and fixed error states", async () => {
		const inspector = mount(traceState({ status: "loading", items: [] }));
		await settle(inspector);
		expect(inspector.querySelector("[role='tabpanel']")?.getAttribute("aria-busy")).toBe("true");
		expect(text(inspector)).toContain("Loading context trace…");
		expect(inspector.querySelectorAll("[aria-hidden='true']")).toHaveLength(2);

		inspector.state = traceState({ status: "ready", items: [] });
		await settle(inspector);
		expect(inspector.querySelector("[data-testid='context-trace-empty']")).not.toBeNull();

		inspector.state = traceState({ status: "error", items: [] });
		await settle(inspector);
		expect(text(inspector.querySelector("[role='alert']")!)).toBe("Context trace could not be loaded. Retry");
	});

	it("uses refreshError with cached rows and emits control events", async () => {
		const inspector = mount(traceState({
			status: "ready",
			items: [{ kind: "trace", entry: { hook: "sessionSetup", ts: timestamp, providers: [] } }],
			hasEarlier: true,
			refreshError: true,
		}));
		const events: string[] = [];
		for (const type of ["context-trace-retry", "context-trace-refresh", "context-trace-load-earlier"]) {
			inspector.addEventListener(type, () => events.push(type));
		}
		await settle(inspector);
		expect(text(inspector)).toContain("Showing the most recently loaded activity.");
		expect(inspector.querySelector("[data-testid='context-trace-event']")).not.toBeNull();

		for (const button of [...inspector.querySelectorAll<HTMLButtonElement>("button")]) {
			if (!button.disabled) button.click();
		}
		expect(events).toEqual(["context-trace-refresh", "context-trace-retry", "context-trace-load-earlier"]);
	});

	it("contains only typed sanitized fields and never renders unknown raw payload strings", async () => {
		const secret = "gateway-token-secret /private/stack.ts prompt contents";
		const inspector = mount(traceState({
			status: "ready",
			items: [{
				kind: "trace",
				entry: {
					hook: "Unknown event",
					ts: timestamp,
					providers: [{ id: "Unknown provider", latencyMs: 0, keptBlocks: 0, omittedBlocks: 0, error: "Provider error" }],
					...( { prompt: secret, stack: secret, error: secret } as object),
				},
			} as ContextTraceState["items"][number]],
		}));
		await settle(inspector);
		const output = text(inspector);
		expect(output).toContain("Unknown event");
		expect(output).toContain("Unknown provider");
		expect(output).toContain("Provider error");
		expect(output).not.toContain(secret);
		expect(inspector.innerHTML).not.toContain("unsafeHTML");
	});

	it("labels the non-modal tabpanel and focuses its heading once on entry", async () => {
		const inspector = mount(traceState({ status: "idle", items: [] }));
		await settle(inspector);
		const panel = inspector.querySelector("[role='tabpanel']");
		const heading = inspector.querySelector<HTMLElement>("[data-context-trace-heading]");
		expect(panel?.getAttribute("aria-label")).toBe("Context trace");
		expect(heading?.getAttribute("tabindex")).toBe("-1");
		expect(document.activeElement).toBe(heading);
		expect(inspector.querySelector("button[aria-label='Refresh context trace']")).not.toBeNull();
	});
});
