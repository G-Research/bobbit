import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests2/dom/_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/context-cost-stats.spec.ts (v2-dom tier).
//
// The legacy spec had three sets of assertions:
//   • "CostPopover production component cache-hit display" — ported here: renders the
//     REAL <cost-popover> component (src/ui/components/CostPopover.ts) under happy-dom
//     with a stubbed fetch, asserting cache-hit formatting, the session endpoint, and
//     delegate rendering.
//   • PI-18 cost text + PI-17 tooltip token formatting — ported here against the REAL
//     format helpers (src/ui/utils/format.ts: formatCost / formatTokenCount), which
//     are the actual logic the fixture reimplemented.
//   • The context meter is covered below by rendering AgentInterface's production
//     stats template directly. This avoids mounting its canvas and scroll lifecycle
//     while still exercising the real footer/popover DOM and event handlers.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, render } from "lit";
import "../../src/ui/components/CostPopover.js";
import { AgentInterface } from "../../src/ui/components/AgentInterface.js";
import { formatCost, formatTokenCount } from "../../src/ui/utils/format.js";

const COST_BASE = {
	inputTokens: 100,
	outputTokens: 50,
	cacheReadTokens: 300,
	cacheWriteTokens: 0,
	totalCost: 0.01,
	cacheHitRate: 0.75,
};

let calls: string[];
let response: any;

beforeEach(() => {
	calls = [];
	response = {};
	vi.stubGlobal("fetch", async (url: any) => {
		calls.push(String(url));
		const ok = response.ok !== false;
		return {
			ok,
			status: response.status ?? (ok ? 200 : 500),
			async json() {
				if (String(url).includes("/api/goals/")) return { aggregate: response.aggregate, sessions: response.sessions || [] };
				return { session: response.session ?? response.aggregate, delegates: response.delegates || [] };
			},
		} as any;
	});
});

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

async function waitFor<T>(fn: () => T | null | undefined, tries = 100): Promise<T> {
	for (let i = 0; i < tries; i++) {
		const v = fn();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 3));
	}
	throw new Error("waitFor: condition not met");
}

async function mountCostPopover(kind: "goal" | "session", data: any) {
	response = data;
	const container = document.createElement("div");
	document.body.appendChild(container);
	render(
		html`<cost-popover
			.open=${true}
			.goalId=${kind === "goal" ? "goal-cost" : undefined}
			.sessionId=${kind === "session" ? "session-cost" : undefined}
		></cost-popover>`,
		container,
	);
	const el = container.querySelector("cost-popover") as any;
	await el.updateComplete;
	await waitFor(() => container.querySelector('[data-testid="cost-cache-hit"]'));
	return container;
}

describe("CostPopover production component cache-hit display", () => {
	for (const [name, rate, expected] of [
		["formats 75%", 0.75, "75%"],
		["formats 0%", 0, "0%"],
		["formats 100%", 1, "100%"],
		["uses em dash for null", null, "\u2014"],
		["uses em dash for missing", undefined, "\u2014"],
		["uses em dash for non-finite", Number.POSITIVE_INFINITY, "\u2014"],
	] as const) {
		it(`goal breakdown ${name}`, async () => {
			const container = await mountCostPopover("goal", { aggregate: { ...COST_BASE, cacheHitRate: rate } });
			const row = container.querySelector('[data-testid="cost-cache-hit"]')!;
			expect(row.textContent).toContain("Cache hit");
			expect(row.textContent).toContain(expected);
			if (expected === "\u2014") expect(row.textContent).not.toContain("0%");
		});
	}

	it("session breakdown fetches session endpoint, shows delegates, and formats cache hit", async () => {
		const container = await mountCostPopover("session", {
			session: { ...COST_BASE, totalCost: 0.2, cacheHitRate: 0.75 },
			delegates: [{ sessionId: "child-1", title: "Child agent", role: "coder", inputTokens: 10, outputTokens: 5, cacheReadTokens: 15, cacheWriteTokens: 0, totalCost: 0.05 }],
		});
		expect(container.querySelector('[data-testid="cost-cache-hit"]')!.textContent).toContain("75%");
		const popover = container.querySelector("cost-popover")!;
		expect(popover.textContent).toContain("Delegates");
		expect(popover.textContent).toContain("Child agent");
		expect(calls).toEqual([
			new URL("/api/sessions/session-cost/cost/breakdown", window.location.origin).href,
		]);
	});
});

