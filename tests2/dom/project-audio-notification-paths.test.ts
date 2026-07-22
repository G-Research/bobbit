import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshSessions } from "../../src/app/api.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import { setRenderApp, state, type GatewaySession } from "../../src/app/state.js";
import {
	PROJECT_PLAY_FINISH_SOUND_KEY,
	__test as finishSoundTest,
} from "../../src/app/play-finish-sound.js";

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

async function waitFor(predicate: () => boolean, label: string, timeout = 2000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function session(id: string, projectId: string, status = "idle"): GatewaySession {
	return {
		id,
		projectId,
		status,
		title: id,
		cwd: "/tmp",
		createdAt: 1,
		lastActivity: 2,
		clientCount: 0,
	};
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	currentTime = 0;
	destination = {};
	constructor() { FakeAudioContext.instances.push(this); }
	createOscillator() {
		return {
			type: "",
			frequency: { value: 0 },
			connect: (target: unknown) => target,
			start: () => {},
			stop: () => {},
		};
	}
	createGain() {
		return {
			gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
			connect: (target: unknown) => target,
		};
	}
	close() { return Promise.resolve(); }
}

class ImmediatelyLoadedImage {
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	crossOrigin = "";
	set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}

let originalState: {
	gatewaySessions: GatewaySession[];
	goals: typeof state.goals;
	projects: typeof state.projects;
	activeProjectId: typeof state.activeProjectId;
	selectedSessionId: typeof state.selectedSessionId;
	remoteAgent: typeof state.remoteAgent;
	sessionsGeneration: number;
	goalsGeneration: number;
	sessionsLoading: boolean;
	sessionsError: string;
};
let badgeCalls: ReturnType<typeof vi.fn>;

beforeEach(() => {
	finishSoundTest.resetProjectOverrides();
	originalState = {
		gatewaySessions: state.gatewaySessions,
		goals: state.goals,
		projects: state.projects,
		activeProjectId: state.activeProjectId,
		selectedSessionId: state.selectedSessionId,
		remoteAgent: state.remoteAgent,
		sessionsGeneration: state.sessionsGeneration,
		goalsGeneration: state.goalsGeneration,
		sessionsLoading: state.sessionsLoading,
		sessionsError: state.sessionsError,
	};
	state.gatewaySessions = [];
	state.goals = [];
	state.projects = [];
	state.activeProjectId = null;
	state.selectedSessionId = null;
	state.remoteAgent = null;
	state.sessionsGeneration = -1;
	state.goalsGeneration = -1;
	state.sessionsLoading = false;
	state.sessionsError = "";
	setRenderApp(() => {});

	delete document.documentElement.dataset.playAgentFinishSound;
	FakeAudioContext.instances = [];
	vi.stubGlobal("AudioContext", FakeAudioContext);
	Object.defineProperty(window, "AudioContext", { value: FakeAudioContext, configurable: true, writable: true });
	vi.stubGlobal("Image", ImmediatelyLoadedImage);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

	badgeCalls = vi.fn(() => Promise.resolve());
	Object.defineProperty(navigator, "setAppBadge", { value: badgeCalls, configurable: true, writable: true });
	let favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (!favicon) {
		favicon = document.createElement("link");
		favicon.rel = "icon";
		favicon.href = "data:image/png;base64,AA==";
		document.head.appendChild(favicon);
	}
});

afterEach(() => {
	state.gatewaySessions = originalState.gatewaySessions;
	state.goals = originalState.goals;
	state.projects = originalState.projects;
	state.activeProjectId = originalState.activeProjectId;
	state.selectedSessionId = originalState.selectedSessionId;
	state.remoteAgent = originalState.remoteAgent;
	state.sessionsGeneration = originalState.sessionsGeneration;
	state.goalsGeneration = originalState.goalsGeneration;
	state.sessionsLoading = originalState.sessionsLoading;
	state.sessionsError = originalState.sessionsError;
	setRenderApp(() => {});
	delete document.documentElement.dataset.playAgentFinishSound;
	finishSoundTest.resetProjectOverrides();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("foreground agent_end notification source", () => {
	for (const testCase of [
		{ name: "explicit Off while global is On", global: "true", raw: "false", audio: 0 },
		{ name: "explicit On while global is Off", global: "false", raw: "true", audio: 1 },
	] as const) {
		it(`waits for the cold source project and applies ${testCase.name}`, async () => {
			const sourceId = `foreground-${testCase.raw}`;
			const sourceProject = `source-${testCase.raw}`;
			const viewedProject = `viewed-${testCase.raw}`;
			const config = deferred<Response>();
			const configPaths: string[] = [];
			document.documentElement.dataset.playAgentFinishSound = testCase.global;
			state.selectedSessionId = "viewed-session";
			state.activeProjectId = viewedProject;
			state.gatewaySessions = [
				session("viewed-session", viewedProject),
				session(sourceId, sourceProject),
			];
			vi.stubGlobal("fetch", async (input: any) => {
				const path = new URL(String(input), window.location.origin).pathname;
				if (path === `/api/projects/${sourceProject}/config`) {
					configPaths.push(path);
					return config.promise;
				}
				throw new Error(`unexpected request ${path}`);
			});

			const agent = new RemoteAgent();
			(agent as any)._sessionId = sourceId;
			(agent as any).handleAgentEvent({ type: "agent_end" });
			await waitFor(() => configPaths.length === 1, "cold source-project config request");
			await waitFor(() => badgeCalls.mock.calls.length === 1, "immediate favicon/app badge");
			expect(FakeAudioContext.instances).toHaveLength(0);
			expect(configPaths).toEqual([`/api/projects/${sourceProject}/config`]);

			config.resolve(json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: testCase.raw }));
			await waitFor(() => FakeAudioContext.instances.length === testCase.audio || testCase.audio === 0, "source audio decision");
			await flush();
			expect(FakeAudioContext.instances).toHaveLength(testCase.audio);
			expect(badgeCalls).toHaveBeenCalledTimes(1);
		});
	}

	it("uses the session matching this RemoteAgent session id, never the selected project", async () => {
		document.documentElement.dataset.playAgentFinishSound = "false";
		state.selectedSessionId = "selected";
		state.activeProjectId = "project-muted";
		state.gatewaySessions = [
			session("selected", "project-muted"),
			session("finishing", "project-force-on"),
		];
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: any) => {
			const path = new URL(String(input), window.location.origin).pathname;
			requests.push(path);
			if (path === "/api/projects/project-force-on/config") {
				return json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "true" });
			}
			return json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "false" });
		});

		const agent = new RemoteAgent();
		(agent as any)._sessionId = "finishing";
		(agent as any).handleAgentEvent({ type: "agent_end" });
		await waitFor(() => FakeAudioContext.instances.length === 1, "forced-on source beep");
		expect(requests).toEqual(["/api/projects/project-force-on/config"]);
		expect(badgeCalls).toHaveBeenCalledTimes(1);
	});
});

