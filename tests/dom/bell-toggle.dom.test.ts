import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests2/dom/_setup/custom-elements.js";
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

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function observeBellState(el: HTMLElement, title: RegExp, slashCount: number): { promise: Promise<void>; disconnect: () => void } {
	let observer: MutationObserver | undefined;
	const promise = new Promise<void>((resolve) => {
		const matches = () => el.querySelector("button")?.getAttribute("title")?.match(title)
			&& el.querySelectorAll(SLASH_PATH).length === slashCount;
		const resolveWhenMatched = () => {
			if (!matches()) return;
			observer?.disconnect();
			resolve();
		};
		observer = new MutationObserver(resolveWhenMatched);
		observer.observe(el, { attributes: true, childList: true, subtree: true });
		resolveWhenMatched();
	});
	return { promise, disconnect: () => observer?.disconnect() };
}

let putCalls: Array<{ url: string; method: string; body: string }>;
let preferencePutStarted: Deferred<{ url: string; method: string; body: string }>;
let preferencePutResponse: Deferred<Response>;
let preferencePutCompleted: Deferred<void>;
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
	preferencePutStarted = deferred<{ url: string; method: string; body: string }>();
	preferencePutResponse = deferred<Response>();
	preferencePutCompleted = deferred<void>();
	vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
		const call = { url: String(url), method: init?.method ?? "GET", body: init?.body };
		putCalls.push(call);
		if (/\/api\/preferences$/.test(call.url) && call.method === "PUT") {
			preferencePutStarted.resolve(call);
			return preferencePutResponse.promise.then((response) => {
				preferencePutCompleted.resolve();
				return response;
			});
		}
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
		const muted = observeBellState(el, /Unmute agent finish beeps/, 1);
		const putStarted = preferencePutStarted.promise;
		(el.querySelector("button") as HTMLButtonElement).click();
		await Promise.all([muted.promise, putStarted]);
		muted.disconnect();

		expect(el.querySelector("button")!.getAttribute("title")).toMatch(/Unmute agent finish beeps/);
		expect(el.querySelectorAll(SLASH_PATH).length).toBe(1);
		expect(document.documentElement.dataset.playAgentFinishSound).toBe("false");

		const put = putCalls.find(c => /\/api\/preferences$/.test(c.url) && c.method === "PUT");
		expect(put).toBeTruthy();
		expect(JSON.parse(put!.body)).toMatchObject({ playAgentFinishSound: false });
		preferencePutResponse.resolve(new Response("{}", { status: 200 }));
		await preferencePutCompleted.promise;
	});

	it("syncs when another surface dispatches the change event", async () => {
		const el = await mount();
		expect(el.querySelector("button")!.getAttribute("title")).toMatch(/Mute/);

		const unmuted = observeBellState(el, /Unmute/, 1);
		document.documentElement.dataset.playAgentFinishSound = "false";
		window.dispatchEvent(new CustomEvent("bobbit-play-finish-sound-changed", { detail: { enabled: false } }));
		await unmuted.promise;
		unmuted.disconnect();

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
		const muted = observeBellState(el, /Unmute agent finish beeps/, 1);
		const putStarted = preferencePutStarted.promise;

		(el.querySelector("button") as HTMLButtonElement).click();
		await Promise.all([muted.promise, putStarted]);
		muted.disconnect();

		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		expect(document.documentElement.dataset.playAgentFinishSound).toBe("false");
		expect(putCalls).toHaveLength(1);
		expect(putCalls[0].url).toMatch(/\/api\/preferences$/);
		expect(putCalls[0].method).toBe("PUT");
		expect(JSON.parse(putCalls[0].body)).toEqual({ playAgentFinishSound: false });
		expect(putCalls.some((call) => /\/api\/projects\//.test(call.url))).toBe(false);
		preferencePutResponse.resolve(new Response("{}", { status: 200 }));
		await preferencePutCompleted.promise;
	});
});