describe("cost + token formatting (real format.ts helpers)", () => {
	it("formats cost values the way the stats bar and popovers do", () => {
		expect(formatCost(0.42)).toBe("$0.4");
		expect(formatCost(3.7)).toBe("$4");
		expect(formatCost(0.01)).toBe("$0");
		expect(formatCost(0.8)).toBe("$0.8");
		expect(formatCost(0.1)).toBe("$0.1");
		expect(formatCost(1.2)).toBe("$1");
		expect(formatCost(2.5)).toBe("$3");
	});

	it("formats context token counts for the usage tooltip", () => {
		// "Context: 8.0k / 200k tokens (4%)"
		expect(formatTokenCount(8000)).toBe("8.0k");
		expect(formatTokenCount(200000)).toBe("200k");
		// small counts have no k suffix
		expect(formatTokenCount(700)).toBe("700");
		// mid-range gets a decimal k
		expect(formatTokenCount(4500)).toBe("4.5k");
	});
});

function contextUsage(totalTokens: number) {
	return {
		input: Math.max(0, totalTokens - 1000),
		output: 1000,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
	};
}

function renderContextStats(options: {
	contextWindow?: number;
	modelCapacity?: number;
	usage?: number;
	stale?: boolean;
	compactionStartPct?: number;
}) {
	const session = {
		sessionId: "context-meter-dom",
		_usageStaleAfterCompaction: options.stale === true,
		_compactionStartPct: options.compactionStartPct,
		state: {
			messages: options.usage === undefined ? [] : [{
				role: "assistant",
				stopReason: "stop",
				usage: contextUsage(options.usage),
			}],
			model: {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				contextWindow: options.contextWindow,
				modelCapacity: options.modelCapacity,
				maxTokens: 128000,
			},
			thinkingLevel: "off",
			isStreaming: false,
		},
		abort: vi.fn(),
	} as any;
	const ui = new AgentInterface() as AgentInterface & any;
	ui.session = session;
	ui.enableModelSelector = false;
	ui.enableThinkingSelector = false;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const rerender = () => render(ui.renderStats(), container);
	rerender();
	return { container, rerender, session, ui };
}

function openContextPopover(fixture: ReturnType<typeof renderContextStats>) {
	fixture.ui._contextPopoverOpen = true;
	fixture.rerender();
	return fixture.container.querySelector(".context-popover") as HTMLElement;
}

