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
//   • PI-17 bar-colour thresholds / stale bar / no-bar, PI-18 cost popover open-close,
//     PI-23 stats-bar composition + model button — NOT ported. Those behaviours live
//     INLINE in <agent-interface> (AgentInterface.ts render, no extractable helper for
//     the bar-colour/tooltip composition). AgentInterface cannot be mounted in
//     isolation under happy-dom: it renders canvas bobbit avatars, wires a
//     ResizeObserver, and drives scroll-based follow-tail (getBoundingClientRect /
//     scrollTop / scrollHeight) — all layout/geometry the environment lacks. Left for
//     the browser tier.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, render } from "lit";
import "../../src/ui/components/CostPopover.js";
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
		expect(calls).toEqual(["/api/sessions/session-cost/cost/breakdown"]);
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
