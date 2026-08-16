import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { icon } from "@mariozechner/mini-lit";
import { render } from "lit";
import { Pin, PinOff } from "lucide";
import {
	setSessionPinned,
	startSessionListPushSync,
	stopSessionListPushSync,
} from "../../src/app/api.js";
import {
	buildArchivedSessionActions,
	buildSessionActions,
} from "../../src/app/session-actions.js";
import "../../src/app/session-manager.js";
import { RemoteAgent, subscribeGoalStateChanges } from "../../src/app/remote-agent.js";
import {
	renderApp,
	setRenderApp,
	state,
	type GatewaySession,
} from "../../src/app/state.js";
import {
	__resetGatewayConnectionForTests,
	commitGatewayConnection,
} from "../../src/app/gateway-fetch.js";
import { headerToast } from "../../src/app/header-toast.js";
import { isPinned } from "../../src/shared/session-tags.js";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
}

function session(id: string, extra: Record<string, unknown> = {}): GatewaySession {
	return {
		id,
		title: `Session ${id}`,
		cwd: "/tmp/project",
		projectId: "project-1",
		status: "idle",
		createdAt: 1,
		lastActivity: 2,
		clientCount: 0,
		...extra,
	} as GatewaySession;
}

function tags(row: GatewaySession | undefined): unknown {
	return (row as GatewaySession & { user_tags?: unknown } | undefined)?.user_tags;
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function builtinIds(actions: ReturnType<typeof buildSessionActions>): string[] {
	const ids = new Set([
		"modify", "terminate", "pin", "refresh-agent", "fork", "copy-link",
		"view-system-prompt", "open-new-window",
	]);
	return actions.map((action) => String(action.id)).filter((id) => ids.has(id));
}

function renderedIcon(actionIcon: ReturnType<typeof icon>): string {
	const host = document.createElement("div");
	render(actionIcon, host);
	return host.innerHTML;
}

class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static instance: FakeWebSocket | null = null;
	readonly url: string;
	readyState = FakeWebSocket.CONNECTING;

	constructor(url: string | URL) {
		super();
		this.url = String(url);
		FakeWebSocket.instance = this;
	}

	send(): void {}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	message(payload: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
	}
}

const original = {
	gatewaySessions: state.gatewaySessions,
	archivedSessions: state.archivedSessions,
	projects: state.projects,
	goals: state.goals,
	appView: state.appView,
	sessionsGeneration: state.sessionsGeneration,
	goalsGeneration: state.goalsGeneration,
};

