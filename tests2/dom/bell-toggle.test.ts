import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/bell-toggle.spec.ts (v2-dom tier).
// Renders the REAL <bell-toggle> lit component under happy-dom (was an esbuild
// file:// bundle). The beep preference lives on documentElement.dataset and is
// persisted via gatewayFetch → window.fetch, which we stub to capture the PUT.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/ui/components/BellToggle.js";
import {
	__test as finishSoundTest,
	captureProjectPlayFinishSoundRead,
	getProjectPlayFinishSoundOverride,
	primeProjectPlayFinishSoundOverride,
} from "../../src/app/play-finish-sound.js";
import { state } from "../../src/app/state.js";

const SLASH_PATH = 'svg path[d="m2 2 20 20"]';
let putCalls: Array<{ url: string; method: string; body: string }>;
let originalActiveProjectId: typeof state.activeProjectId;
let projectSequence = 0;

function setActiveProjectOverride(rawValue: "true" | "false") {
	const projectId = `bell-project-${++projectSequence}`;
	state.activeProjectId = projectId;
	const revision = captureProjectPlayFinishSoundRead(projectId);
	expect(primeProjectPlayFinishSoundOverride(projectId, rawValue, revision)).toBe(true);
	return projectId;
}

beforeEach(() => {
	finishSoundTest.resetProjectOverrides();
	originalActiveProjectId = state.activeProjectId;
	delete document.documentElement.dataset.playAgentFinishSound; // unset ⇒ default ON
	putCalls = [];
	vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
		putCalls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
		return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
	delete document.documentElement.dataset.playAgentFinishSound;
	state.activeProjectId = originalActiveProjectId;
	finishSoundTest.resetProjectOverrides();
});

async function mount() {
	const el = document.createElement("bell-toggle") as any;
	document.body.appendChild(el);
	await el.updateComplete;
	return el as HTMLElement;
}

describe("<bell-toggle>", () => {
	it("defaults to enabled (Bell, no slash) and exposes a Mute action", async () => {
		const el = await mount();
		const btn = el.querySelector("button")!;
		expect(btn.getAttribute("title")).toMatch(/Mute agent finish beeps/);
		expect(el.querySelectorAll("svg path").length).toBe(2);
		expect(el.querySelectorAll(SLASH_PATH).length).toBe(0);
	});

	it("click mutes: swaps to BellOff, flips the dataset, and persists the preference", async () => {
		const el = await mount();
		(el.querySelector("button") as HTMLButtonElement).click();
		await (el as any).updateComplete;

		expect(el.querySelector("button")!.getAttribute("title")).toMatch(/Unmute agent finish beeps/);
		expect(el.querySelectorAll(SLASH_PATH).length).toBe(1);
		expect(document.documentElement.dataset.playAgentFinishSound).toBe("false");

		const put = putCalls.find(c => /\/api\/preferences$/.test(c.url) && c.method === "PUT");
		expect(put).toBeTruthy();
		expect(JSON.parse(put!.body)).toMatchObject({ playAgentFinishSound: false });
	});

	it("syncs when another surface dispatches the change event", async () => {
		const el = await mount();
		expect(el.querySelector("button")!.getAttribute("title")).toMatch(/Mute/);

		document.documentElement.dataset.playAgentFinishSound = "false";
		window.dispatchEvent(new CustomEvent("bobbit-play-finish-sound-changed", { detail: { enabled: false } }));
		await (el as any).updateComplete;

		expect(el.querySelector("button")!.getAttribute("title")).toMatch(/Unmute/);
		expect(el.querySelectorAll(SLASH_PATH).length).toBe(1);
	});

	it("stays globally on when the active project explicitly forces sound Off", async () => {
		const projectId = setActiveProjectOverride("false");
		document.documentElement.dataset.playAgentFinishSound = "true";
		const el = await mount();

		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		expect(el.querySelector("button")!.getAttribute("title")).toBe("Mute agent finish beeps");
		expect(el.querySelectorAll(SLASH_PATH)).toHaveLength(0);
		expect(document.documentElement.dataset.playAgentFinishSound).toBe("true");
	});

	it("stays globally off when the active project explicitly forces sound On", async () => {
		const projectId = setActiveProjectOverride("true");
		document.documentElement.dataset.playAgentFinishSound = "false";
		const el = await mount();

		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("on");
		expect(el.querySelector("button")!.getAttribute("title")).toBe("Unmute agent finish beeps");
		expect(el.querySelectorAll(SLASH_PATH)).toHaveLength(1);
		expect(document.documentElement.dataset.playAgentFinishSound).toBe("false");
	});

	it("clicking under an opposite project override PUTs only the global preference", async () => {
		const projectId = setActiveProjectOverride("false");
		document.documentElement.dataset.playAgentFinishSound = "true";
		const el = await mount();

		(el.querySelector("button") as HTMLButtonElement).click();
		await (el as any).updateComplete;

		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		expect(document.documentElement.dataset.playAgentFinishSound).toBe("false");
		expect(putCalls).toHaveLength(1);
		expect(putCalls[0].url).toMatch(/\/api\/preferences$/);
		expect(putCalls[0].method).toBe("PUT");
		expect(JSON.parse(putCalls[0].body)).toEqual({ playAgentFinishSound: false });
		expect(putCalls.some((call) => /\/api\/projects\//.test(call.url))).toBe(false);
	});
});
