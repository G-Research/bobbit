import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { afterEach, describe, expect, it } from "vitest";
import {
	PLAY_FINISH_SOUND_CHANGED,
	PROJECT_PLAY_FINISH_SOUND_KEY,
	__test as finishSoundTest,
	captureProjectPlayFinishSoundRead,
	ensureProjectPlayFinishSoundOverride,
	getProjectPlayFinishSoundOverride,
	isEffectivePlayFinishSoundEnabled,
	isPlayFinishSoundEnabled,
	isProjectPlayFinishSoundOverrideLoaded,
	primeProjectPlayFinishSoundOverride,
	setPlayFinishSoundEnabled,
	setProjectPlayFinishSoundOverride,
	type ProjectPlayFinishSoundOverride,
} from "../../src/app/play-finish-sound.ts";

interface CapturedEvent { type: string; detail: unknown }
interface CapturedFetch { url: string; path: string; init: RequestInit; body: any }
type FetchHandler = (call: CapturedFetch) => Promise<Response> | Response;

let sequence = 0;
const uniqueProject = (label: string) => `sound-${label}-${++sequence}`;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function install(datasetInitial?: string, handler?: FetchHandler) {
	const dataset: Record<string, string> = {};
	if (datasetInitial !== undefined) dataset.playAgentFinishSound = datasetInitial;
	const events: CapturedEvent[] = [];
	const fetches: CapturedFetch[] = [];

	Object.defineProperty(globalThis, "document", {
		value: { documentElement: { dataset } },
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "window", {
		value: {
			location: { origin: "https://gw.test" },
			dispatchEvent: (event: { type: string; detail?: unknown }) => {
				events.push({ type: event.type, detail: event.detail });
				return true;
			},
		},
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "localStorage", {
		value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "CustomEvent", {
		value: class {
			type: string;
			detail: unknown;
			constructor(type: string, init?: { detail?: unknown }) {
				this.type = type;
				this.detail = init?.detail;
			}
		},
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "fetch", {
		value: async (url: string, init: RequestInit = {}) => {
			const parsed = new URL(String(url), "https://gw.test");
			let body: any;
			if (typeof init.body === "string") {
				try { body = JSON.parse(init.body); } catch { body = init.body; }
			}
			const call = { url: String(url), path: parsed.pathname + parsed.search, init, body };
			fetches.push(call);
			return handler ? handler(call) : json({});
		},
		configurable: true,
		writable: true,
	});

	return { dataset, events, fetches };
}

function prime(projectId: string, override: ProjectPlayFinishSoundOverride): void {
	const raw = override === "on" ? "true" : override === "off" ? "false" : undefined;
	const revision = captureProjectPlayFinishSoundRead(projectId);
	expect(primeProjectPlayFinishSoundOverride(projectId, raw, revision)).toBe(true);
	expect(isProjectPlayFinishSoundOverrideLoaded(projectId)).toBe(true);
}

function projectPut(call: CapturedFetch, projectId: string): boolean {
	return call.path === `/api/projects/${projectId}/config` && call.init.method === "PUT";
}

afterEach(() => {
	finishSoundTest.resetProjectOverrides();
	for (const key of ["document", "window", "localStorage", "CustomEvent", "fetch"]) {
		Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true });
	}
});

describe("global agent-finish sound preference", () => {
	it("defaults on and only exact dataset false disables it", () => {
		install();
		expect(isPlayFinishSoundEnabled()).toBe(true);
		(globalThis as any).document.documentElement.dataset.playAgentFinishSound = "true";
		expect(isPlayFinishSoundEnabled()).toBe(true);
		(globalThis as any).document.documentElement.dataset.playAgentFinishSound = "false";
		expect(isPlayFinishSoundEnabled()).toBe(false);
	});

	it("optimistically updates the global dataset/event and persists only the global preference", async () => {
		const captured = install("true");
		await setPlayFinishSoundEnabled(false);

		expect(captured.dataset.playAgentFinishSound).toBe("false");
		expect(captured.events).toEqual([{ type: PLAY_FINISH_SOUND_CHANGED, detail: { enabled: false } }]);
		expect(captured.fetches).toHaveLength(1);
		expect(captured.fetches[0].path).toBe("/api/preferences");
		expect(captured.fetches[0].init.method).toBe("PUT");
		expect(captured.fetches[0].body).toEqual({ playAgentFinishSound: false });
	});

	it("keeps the optimistic global value when preference persistence rejects", async () => {
		const captured = install("true", () => Promise.reject(new Error("network")));
		await expect(setPlayFinishSoundEnabled(false)).resolves.toBeUndefined();
		expect(captured.dataset.playAgentFinishSound).toBe("false");
		expect(captured.events[0]?.type).toBe(PLAY_FINISH_SOUND_CHANGED);
	});
});

describe("effective project sound precedence", () => {
	for (const globalEnabled of [true, false]) {
		for (const [override, expected] of [
			["inherit", globalEnabled],
			["on", true],
			["off", false],
		] as const) {
			it(`${override} with global ${globalEnabled ? "on" : "off"} resolves ${expected ? "on" : "off"}`, async () => {
				install(globalEnabled ? "true" : "false");
				const projectId = uniqueProject(`${override}-${globalEnabled}`);
				prime(projectId, override);
				await expect(isEffectivePlayFinishSoundEnabled({ projectId })).resolves.toBe(expected);
			});
		}
	}

	it("defaults on when both a confirmed inherited project and the global dataset are unset", async () => {
		install();
		const projectId = uniqueProject("default-on");
		prime(projectId, "inherit");
		await expect(isEffectivePlayFinishSoundEnabled({ projectId })).resolves.toBe(true);
	});

	it("missing or blank source falls back globally without a project request", async () => {
		const captured = install("false");
		await expect(isEffectivePlayFinishSoundEnabled()).resolves.toBe(false);
		await expect(isEffectivePlayFinishSoundEnabled({})).resolves.toBe(false);
		await expect(isEffectivePlayFinishSoundEnabled({ projectId: "  " })).resolves.toBe(false);
		expect(captured.fetches).toHaveLength(0);
	});

	it("a known project falls back globally only after its lookup explicitly fails", async () => {
		const lookup = deferred<Response>();
		const projectId = uniqueProject("failed-known");
		install("false", (call) => call.path.includes(`/api/projects/${projectId}/config`)
			? lookup.promise
			: json({}));
		let settled = false;
		const result = isEffectivePlayFinishSoundEnabled({ projectId }).then((value) => {
			settled = true;
			return value;
		});
		await flush();
		expect(settled).toBe(false);
		lookup.resolve(json({ error: "missing" }, 404));
		await expect(result).resolves.toBe(false);
	});

	it("strictly parses true/false and establishes inherit for missing or malformed successful values", () => {
		install("false");
		const cases: Array<[unknown, ProjectPlayFinishSoundOverride]> = [
			["true", "on"],
			["false", "off"],
			[undefined, "inherit"],
			[null, "inherit"],
			[true, "inherit"],
			["TRUE", "inherit"],
			["invalid", "inherit"],
		];
		for (const [raw, expected] of cases) {
			const projectId = uniqueProject("strict-parse");
			const revision = captureProjectPlayFinishSoundRead(projectId);
			expect(primeProjectPlayFinishSoundOverride(projectId, raw, revision)).toBe(true);
			expect(getProjectPlayFinishSoundOverride(projectId)).toBe(expected);
			expect(isProjectPlayFinishSoundOverrideLoaded(projectId)).toBe(true);
		}
	});
});

describe("project override loader lifecycle and stale reads", () => {
	it("deduplicates a pending cold load, waits rather than using global, and retains the accepted baseline", async () => {
		const projectId = uniqueProject("dedupe");
		const response = deferred<Response>();
		const captured = install("true", (call) => call.path === `/api/projects/${projectId}/config`
			? response.promise
			: json({}));
		let ensureOneSettled = false;
		let ensureTwoSettled = false;
		let effectiveSettled = false;
		const first = ensureProjectPlayFinishSoundOverride(projectId).then((value) => { ensureOneSettled = true; return value; });
		const second = ensureProjectPlayFinishSoundOverride(projectId).then((value) => { ensureTwoSettled = true; return value; });
		const effective = isEffectivePlayFinishSoundEnabled({ projectId }).then((value) => { effectiveSettled = true; return value; });
		await flush();

		expect(captured.fetches.filter((call) => call.path === `/api/projects/${projectId}/config`)).toHaveLength(1);
		expect([ensureOneSettled, ensureTwoSettled, effectiveSettled]).toEqual([false, false, false]);
		response.resolve(json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "false" }));
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
		await expect(effective).resolves.toBe(false);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");

		await expect(ensureProjectPlayFinishSoundOverride(projectId)).resolves.toBe(true);
		expect(captured.fetches.filter((call) => call.path === `/api/projects/${projectId}/config`)).toHaveLength(1);
	});

	it("removes a failed loader so a later call retries and accepts an explicit value", async () => {
		const projectId = uniqueProject("retry");
		let attempts = 0;
		const captured = install("false", (call) => {
			if (call.path === `/api/projects/${projectId}/config`) {
				attempts += 1;
				return attempts === 1 ? json({ error: "temporary" }, 503) : json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "true" });
			}
			return json({});
		});

		await expect(ensureProjectPlayFinishSoundOverride(projectId)).resolves.toBe(false);
		expect(isProjectPlayFinishSoundOverrideLoaded(projectId)).toBe(false);
		await expect(ensureProjectPlayFinishSoundOverride(projectId)).resolves.toBe(true);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("on");
		expect(captured.fetches.filter((call) => call.path === `/api/projects/${projectId}/config`)).toHaveLength(2);
	});

	it("discards a runtime GET started before a successful write", async () => {
		const projectId = uniqueProject("runtime-stale");
		const oldGet = deferred<Response>();
		install("false", (call) => {
			if (call.path === `/api/projects/${projectId}/config` && call.init.method !== "PUT") return oldGet.promise;
			if (projectPut(call, projectId)) return json({ ok: true });
			return json({});
		});

		const load = ensureProjectPlayFinishSoundOverride(projectId);
		await flush();
		await expect(setProjectPlayFinishSoundOverride(projectId, "on")).resolves.toBe(true);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("on");
		oldGet.resolve(json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "false" }));
		await expect(load).resolves.toBe(true);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("on");
		await expect(isEffectivePlayFinishSoundEnabled({ projectId })).resolves.toBe(true);
	});

	it("rejects a read captured during a mutation even when the queue is empty by completion", async () => {
		const projectId = uniqueProject("settlement-stale");
		install("true");
		prime(projectId, "off");
		const write = setProjectPlayFinishSoundOverride(projectId, "on");
		const capturedDuringMutation = captureProjectPlayFinishSoundRead(projectId);
		await expect(write).resolves.toBe(true);
		expect(primeProjectPlayFinishSoundOverride(projectId, "false", capturedDuringMutation)).toBe(false);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("on");
	});

	it("accepts at most one of two reads captured at the same revision", () => {
		install();
		const projectId = uniqueProject("competing-reads");
		const revision = captureProjectPlayFinishSoundRead(projectId);
		expect(primeProjectPlayFinishSoundOverride(projectId, "true", revision)).toBe(true);
		expect(primeProjectPlayFinishSoundOverride(projectId, "false", revision)).toBe(false);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("on");
	});
});

