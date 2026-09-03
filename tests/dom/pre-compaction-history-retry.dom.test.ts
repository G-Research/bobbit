import { beforeAll as syncBeforeAll } from "vitest";
import { syncCustomElements } from "../../tests/support/helpers/dom/setup/custom-elements.js";
syncBeforeAll(() => syncCustomElements());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Message rows reach the session-manager ⇄ pack-panels cycle through renderer
// dependencies. Initialise its established owner first to avoid a TDZ import.
import "../../src/app/session-manager.js";
import { __resetGatewayConnectionForTests } from "../../src/app/gateway-fetch.js";
import { PreCompactionHistory } from "../../src/ui/components/PreCompactionHistory.js";
import "../../src/ui/components/Messages.js";

if (!customElements.get("bobbit-pre-compaction-history")) {
	customElements.define("bobbit-pre-compaction-history", PreCompactionHistory);
}

const historyRows = [
	{ index: 0, role: "user", ts: null, content: "pre-msg-0", message: { id: "pre-0", role: "user", content: "pre-msg-0" } },
	{ index: 1, role: "assistant", ts: null, content: "pre-msg-1", message: { id: "pre-1", role: "assistant", content: "pre-msg-1" } },
	{ index: 2, role: "user", ts: null, content: "pre-msg-2", message: { id: "pre-2", role: "user", content: "pre-msg-2" } },
];

let intersectionCallback: IntersectionObserverCallback;
let observerDisconnect: ReturnType<typeof vi.fn>;

class TestIntersectionObserver {
	readonly root = null;
	readonly rootMargin = "200px";
	readonly thresholds = [0];
	observe = vi.fn();
	unobserve = vi.fn();
	takeRecords = vi.fn(() => []);
	disconnect = observerDisconnect;

	constructor(callback: IntersectionObserverCallback) {
		intersectionCallback = callback;
	}
}

async function settle(element: PreCompactionHistory): Promise<void> {
	for (let attempt = 0; attempt < 4; attempt++) {
		await Promise.resolve();
		await element.updateComplete;
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	observerDisconnect = vi.fn();
	vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
	__resetGatewayConnectionForTests();
	localStorage.clear();
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	__resetGatewayConnectionForTests();
});

describe("PreCompactionHistory transient count recovery", () => {
	it("retries two compaction_not_found responses, expands in order, and releases observation and retry work", async () => {
		let countAttempts = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const verbose = new URL(url).searchParams.get("verbose") === "1";
			if (verbose) {
				return new Response(JSON.stringify({
					total: 3,
					returned: 3,
					nextCursor: null,
					messages: historyRows,
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			}

			countAttempts++;
			if (countAttempts <= 2 || countAttempts === 4) {
				return new Response(JSON.stringify({ error: "compaction_not_found" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({
				total: 3,
				returned: 1,
				nextCursor: 1,
				messages: [{
					index: 0,
					role: "user",
					ts: null,
					text: "pre-msg-0",
					author: { kind: "user", id: "user:local", label: "User" },
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		vi.stubGlobal("fetch", fetchMock);

		const element = new PreCompactionHistory();
		element.sessionId = "session-retry";
		element.compactionId = "compaction-retry";
		document.body.appendChild(element);
		await settle(element);

		intersectionCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
		await settle(element);
		expect(countAttempts).toBe(1);
		expect(element.querySelector("[data-testid='pre-compaction-history']")?.getAttribute("data-state"))
			.toBe("loading");
		expect(element.querySelector("[data-testid='pre-compaction-toggle']")).toBeNull();

		await vi.advanceTimersByTimeAsync(400);
		await settle(element);
		expect(countAttempts).toBe(2);
		expect(element.querySelector("[data-testid='pre-compaction-history']")?.getAttribute("data-state"))
			.toBe("loading");
		expect(element.querySelector("[data-testid='pre-compaction-toggle']")).toBeNull();

		await vi.advanceTimersByTimeAsync(800);
		await settle(element);
		expect(countAttempts).toBe(3);
		expect(observerDisconnect).toHaveBeenCalledTimes(1);
		expect(element.querySelector("[data-testid='pre-compaction-history']")?.getAttribute("data-state"))
			.toBe("collapsed");
		const toggle = element.querySelector<HTMLButtonElement>("[data-testid='pre-compaction-toggle']")!;
		expect(toggle.textContent).toContain("Show 3 messages before compaction");

		toggle.click();
		await settle(element);
		expect(element.querySelector("[data-testid='pre-compaction-history']")?.getAttribute("data-state"))
			.toBe("expanded");
		expect(Array.from(element.querySelectorAll("[data-testid='pre-compaction-rows'] user-message, [data-testid='pre-compaction-rows'] assistant-message"))
			.map((row) => row.textContent?.trim())).toEqual(["pre-msg-0", "pre-msg-1", "pre-msg-2"]);

		await element.refreshCount();
		await settle(element);
		expect(countAttempts).toBe(4);
		expect(vi.getTimerCount()).toBe(1);
		const callsBeforeDisconnect = fetchMock.mock.calls.length;
		element.remove();
		expect(observerDisconnect).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchMock).toHaveBeenCalledTimes(callsBeforeDisconnect);
	});
});