describe("AgentInterface context target and capacity meter", () => {
	it("renders the capacity-scaled segments, target marker, accessible trigger, and dual popover rows", () => {
		const fixture = renderContextStats({ contextWindow: 272000, modelCapacity: 1050000, usage: 300000 });
		const trigger = fixture.container.querySelector('[data-testid="context-meter-trigger"]') as HTMLButtonElement;
		const track = fixture.container.querySelector('[data-context-meter-variant="footer"]') as HTMLElement;

		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.type).toBe("button");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(trigger.getAttribute("aria-controls")).toBe("context-usage-popover");
		expect(trigger.getAttribute("aria-label")).toBe("Context: 300k / 1050k tokens (29% of model capacity); soft limit 272k tokens");
		expect(track.getAttribute("role")).toBe("progressbar");
		expect(track.getAttribute("aria-valuemax")).toBe("1050000");
		expect(track.getAttribute("aria-valuenow")).toBe("300000");
		expect(track.getAttribute("aria-valuetext")).toBe(trigger.getAttribute("aria-label"));
		expect(fixture.container.querySelector('[data-testid="context-meter-primary"]')).not.toBeNull();
		expect(fixture.container.querySelector('[data-testid="context-meter-warning"]')).not.toBeNull();
		expect(fixture.container.querySelector('[data-testid="context-meter-negative"]')).not.toBeNull();
		const marker = fixture.container.querySelector('[data-testid="context-meter-target-marker"]') as HTMLElement;
		expect(parseFloat(marker.style.left)).toBeCloseTo((272000 / 1050000) * 100, 5);
		expect(fixture.container.querySelector('[data-testid="context-meter-percentage"]')?.textContent).toBe("29%");

		const popover = openContextPopover(fixture);
		expect(popover.getAttribute("role")).toBe("dialog");
		expect(popover.textContent).toMatch(/Soft limit\s*272k tokens/);
		expect(popover.textContent).toMatch(/Model capacity\s*1050k tokens/);
		expect(popover.textContent).not.toContain("Context window");
		expect(popover.textContent).toContain("300k / 1050k tokens");
		expect(popover.querySelector('[data-testid="context-meter-scale"]')?.textContent).toContain("Soft limit 272k");
		expect(popover.querySelector('[data-testid="context-meter-scale"]')?.textContent).toContain("Capacity 1050k");

		const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		fixture.ui._handleGlobalEscape(escape);
		expect(escape.defaultPrevented).toBe(true);
		expect(fixture.ui._contextPopoverOpen).toBe(false);
		expect(fixture.session.abort).not.toHaveBeenCalled();
	});

	it("collapses equal or missing capacity to the existing single-limit treatment", () => {
		for (const modelCapacity of [undefined, 272000]) {
			document.body.innerHTML = "";
			const fixture = renderContextStats({ contextWindow: 272000, modelCapacity, usage: 204000 });
			expect(fixture.container.querySelector('[data-testid="context-meter-percentage"]')?.textContent).toBe("75%");
			expect(fixture.container.querySelector('[data-testid="context-meter-target-marker"]')).toBeNull();
			const popover = openContextPopover(fixture);
			expect(popover.textContent).toMatch(/Context window\s*272k tokens/);
			expect(popover.textContent).not.toContain("Soft limit");
			expect(popover.textContent).not.toContain("Model capacity");
			expect(popover.querySelector('[data-testid="context-meter-scale"]')).toBeNull();
		}
	});

	it("keeps stale usage hidden while preserving shimmer, deflation, and the target marker", () => {
		const fixture = renderContextStats({
			contextWindow: 272000,
			modelCapacity: 1050000,
			usage: 260000,
			stale: true,
			compactionStartPct: 64,
		});
		let track = fixture.container.querySelector('[data-context-meter-variant="footer"]') as HTMLElement;
		expect(track.classList.contains("context-bar-shimmer")).toBe(true);
		expect(track.getAttribute("aria-busy")).toBe("true");
		expect(track.hasAttribute("aria-valuenow")).toBe(false);
		expect(track.getAttribute("aria-valuetext")).toContain("refreshing after compaction");
		expect(fixture.container.querySelector(".context-bar-deflate")).not.toBeNull();
		expect(fixture.container.querySelector('[data-testid="context-meter-target-marker"]')).not.toBeNull();
		expect(fixture.container.querySelector('[data-testid="context-meter-percentage"]')?.textContent).toBe("-%");
		let popover = openContextPopover(fixture);
		expect(popover.textContent).toContain("Updating after compaction");
		expect(popover.textContent).not.toContain("Last Turn");

		fixture.session._usageStaleAfterCompaction = false;
		fixture.session.state.messages = [{ role: "assistant", stopReason: "stop", usage: contextUsage(100000) }];
		fixture.ui._contextPopoverOpen = true;
		fixture.rerender();
		track = fixture.container.querySelector('[data-context-meter-variant="footer"]') as HTMLElement;
		popover = fixture.container.querySelector(".context-popover") as HTMLElement;
		expect(track.classList.contains("context-bar-shimmer")).toBe(false);
		expect(track.getAttribute("aria-busy")).toBe("false");
		expect(track.getAttribute("aria-valuenow")).toBe("100000");
		expect(popover.textContent).toContain("Last Turn");
	});

	it("pins the unchanged footer geometry and themed meter surfaces", () => {
		const css = readFileSync(resolve("src/ui/app.css"), "utf8");
		expect(css).toMatch(/\.context-meter\s*\{[^}]*height:\s*6px;[^}]*background:\s*var\(--input\)/s);
		expect(css).toMatch(/\.context-meter--footer\s*\{[^}]*width:\s*48px/s);
		expect(css).toMatch(/\.context-meter-primary\s*\{[^}]*var\(--primary\)/s);
		expect(css).toMatch(/\.context-meter-warning\s*\{[^}]*var\(--warning\)/s);
		expect(css).toMatch(/\.context-meter-negative\s*\{[^}]*var\(--negative\)/s);
	});
});