beforeEach(() => {
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.projects = [];
	state.goals = [];
	state.appView = "authenticated";
	state.sessionsGeneration = 1;
	state.goalsGeneration = 1;
	setRenderApp(() => {});
	FakeWebSocket.instance = null;
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	stopSessionListPushSync();
	vi.useRealTimers();
	state.gatewaySessions = original.gatewaySessions;
	state.archivedSessions = original.archivedSessions;
	state.projects = original.projects;
	state.goals = original.goals;
	state.appView = original.appView;
	state.sessionsGeneration = original.sessionsGeneration;
	state.goalsGeneration = original.goalsGeneration;
	setRenderApp(() => {});
	localStorage.removeItem("gateway.url");
	localStorage.removeItem("gateway.token");
	__resetGatewayConnectionForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("session pin action descriptors", () => {
	it("keeps Pin third and menu-only for live sessions, with a dynamic icon and label", () => {
		const unpinned = buildSessionActions({ session: session("live"), displayTitle: "Live" });
		expect(builtinIds(unpinned)).toEqual([
			"modify", "terminate", "pin", "refresh-agent", "fork", "copy-link",
			"view-system-prompt", "open-new-window",
		]);
		const pin = unpinned.find((action) => action.id === "pin")!;
		expect(pin).toMatchObject({ label: "Pin session", priority: 30, quick: false });
		expect(renderedIcon(pin.icon)).toBe(renderedIcon(icon(Pin, "xs")));

		const pinned = buildSessionActions({
			session: session("live", { user_tags: ["owner=me", "pinned=true"] }),
			displayTitle: "Live",
		});
		const unpin = pinned.find((action) => action.id === "pin")!;
		expect(unpin).toMatchObject({ label: "Unpin session", priority: 30, quick: false });
		expect(renderedIcon(unpin.icon)).toBe(renderedIcon(icon(PinOff, "xs")));
	});

	it("places Pin after Continue and Copy link for archived-safe actions", () => {
		state.projects = [{ id: "project-1" } as any];
		const eligible = buildArchivedSessionActions({
			session: session("archived", { archived: true, status: "archived", user_tags: [] }),
			displayTitle: "Archived",
		});
		expect(eligible.map((action) => action.id)).toEqual([
			"continue-archived", "copy-link", "pin", "view-system-prompt", "open-new-window",
		]);
		expect(eligible[2]).toMatchObject({ label: "Pin session", quick: false });

		const ineligible = buildArchivedSessionActions({
			session: session("child-archive", { archived: true, status: "archived", parentSessionId: "parent" }),
			displayTitle: "Archived child",
		});
		expect(ineligible.map((action) => action.id)).toEqual([
			"copy-link", "pin", "view-system-prompt", "open-new-window",
		]);
	});
});

describe("session pin client mutation", () => {
	it("optimistically patches all live and archived representations then reconciles authoritative tags", async () => {
		state.gatewaySessions = [session("same", { user_tags: ["owner=live", "pinned=false"] })];
		state.archivedSessions = [session("same", { archived: true, user_tags: ["owner=archive"] })];
		const pending = deferred<Response>();
		let request: { url: string; init?: RequestInit } | undefined;
		vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => {
			request = { url: String(url), init };
			return pending.promise;
		});

		const mutation = setSessionPinned("same", true);
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(true);
		expect(isPinned(tags(state.archivedSessions[0]))).toBe(true);
		expect(tags(state.gatewaySessions[0])).toEqual(["owner=live", "pinned=true"]);
		expect(tags(state.archivedSessions[0])).toEqual(["owner=archive", "pinned=true"]);

		pending.resolve(response({ user_tags: ["owner=server", "pinned=true"] }));
		await mutation;
		expect(request?.url).toContain("/api/sessions/same/pin");
		expect(request?.init).toMatchObject({ method: "PUT" });
		expect(JSON.parse(String(request?.init?.body))).toEqual({ pinned: true });
		expect(tags(state.gatewaySessions[0])).toEqual(["owner=server", "pinned=true"]);
		expect(tags(state.archivedSessions[0])).toEqual(["owner=server", "pinned=true"]);
	});

	it("rolls the current failure back to each representation's exact previous tags and shows the existing toast", async () => {
		state.gatewaySessions = [session("same")];
		state.archivedSessions = [session("same", { archived: true, user_tags: ["owner=archive", "pinned=false"] })];
		vi.stubGlobal("fetch", async () => response({ error: "disk failed" }, 500));

		await setSessionPinned("same", true);
		expect(Object.prototype.hasOwnProperty.call(state.gatewaySessions[0], "user_tags")).toBe(false);
		expect(tags(state.archivedSessions[0])).toEqual(["owner=archive", "pinned=false"]);
		expect(console.error).toHaveBeenCalledWith(
			"[sidebar] Failed to pin session:",
			expect.objectContaining({ message: "disk failed" }),
		);
		const host = document.createElement("div");
		render(headerToast(), host);
		expect(host.textContent).toContain("Couldn't pin session");
	});

	it("serializes rapid mutations per session while preserving the newest optimistic intent", async () => {
		state.gatewaySessions = [session("rapid", { user_tags: ["owner=me"] })];
		const requests = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
		let requestIndex = 0;
		vi.stubGlobal("fetch", () => requests[requestIndex++].promise);

		const oldest = setSessionPinned("rapid", true);
		const intervening = setSessionPinned("rapid", false);
		const newest = setSessionPinned("rapid", true);
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(true);
		expect(requestIndex).toBe(1);

		requests[0].resolve(response({ error: "old failure" }, 500));
		await oldest;
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(true);
		expect(requestIndex).toBe(2);

		requests[1].resolve(response({ user_tags: ["owner=intervening"] }));
		await intervening;
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(true);
		expect(requestIndex).toBe(3);

		requests[2].resolve(response({ user_tags: ["owner=authoritative", "pinned=true"] }));
		await newest;
		expect(tags(state.gatewaySessions[0])).toEqual(["owner=authoritative", "pinned=true"]);
		expect(console.error).not.toHaveBeenCalled();
	});

	it("restores the original live and archived baseline when rapid Pin then Unpin both fail", async () => {
		state.gatewaySessions = [session("rapid-fail", { user_tags: ["owner=live"] })];
		state.archivedSessions = [session("rapid-fail", { archived: true, user_tags: ["owner=archive"] })];
		const requests = [deferred<Response>(), deferred<Response>()];
		let requestIndex = 0;
		vi.stubGlobal("fetch", () => requests[requestIndex++].promise);

		const pin = setSessionPinned("rapid-fail", true);
		const unpin = setSessionPinned("rapid-fail", false);
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(false);
		expect(requestIndex).toBe(1);

		requests[0].reject(new Error("pin failed"));
		await pin;
		expect(requestIndex).toBe(2);
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(false);
		requests[1].reject(new Error("unpin failed"));
		await unpin;

		expect(tags(state.gatewaySessions[0])).toEqual(["owner=live"]);
		expect(tags(state.archivedSessions[0])).toEqual(["owner=archive"]);
		expect(console.error).toHaveBeenCalledTimes(1);
	});

	it("restores the last committed success when the following rapid mutation fails", async () => {
		state.gatewaySessions = [session("partial-fail", { user_tags: ["owner=initial"] })];
		state.archivedSessions = [session("partial-fail", { archived: true, user_tags: ["owner=archive"] })];
		const requests = [deferred<Response>(), deferred<Response>()];
		let requestIndex = 0;
		vi.stubGlobal("fetch", () => requests[requestIndex++].promise);

		const pin = setSessionPinned("partial-fail", true);
		const unpin = setSessionPinned("partial-fail", false);
		requests[0].resolve(response({ user_tags: ["owner=server", "pinned=true"] }));
		await pin;
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(false);
		requests[1].reject(new Error("unpin failed"));
		await unpin;

		expect(tags(state.gatewaySessions[0])).toEqual(["owner=server", "pinned=true"]);
		expect(tags(state.archivedSessions[0])).toEqual(["owner=server", "pinned=true"]);
	});
});

describe("session tag push invalidation", () => {
	it("defers stale push and list tags behind a newer local intent, then applies remote tags after idle", async () => {
		state.gatewaySessions = [session("race", { user_tags: [] })];
		state.archivedSessions = [session("race", { archived: true, user_tags: [] })];
		const pinRequests = [deferred<Response>(), deferred<Response>()];
		const staleRefresh = deferred<Response>();
		let pinRequestIndex = 0;
		vi.stubGlobal("fetch", (input: string | URL) => {
			const url = new URL(String(input), window.location.origin);
			if (url.pathname === "/api/sessions/race/pin") return pinRequests[pinRequestIndex++].promise;
			if (url.pathname === "/api/sessions") return staleRefresh.promise;
			if (url.pathname === "/api/goals") return Promise.resolve(response({ changed: false, generation: 1 }));
			if (url.pathname === "/api/projects") return Promise.resolve(response({ projects: [] }));
			return Promise.resolve(response({}));
		});
		vi.stubGlobal("WebSocket", FakeWebSocket);
		commitGatewayConnection(window.location.origin, "test-token");
		startSessionListPushSync();
		const socket = FakeWebSocket.instance!;
		socket.open();

		const pin = setSessionPinned("race", true);
		const unpin = setSessionPinned("race", false);
		socket.message({ type: "sessions_changed", sessionId: "race", user_tags: ["pinned=true", "owner=stale-push"] });
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(false);
		expect(isPinned(tags(state.archivedSessions[0]))).toBe(false);

		staleRefresh.resolve(response({
			sessions: [session("race", { user_tags: ["pinned=true", "owner=stale-list"] })],
			archivedDelegates: [],
			generation: 2,
		}));
		await vi.waitFor(() => expect(state.sessionsGeneration).toBe(2));
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(false);

		pinRequests[0].resolve(response({ user_tags: ["pinned=true", "owner=pin-success"] }));
		await pin;
		expect(isPinned(tags(state.gatewaySessions[0]))).toBe(false);
		pinRequests[1].resolve(response({ user_tags: ["owner=unpin-success"] }));
		await unpin;
		expect(tags(state.gatewaySessions[0])).toEqual(["owner=unpin-success"]);
		expect(tags(state.archivedSessions[0])).toEqual(["owner=unpin-success"]);

		socket.message({ type: "sessions_changed", sessionId: "race", user_tags: ["pinned=true", "owner=remote-after-idle"] });
		expect(tags(state.gatewaySessions[0])).toEqual(["pinned=true", "owner=remote-after-idle"]);
		expect(tags(state.archivedSessions[0])).toEqual(["pinned=true", "owner=remote-after-idle"]);
	});

	it("patches loaded live and archived rows from additive sessions_changed data and still refreshes", async () => {
		state.gatewaySessions = [session("push", { user_tags: [] })];
		state.archivedSessions = [session("push", { archived: true, user_tags: [] })];
		const requestedPaths: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL) => {
			const url = new URL(String(input), window.location.origin);
			requestedPaths.push(url.pathname);
			if (url.pathname === "/api/sessions") return response({ changed: false, generation: 1 });
			if (url.pathname === "/api/goals") return response({ changed: false, generation: 1 });
			if (url.pathname === "/api/projects") return response({ projects: [] });
			return response({});
		});
		vi.stubGlobal("WebSocket", FakeWebSocket);
		commitGatewayConnection(window.location.origin, "test-token");

		startSessionListPushSync();
		const socket = FakeWebSocket.instance!;
		socket.open();
		socket.message({
			type: "sessions_changed",
			sessionId: "push",
			projectId: "project-1",
			user_tags: ["pinned=true", "owner=remote"],
		});

		expect(tags(state.gatewaySessions[0])).toEqual(["pinned=true", "owner=remote"]);
		expect(tags(state.archivedSessions[0])).toEqual(["pinned=true", "owner=remote"]);
		await vi.waitFor(() => expect(requestedPaths).toContain("/api/sessions"));
		// Drain the render queued by the optimistic patch so this test does not
		// leave shared state work behind under the DOM suite's isolate:false mode.
		renderApp();
	});
});

