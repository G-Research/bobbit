/**
 * Unit tests for src/app/play-finish-sound.ts — the shared read/write helper
 * behind the header <bell-toggle> and the Settings beep checkbox.
 *
 * Runs as a node:test with `document` / `window` / `localStorage` / `fetch`
 * mocked on globalThis (the module + its dependency-free gatewayFetch read
 * those bare globals).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	PLAY_FINISH_SOUND_CHANGED,
	isPlayFinishSoundEnabled,
	setPlayFinishSoundEnabled,
} from "../src/app/play-finish-sound.ts";

interface Captured { events: Array<{ type: string; detail: unknown }>; fetches: Array<{ url: string; init: RequestInit }>; }

function install(datasetInitial?: string): Captured {
	const dataset: Record<string, string> = {};
	if (datasetInitial !== undefined) dataset.playAgentFinishSound = datasetInitial;
	const captured: Captured = { events: [], fetches: [] };

	Object.defineProperty(globalThis, "document", {
		value: { documentElement: { dataset } },
		configurable: true, writable: true,
	});
	Object.defineProperty(globalThis, "window", {
		value: {
			location: { origin: "https://gw.test" },
			dispatchEvent: (e: { type: string; detail?: unknown }) => { captured.events.push({ type: e.type, detail: (e as any).detail }); return true; },
		},
		configurable: true, writable: true,
	});
	Object.defineProperty(globalThis, "localStorage", {
		value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
		configurable: true, writable: true,
	});
	Object.defineProperty(globalThis, "CustomEvent", {
		value: class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
		configurable: true, writable: true,
	});
	Object.defineProperty(globalThis, "fetch", {
		value: async (url: string, init: RequestInit) => { captured.fetches.push({ url, init }); return { ok: true, status: 200 } as Response; },
		configurable: true, writable: true,
	});
	return captured;
}

afterEach(() => {
	for (const k of ["document", "window", "localStorage", "CustomEvent", "fetch"]) {
		Object.defineProperty(globalThis, k, { value: undefined, configurable: true, writable: true });
	}
});

describe("play-finish-sound", () => {
	describe("isPlayFinishSoundEnabled", () => {
		it("defaults to enabled when the dataset flag is unset", () => {
			install();
			assert.equal(isPlayFinishSoundEnabled(), true);
		});
		it("is enabled when the dataset flag is 'true'", () => {
			install("true");
			assert.equal(isPlayFinishSoundEnabled(), true);
		});
		it("is disabled only when the dataset flag is exactly 'false'", () => {
			install("false");
			assert.equal(isPlayFinishSoundEnabled(), false);
		});
	});

	describe("setPlayFinishSoundEnabled", () => {
		it("mutes: writes dataset 'false', dispatches the change event, and PUTs the preference", async () => {
			const cap = install("true");
			await setPlayFinishSoundEnabled(false);

			assert.equal((globalThis as any).document.documentElement.dataset.playAgentFinishSound, "false");
			assert.equal(isPlayFinishSoundEnabled(), false);

			assert.equal(cap.events.length, 1);
			assert.equal(cap.events[0].type, PLAY_FINISH_SOUND_CHANGED);
			assert.deepEqual(cap.events[0].detail, { enabled: false });

			assert.equal(cap.fetches.length, 1);
			assert.match(cap.fetches[0].url, /\/api\/preferences$/);
			assert.equal(cap.fetches[0].init.method, "PUT");
			assert.deepEqual(JSON.parse(String(cap.fetches[0].init.body)), { playAgentFinishSound: false });
		});

		it("unmutes: writes dataset 'true', dispatches the event, and PUTs true", async () => {
			const cap = install("false");
			await setPlayFinishSoundEnabled(true);

			assert.equal((globalThis as any).document.documentElement.dataset.playAgentFinishSound, "true");
			assert.deepEqual(cap.events[0].detail, { enabled: true });
			assert.deepEqual(JSON.parse(String(cap.fetches[0].init.body)), { playAgentFinishSound: true });
		});

		it("still flips the dataset optimistically when the PUT rejects", async () => {
			const cap = install("true");
			(globalThis as any).fetch = async () => { throw new Error("network"); };
			await setPlayFinishSoundEnabled(false); // must not throw
			assert.equal((globalThis as any).document.documentElement.dataset.playAgentFinishSound, "false");
			assert.equal(cap.events[0].type, PLAY_FINISH_SOUND_CHANGED);
		});
	});
});