describe("background polling notification source", () => {
	it("does not await unrelated preloads, badges immediately, deduplicates source loading, and resolves audio from the transitioning session", async () => {
		const activeConfig = deferred<Response>();
		const sourceConfig = deferred<Response>();
		const configRequests = new Map<string, number>();
		let sessionPoll = 0;
		document.documentElement.dataset.playAgentFinishSound = "false";
		state.remoteAgent = { gatewaySessionId: "active" } as any;
		state.selectedSessionId = "active";
		state.activeProjectId = "project-active-off";
		const streaming = [
			session("active", "project-active-off", "idle"),
			session("background", "project-source-on", "streaming"),
		];
		const idle = [
			session("active", "project-active-off", "idle"),
			session("background", "project-source-on", "idle"),
		];

		vi.stubGlobal("fetch", async (input: any) => {
			const url = new URL(String(input), window.location.origin);
			const path = url.pathname;
			if (path === "/api/sessions") {
				const sessions = sessionPoll++ === 0 ? streaming : idle;
				return json({ sessions, generation: sessionPoll });
			}
			if (path === "/api/goals") return json({ goals: [], generation: sessionPoll });
			if (path === "/api/projects") return json([
				{ id: "project-active-off", name: "Active", rootPath: "/active", colorLight: "", colorDark: "" },
				{ id: "project-source-on", name: "Source", rootPath: "/source", colorLight: "", colorDark: "" },
			]);
			if (path === "/api/projects/project-active-off/config") {
				configRequests.set(path, (configRequests.get(path) ?? 0) + 1);
				return activeConfig.promise;
			}
			if (path === "/api/projects/project-source-on/config") {
				configRequests.set(path, (configRequests.get(path) ?? 0) + 1);
				return sourceConfig.promise;
			}
			throw new Error(`unexpected request ${url.href}`);
		});

		let firstResolved = false;
		const firstRefresh = refreshSessions().then(() => { firstResolved = true; });
		await waitFor(() => configRequests.size === 2, "opportunistic project preloads");
		await expect(firstRefresh).resolves.toBeUndefined();
		expect(firstResolved).toBe(true);
		expect(state.gatewaySessions.find((item) => item.id === "background")?.status).toBe("streaming");
		expect(FakeAudioContext.instances).toHaveLength(0);

		let secondResolved = false;
		const secondRefresh = refreshSessions().then(() => { secondResolved = true; });
		await expect(secondRefresh).resolves.toBeUndefined();
		expect(secondResolved).toBe(true);
		expect(state.gatewaySessions.find((item) => item.id === "background")?.status).toBe("idle");
		await waitFor(() => badgeCalls.mock.calls.length === 1, "background badge while config is pending");
		expect(FakeAudioContext.instances).toHaveLength(0);
		expect(configRequests.get("/api/projects/project-source-on/config")).toBe(1);
		expect(configRequests.get("/api/projects/project-active-off/config")).toBe(1);

		// Only the notification source settles. The unrelated active-project preload remains pending.
		sourceConfig.resolve(json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "true" }));
		await waitFor(() => FakeAudioContext.instances.length === 1, "source-project audio while unrelated GET remains pending");
		expect(badgeCalls).toHaveBeenCalledTimes(1);
		expect(configRequests.get("/api/projects/project-source-on/config")).toBe(1);
		activeConfig.resolve(json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "false" }));
		await flush();
	});

	it("keeps the badge when the transitioning source project explicitly disables audio", async () => {
		let poll = 0;
		document.documentElement.dataset.playAgentFinishSound = "true";
		state.remoteAgent = { gatewaySessionId: "active-other" } as any;
		vi.stubGlobal("fetch", async (input: any) => {
			const path = new URL(String(input), window.location.origin).pathname;
			if (path === "/api/sessions") {
				const status = poll++ === 0 ? "streaming" : "idle";
				return json({ sessions: [session("muted-background", "project-muted", status)], generation: poll });
			}
			if (path === "/api/goals") return json({ goals: [], generation: poll });
			if (path === "/api/projects") return json([]);
			if (path === "/api/projects/project-muted/config") return json({ [PROJECT_PLAY_FINISH_SOUND_KEY]: "false" });
			throw new Error(`unexpected request ${path}`);
		});

		await refreshSessions();
		await refreshSessions();
		await waitFor(() => badgeCalls.mock.calls.length === 1, "badge for muted source");
		await flush();
		expect(FakeAudioContext.instances).toHaveLength(0);
		expect(badgeCalls).toHaveBeenCalledTimes(1);
	});
});
