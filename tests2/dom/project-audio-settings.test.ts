import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { renderSettingsPage } from "../../src/app/settings-page.js";
import {
	PROJECT_PLAY_FINISH_SOUND_KEY,
	__test as finishSoundTest,
	getProjectPlayFinishSoundOverride,
	isEffectivePlayFinishSoundEnabled,
	isProjectPlayFinishSoundOverrideLoaded,
	setProjectPlayFinishSoundOverride,
	type ProjectPlayFinishSoundOverride,
} from "../../src/app/play-finish-sound.js";
import { setRenderApp, state, type Project } from "../../src/app/state.js";

interface FetchCall {
	path: string;
	method: string;
	body: any;
}

type FetchResponder = (call: FetchCall) => Promise<Response> | Response;

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

async function waitFor(predicate: () => boolean, label: string, timeout = 3000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

let projectSequence = 0;
function makeProject(label: string): Project {
	const id = `settings-sound-${label}-${++projectSequence}`;
	return {
		id,
		name: `Project ${label}`,
		rootPath: `/projects/${label}`,
		colorLight: "#888888",
		colorDark: "#aaaaaa",
	};
}

function container(): HTMLElement {
	let element = document.getElementById("project-audio-settings-root");
	if (!element) {
		element = document.createElement("div");
		element.id = "project-audio-settings-root";
		document.body.appendChild(element);
	}
	return element;
}

function doRender(): void {
	render(renderSettingsPage(), container());
}

function select(): HTMLSelectElement | null {
	return container().querySelector<HTMLSelectElement>('[data-testid="project-play-finish-sound"]');
}

function soundStatus(): HTMLElement | null {
	return container().querySelector<HTMLElement>('[data-testid="project-play-finish-sound-status"]');
}

function retryButton(): HTMLButtonElement | null {
	return container().querySelector<HTMLButtonElement>('[data-testid="project-play-finish-sound-retry"]');
}

function choose(value: ProjectPlayFinishSoundOverride): void {
	const control = select();
	if (!control) throw new Error("project sound select is missing");
	control.value = value;
	control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function installFetch(responder: FetchResponder): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.stubGlobal("fetch", async (input: any, init: RequestInit = {}) => {
		const url = new URL(String(input), window.location.origin);
		const method = (init.method ?? "GET").toUpperCase();
		let body: any;
		if (typeof init.body === "string") {
			try { body = JSON.parse(init.body); } catch { body = init.body; }
		}
		const call = { path: url.pathname + url.search, method, body };
		calls.push(call);
		// Project General renders the existing sandbox section too. Keep that
		// unrelated external seam well-typed so it cannot obscure sound behavior.
		if (call.path === "/api/sandbox/host-tokens") return json([]);
		return responder(call);
	});
	return calls;
}

function defaultSettingsResponse(call: FetchCall, project: Project, raw: Record<string, unknown> = {}): Response {
	if (call.path === `/api/projects/${project.id}/config`) return json(raw);
	if (call.path === `/api/projects/${project.id}/config/resolved`) return json({});
	if (call.path === "/api/harness/status") return json({ available: false });
	return json({});
}

function openProject(project: Project): void {
	state.projects = [project];
	state.activeProjectId = project.id;
	window.location.hash = `#/settings/${project.id}/general`;
	doRender();
}

async function waitUntilLoaded(expected: ProjectPlayFinishSoundOverride): Promise<HTMLSelectElement> {
	await waitFor(() => !!select() && !select()!.disabled && select()!.value === expected, `loaded ${expected} sound select`);
	return select()!;
}

let original: {
	projects: typeof state.projects;
	activeProjectId: typeof state.activeProjectId;
};

beforeEach(() => {
	original = { projects: state.projects, activeProjectId: state.activeProjectId };
	finishSoundTest.resetProjectOverrides();
	delete document.documentElement.dataset.playAgentFinishSound;
	setRenderApp(doRender);
});

afterEach(() => {
	setRenderApp(() => {});
	state.projects = original.projects;
	state.activeProjectId = original.activeProjectId;
	window.location.hash = "";
	document.body.innerHTML = "";
	delete document.documentElement.dataset.playAgentFinishSound;
	finishSoundTest.resetProjectOverrides();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Project Settings > General agent finish sound", () => {
	it("renders loading, then all three exact states with inherited global/source/audio-only help", async () => {
		const project = makeProject("states");
		const raw = deferred<Response>();
		const resolved = deferred<Response>();
		document.documentElement.dataset.playAgentFinishSound = "true";
		installFetch((call) => {
			if (call.path === `/api/projects/${project.id}/config`) return raw.promise;
			if (call.path === `/api/projects/${project.id}/config/resolved`) return resolved.promise;
			return json({});
		});

		openProject(project);
		expect(select()).not.toBeNull();
		expect(select()!.disabled).toBe(true);
		expect(select()!.getAttribute("aria-busy")).toBe("true");
		expect(soundStatus()?.textContent).toMatch(/Loading sound setting/);

		raw.resolve(json({}));
		resolved.resolve(json({}));
		const control = await waitUntilLoaded("inherit");
		expect([...control.options].map((option) => [option.value, option.textContent])).toEqual([
			["inherit", "Inherit global"],
			["on", "On"],
			["off", "Off"],
		]);
		expect(control.getAttribute("aria-describedby")).toContain("project-play-finish-sound-help");
		expect(container().textContent).toContain("Agent finish sound");
		expect(container().textContent).toContain("currently On");
		expect(container().textContent).toContain(`Sessions owned by ${project.name} use this setting even when another project is open.`);
		expect(container().textContent).toContain("Audio only. Favicon badges, unread indicators, and other notifications are unaffected.");
		expect(getProjectPlayFinishSoundOverride(project.id)).toBe("inherit");
	});

	it("autosaves On, Off, and Inherit with exact string/null payloads", async () => {
		const project = makeProject("payloads");
		const calls = installFetch((call) => defaultSettingsResponse(call, project));
		openProject(project);
		await waitUntilLoaded("inherit");

		for (const [index, value] of (["on", "off", "inherit"] as const).entries()) {
			choose(value);
			await waitFor(() => {
				const puts = calls.filter((call) => call.path === `/api/projects/${project.id}/config` && call.method === "PUT");
				return puts.length === index + 1
					&& !select()!.disabled
					&& select()!.value === value
					&& /Saved\./.test(soundStatus()?.textContent ?? "");
			}, `saved ${value}`);
			expect(getProjectPlayFinishSoundOverride(project.id)).toBe(value);
		}

		const puts = calls.filter((call) => call.path === `/api/projects/${project.id}/config` && call.method === "PUT");
		expect(puts.map((call) => call.body)).toEqual([
			{ [PROJECT_PLAY_FINISH_SOUND_KEY]: "true" },
			{ [PROJECT_PLAY_FINISH_SOUND_KEY]: "false" },
			{ [PROJECT_PLAY_FINISH_SOUND_KEY]: null },
		]);
		expect(isProjectPlayFinishSoundOverrideLoaded(project.id)).toBe(true);
		expect(getProjectPlayFinishSoundOverride(project.id)).toBe("inherit");
	});

	it("applies a queued choice immediately and disables only the sound control while its PUT is pending", async () => {
		const project = makeProject("immediate");
		const put = deferred<Response>();
		document.documentElement.dataset.playAgentFinishSound = "false";
		installFetch((call) => {
			if (call.path === `/api/projects/${project.id}/config` && call.method === "PUT") return put.promise;
			return defaultSettingsResponse(call, project);
		});
		openProject(project);
		await waitUntilLoaded("inherit");

		choose("on");
		expect(getProjectPlayFinishSoundOverride(project.id)).toBe("on");
		await expect(isEffectivePlayFinishSoundEnabled({ projectId: project.id })).resolves.toBe(true);
		await waitFor(() => select()!.disabled && select()!.value === "on", "optimistic saving selection");
		expect(soundStatus()?.textContent).toMatch(/Saving/);
		const workingDirectory = container().querySelector<HTMLInputElement>('input[type="text"]');
		expect(workingDirectory?.disabled).toBe(false);

		put.resolve(json({ ok: true }));
		await waitFor(() => !select()!.disabled && /Saved\./.test(soundStatus()?.textContent ?? ""), "successful sound autosave");
		expect(select()!.value).toBe("on");
	});

	it("discards a stale Settings raw GET without losing unrelated raw fields", async () => {
		const project = makeProject("stale-read");
		const oldRaw = deferred<Response>();
		const calls = installFetch((call) => {
			if (call.path === `/api/projects/${project.id}/config` && call.method === "GET") return oldRaw.promise;
			if (call.path === `/api/projects/${project.id}/config` && call.method === "PUT") return json({ ok: true });
			if (call.path === `/api/projects/${project.id}/config/resolved`) {
				return json({ unrelated_key: { value: "preserved", source: "project" } });
			}
			return json({});
		});
		document.documentElement.dataset.playAgentFinishSound = "false";
		openProject(project);
		expect(select()?.disabled).toBe(true);

		await expect(setProjectPlayFinishSoundOverride(project.id, "on")).resolves.toBe(true);
		oldRaw.resolve(json({
			[PROJECT_PLAY_FINISH_SOUND_KEY]: "false",
			unrelated_key: "preserved",
		}));
		await waitUntilLoaded("on");
		expect(getProjectPlayFinishSoundOverride(project.id)).toBe("on");
		await expect(isEffectivePlayFinishSoundEnabled({ projectId: project.id })).resolves.toBe(true);

		window.location.hash = `#/settings/${project.id}/project`;
		doRender();
		await waitFor(() => container().textContent?.includes("unrelated_key") ?? false, "unrelated raw Settings field");
		expect([...container().querySelectorAll<HTMLInputElement>('input[type="text"]')].some((input) => input.value === "preserved")).toBe(true);
		expect(calls.filter((call) => call.path === `/api/projects/${project.id}/config` && call.method === "GET")).toHaveLength(1);
	});

	it("retains the confirmed selection across project navigation without reloading its raw config", async () => {
		const first = makeProject("navigation-a");
		const second = makeProject("navigation-b");
		const calls = installFetch((call) => {
			if (call.path === `/api/projects/${first.id}/config`) return call.method === "PUT" ? json({ ok: true }) : json({});
			if (call.path === `/api/projects/${first.id}/config/resolved`) return json({});
			if (call.path === `/api/projects/${second.id}/config`) return json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "false" });
			if (call.path === `/api/projects/${second.id}/config/resolved`) return json({});
			return json({});
		});
		state.projects = [first, second];
		state.activeProjectId = first.id;
		window.location.hash = `#/settings/${first.id}/general`;
		doRender();
		await waitUntilLoaded("inherit");
		choose("on");
		await waitFor(() => !select()!.disabled && select()!.value === "on", "first project saved On");

		window.location.hash = `#/settings/${second.id}/general`;
		doRender();
		await waitUntilLoaded("off");
		window.location.hash = `#/settings/${first.id}/general`;
		doRender();
		await waitUntilLoaded("on");
		expect(calls.filter((call) => call.path === `/api/projects/${first.id}/config` && call.method === "GET")).toHaveLength(1);
	});

	it("offers Retry after a raw load failure and enables the value loaded by the retry", async () => {
		const project = makeProject("load-retry");
		let rawAttempts = 0;
		installFetch((call) => {
			if (call.path === `/api/projects/${project.id}/config`) {
				rawAttempts += 1;
				return rawAttempts === 1
					? json({ error: "temporary" }, 503)
					: json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "true" });
			}
			if (call.path === `/api/projects/${project.id}/config/resolved`) return json({});
			return json({});
		});
		openProject(project);

		await waitFor(() => !!retryButton(), "load Retry button");
		expect(select()?.disabled).toBe(true);
		expect(soundStatus()?.textContent).toContain("Couldn’t load the sound setting.");
		retryButton()!.click();
		await waitUntilLoaded("on");
		expect(rawAttempts).toBe(2);
		expect(retryButton()).toBeNull();
	});

	it("reverts a failed save to the confirmed baseline and retries the failed desired value", async () => {
		const project = makeProject("save-retry");
		let putAttempts = 0;
		const calls = installFetch((call) => {
			if (call.path === `/api/projects/${project.id}/config` && call.method === "PUT") {
				putAttempts += 1;
				return putAttempts === 1 ? json({ error: "rejected" }, 500) : json({ ok: true });
			}
			return defaultSettingsResponse(call, project, { [PROJECT_PLAY_FINISH_SOUND_KEY]: "false" });
		});
		openProject(project);
		await waitUntilLoaded("off");

		choose("on");
		await waitFor(() => !!retryButton() && select()!.value === "off", "failed save rollback");
		expect(soundStatus()?.textContent).toContain("Couldn’t save. Reverted to Off.");
		expect(getProjectPlayFinishSoundOverride(project.id)).toBe("off");
		retryButton()!.click();
		await waitFor(() => !select()!.disabled && select()!.value === "on" && /Saved\./.test(soundStatus()?.textContent ?? ""), "successful save retry");
		expect(putAttempts).toBe(2);
		expect(calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
			{ [PROJECT_PLAY_FINISH_SOUND_KEY]: "true" },
			{ [PROJECT_PLAY_FINISH_SOUND_KEY]: "true" },
		]);
	});

	for (const scenario of [
		{
			name: "Inherit -> On failure -> Off failure ends Inherit",
			baselineRaw: undefined,
			first: "on" as const,
			second: "off" as const,
			pending: "off" as const,
			final: "inherit" as const,
		},
		{
			name: "Off -> On failure -> Inherit failure ends Off",
			baselineRaw: "false",
			first: "on" as const,
			second: "inherit" as const,
			pending: "inherit" as const,
			final: "off" as const,
		},
	]) {
		it(`renders the shared queue correctly when ${scenario.name}`, async () => {
			const project = makeProject(`queue-${scenario.final}`);
			const responses = [deferred<Response>(), deferred<Response>()];
			let starts = 0;
			installFetch((call) => {
				if (call.path === `/api/projects/${project.id}/config` && call.method === "PUT") return responses[starts++].promise;
				return defaultSettingsResponse(call, project, scenario.baselineRaw === undefined
					? {}
					: { [PROJECT_PLAY_FINISH_SOUND_KEY]: scenario.baselineRaw });
			});
			openProject(project);
			await waitUntilLoaded(scenario.final);

			const first = setProjectPlayFinishSoundOverride(project.id, scenario.first);
			const second = setProjectPlayFinishSoundOverride(project.id, scenario.second);
			doRender();
			expect(select()?.value).toBe(scenario.pending);
			responses[0].resolve(json({ error: "first rejected" }, 500));
			await expect(first).resolves.toBe(false);
			doRender();
			expect(select()?.value).toBe(scenario.pending);
			responses[1].resolve(json({ error: "second rejected" }, 500));
			await expect(second).resolves.toBe(false);
			doRender();
			expect(select()?.value).toBe(scenario.final);
			expect(getProjectPlayFinishSoundOverride(project.id)).toBe(scenario.final);
		});
	}

	it("hides the raw project sound key from the generic Commands editor", async () => {
		const project = makeProject("hidden-key");
		installFetch((call) => {
			if (call.path === `/api/projects/${project.id}/config`) {
				return json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "false", visible_custom_key: "shown" });
			}
			if (call.path === `/api/projects/${project.id}/config/resolved`) {
				return json({
					[PROJECT_PLAY_FINISH_SOUND_KEY]: { value: "false", source: "project" },
					visible_custom_key: { value: "shown", source: "project" },
				});
			}
			return json({});
		});
		openProject(project);
		await waitUntilLoaded("off");
		window.location.hash = `#/settings/${project.id}/project`;
		doRender();
		await waitFor(() => container().textContent?.includes("visible_custom_key") ?? false, "Commands editor");
		expect(container().textContent).not.toContain(PROJECT_PLAY_FINISH_SOUND_KEY);
		expect([...container().querySelectorAll<HTMLInputElement>('input[type="text"]')].some((input) => input.value === "shown")).toBe(true);
	});
});