describe("serialized project override mutations", () => {
	it("uses exact string/null payloads and applies every selection immediately", async () => {
		const projectId = uniqueProject("payloads");
		const captured = install("true");
		prime(projectId, "inherit");

		const on = setProjectPlayFinishSoundOverride(projectId, "on");
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("on");
		await expect(on).resolves.toBe(true);
		const off = setProjectPlayFinishSoundOverride(projectId, "off");
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		await expect(off).resolves.toBe(true);
		const inherit = setProjectPlayFinishSoundOverride(projectId, "inherit");
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("inherit");
		await expect(inherit).resolves.toBe(true);

		const puts = captured.fetches.filter((call) => projectPut(call, projectId));
		expect(puts.map((call) => call.body)).toEqual([
			{ [PROJECT_PLAY_FINISH_SOUND_KEY]: "true" },
			{ [PROJECT_PLAY_FINISH_SOUND_KEY]: "false" },
			{ [PROJECT_PLAY_FINISH_SOUND_KEY]: null },
		]);
	});

	it("serializes one project's transports, keeps latest queued visibility, returns per-request results, and lets another project proceed", async () => {
		const projectId = uniqueProject("serialized");
		const otherProjectId = uniqueProject("parallel-project");
		const responses = [deferred<Response>(), deferred<Response>()];
		const otherResponse = deferred<Response>();
		let projectStarts = 0;
		let otherStarts = 0;
		install("true", (call) => {
			if (projectPut(call, projectId)) return responses[projectStarts++].promise;
			if (projectPut(call, otherProjectId)) { otherStarts += 1; return otherResponse.promise; }
			return json({});
		});
		prime(projectId, "inherit");
		prime(otherProjectId, "inherit");

		const first = setProjectPlayFinishSoundOverride(projectId, "on");
		const second = setProjectPlayFinishSoundOverride(projectId, "off");
		const other = setProjectPlayFinishSoundOverride(otherProjectId, "off");
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		// Enqueue is synchronous even though each transport begins on its project tail.
		expect(projectStarts).toBe(0);
		expect(otherStarts).toBe(0);
		await flush();
		expect(projectStarts).toBe(1);
		expect(otherStarts).toBe(1);

		responses[0].resolve(json({ ok: true }));
		await expect(first).resolves.toBe(true);
		await flush();
		expect(projectStarts).toBe(2);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		responses[1].resolve(json({ error: "rejected" }, 500));
		otherResponse.resolve(json({ ok: true }));
		await expect(second).resolves.toBe(false);
		await expect(other).resolves.toBe(true);
		// The first successful request is the confirmed baseline after the newer request fails.
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("on");
		expect(getProjectPlayFinishSoundOverride(otherProjectId)).toBe("off");
	});

	it("confirmed Inherit -> On failure -> Off failure ends at Inherit", async () => {
		const projectId = uniqueProject("double-fail-inherit");
		const responses = [deferred<Response>(), deferred<Response>()];
		let starts = 0;
		install("true", (call) => projectPut(call, projectId) ? responses[starts++].promise : json({}));
		prime(projectId, "inherit");

		const on = setProjectPlayFinishSoundOverride(projectId, "on");
		const off = setProjectPlayFinishSoundOverride(projectId, "off");
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		expect(finishSoundTest.getProjectState(projectId)).toMatchObject({ confirmed: "inherit", pending: ["on", "off"] });
		responses[0].resolve(json({ error: "on failed" }, 500));
		await expect(on).resolves.toBe(false);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		expect(finishSoundTest.getProjectState(projectId)).toMatchObject({ confirmed: "inherit", pending: ["off"] });
		responses[1].resolve(json({ error: "off failed" }, 500));
		await expect(off).resolves.toBe(false);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("inherit");
		expect(finishSoundTest.getProjectState(projectId)).toMatchObject({ confirmed: "inherit", pending: [] });
	});

	it("confirmed Off -> On failure -> Inherit failure ends at Off", async () => {
		const projectId = uniqueProject("double-fail-off");
		const responses = [deferred<Response>(), deferred<Response>()];
		let starts = 0;
		install("false", (call) => projectPut(call, projectId) ? responses[starts++].promise : json({}));
		prime(projectId, "off");

		const on = setProjectPlayFinishSoundOverride(projectId, "on");
		const inherit = setProjectPlayFinishSoundOverride(projectId, "inherit");
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("inherit");
		expect(finishSoundTest.getProjectState(projectId)).toMatchObject({ confirmed: "off", pending: ["on", "inherit"] });
		responses[0].resolve(json({ error: "on failed" }, 500));
		await expect(on).resolves.toBe(false);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("inherit");
		expect(finishSoundTest.getProjectState(projectId)).toMatchObject({ confirmed: "off", pending: ["inherit"] });
		responses[1].resolve(json({ error: "inherit failed" }, 500));
		await expect(inherit).resolves.toBe(false);
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		expect(finishSoundTest.getProjectState(projectId)).toMatchObject({ confirmed: "off", pending: [] });
	});

	it("A/B/A/B with success/failure/failure/success keeps newest B visible and ends at confirmed B", async () => {
		const projectId = uniqueProject("mixed");
		const responses = Array.from({ length: 4 }, () => deferred<Response>());
		let starts = 0;
		const captured = install("true", (call) => projectPut(call, projectId) ? responses[starts++].promise : json({}));
		prime(projectId, "inherit");

		const results = [
			setProjectPlayFinishSoundOverride(projectId, "on"),
			setProjectPlayFinishSoundOverride(projectId, "off"),
			setProjectPlayFinishSoundOverride(projectId, "on"),
			setProjectPlayFinishSoundOverride(projectId, "off"),
		];
		expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
		const expectedConfirmed: ProjectPlayFinishSoundOverride[] = ["on", "on", "on", "off"];
		for (const [index, status] of [200, 500, 500, 200].entries()) {
			responses[index].resolve(status === 200 ? json({ ok: true }) : json({ error: "failed" }, status));
			await expect(results[index]).resolves.toBe(status === 200);
			expect(getProjectPlayFinishSoundOverride(projectId)).toBe("off");
			expect(finishSoundTest.getProjectState(projectId).confirmed).toBe(expectedConfirmed[index]);
			await flush();
		}
		expect(await Promise.all(results)).toEqual([true, false, false, true]);
		expect(captured.fetches.filter((call) => projectPut(call, projectId)).map((call) => call.body[PROJECT_PLAY_FINISH_SOUND_KEY]))
			.toEqual(["true", "false", "true", "false"]);
	});

	it("a project override never mutates the global dataset or emits the global change event", async () => {
		const projectId = uniqueProject("global-isolation");
		const captured = install("false");
		prime(projectId, "inherit");
		await expect(setProjectPlayFinishSoundOverride(projectId, "on")).resolves.toBe(true);
		expect(captured.dataset.playAgentFinishSound).toBe("false");
		expect(captured.events.filter((event) => event.type === PLAY_FINISH_SOUND_CHANGED)).toHaveLength(0);
		expect(captured.fetches.some((call) => call.path === "/api/preferences")).toBe(false);
	});
});
