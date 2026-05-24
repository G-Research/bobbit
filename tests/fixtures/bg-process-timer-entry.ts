import "../../src/ui/components/BgProcessPill.js";
import type { BgProcessPill, BgProcessInfo } from "../../src/ui/components/BgProcessPill.js";

type BgProcessInfoWithEndTime = BgProcessInfo & { endTime?: number | null };

const fetchCalls: Array<{ url: string; method: string; headers?: HeadersInit }> = [];
let mockLogs: Array<{ ts: number; text: string }> = [];

const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const url = String(input);
	fetchCalls.push({ url, method: init?.method || "GET", headers: init?.headers });

	if (url.includes("/logs")) {
		return new Response(JSON.stringify({ log: mockLogs }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	if (url.includes("/kill")) {
		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	return originalFetch(input, init);
};

function container(): HTMLElement {
	const el = document.getElementById("pill-container");
	if (!el) throw new Error("missing #pill-container");
	return el;
}

function createPill(processInfo: BgProcessInfoWithEndTime, sessionId = "test-session"): BgProcessPill {
	const pill = document.createElement("bg-process-pill") as BgProcessPill;
	pill.sessionId = sessionId;
	pill.process = processInfo as BgProcessInfo;
	container().appendChild(pill);
	return pill;
}

function clearPills(): void {
	container().innerHTML = "";
	document.querySelectorAll("[data-bg-portal], #bg-process-dropdown").forEach((el) => el.remove());
	fetchCalls.length = 0;
	mockLogs = [];
}

async function forceBgTimerRerender(): Promise<void> {
	const pill = document.querySelector("bg-process-pill") as (BgProcessPill & { _renderPortal?: () => void }) | null;
	pill?.requestUpdate?.();
	await pill?.updateComplete;
	pill?._renderPortal?.();

	const timer = document.querySelector("#bg-process-dropdown live-timer") as (HTMLElement & { requestUpdate?: () => void; updateComplete?: Promise<unknown> }) | null;
	timer?.requestUpdate?.();
	await timer?.updateComplete;
}

function setMockLogs(logs: Array<{ ts: number; text: string }>): void {
	mockLogs = logs;
}

function getFetchCalls(): Array<{ url: string; method: string; headers?: HeadersInit }> {
	return [...fetchCalls];
}

Object.assign(window, {
	createPill,
	clearPills,
	forceBgTimerRerender,
	setMockLogs,
	getFetchCalls,
	__bgTimerReady: true,
});