describe("goal state push invalidation", () => {
	it("coalesces a burst into one authoritative session and goal snapshot", async () => {
		vi.useFakeTimers();
		state.sessionsGeneration = -1;
		state.goalsGeneration = -1;
		const latestSessions = [session("latest", { projectId: undefined, status: "idle" })];
		const latestGoals = [{ id: "goal-latest", title: "Latest goal", state: "complete", workflow: { gates: [] } }];
		const requestedPaths: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL) => {
			const url = new URL(String(input), window.location.origin);
			requestedPaths.push(url.pathname);
			if (url.pathname === "/api/sessions") {
				return response({ sessions: latestSessions, archivedDelegates: [], generation: 2 });
			}
			if (url.pathname === "/api/goals") return response({ goals: latestGoals, generation: 2 });
			if (url.pathname === "/api/projects") return response({ projects: [{ id: "project-latest", name: "Latest" }] });
			return response({ changed: false });
		});
		const subscriberEvents: Array<{ goalId?: string; type?: string }> = [];
		const unsubscribe = subscribeGoalStateChanges(event => subscriberEvents.push(event));
		const agent: any = new RemoteAgent();
		try {
			await agent.handleServerMessage({ type: "goal_state_changed", goalId: "goal-first" });
			await agent.handleServerMessage({ type: "goal_state_changed", goalId: "goal-middle" });
			await agent.handleServerMessage({ type: "goal_state_changed", goalId: "goal-latest" });

			expect(requestedPaths.filter(path => path === "/api/sessions")).toHaveLength(0);
			expect(subscriberEvents).toEqual([
				{ goalId: "goal-first", type: "goal_state_changed" },
				{ goalId: "goal-middle", type: "goal_state_changed" },
				{ goalId: "goal-latest", type: "goal_state_changed" },
			]);

			await vi.advanceTimersByTimeAsync(100);
			expect(requestedPaths.filter(path => path === "/api/sessions")).toHaveLength(1);
			expect(requestedPaths.filter(path => path === "/api/goals")).toHaveLength(1);
			expect(requestedPaths.filter(path => path === "/api/projects")).toHaveLength(1);
			expect(state.gatewaySessions).toEqual(latestSessions);
			expect(state.goals).toEqual(latestGoals);
		} finally {
			unsubscribe();
		}
	});
});
