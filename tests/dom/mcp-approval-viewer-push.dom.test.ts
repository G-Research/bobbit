import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	startSessionListPushSync,
	stopSessionListPushSync,
} from "../../src/app/api.js";
import {
	__resetGatewayConnectionForTests,
	commitGatewayConnection,
} from "../../src/app/gateway-fetch.js";
import {
	invalidateMcpApprovalBanner,
	renderMcpApprovalBanner,
	resolveMcpApprovalBannerScope,
} from "../../src/app/mcp-approval-banner.js";
import { setConfigScope } from "../../src/app/config-scope.js";
import { renderApp, setRenderApp, state } from "../../src/app/state.js";

class ViewerPushSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static instance: ViewerPushSocket | null = null;
	readyState = ViewerPushSocket.CONNECTING;

	constructor(readonly url: string | URL) {
		super();
		ViewerPushSocket.instance = this;
	}

	send(): void {}

	close(): void {
		this.readyState = ViewerPushSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	emit(payload: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
	}
}

const original = {
	appView: state.appView,
	activeProjectId: state.activeProjectId,
	projects: state.projects,
};

beforeEach(() => {
	setConfigScope("system");
	state.appView = "authenticated";
	state.activeProjectId = "additional-project";
	state.projects = [{ id: "additional-project", name: "Additional project" } as any];
	ViewerPushSocket.instance = null;
	vi.stubGlobal("WebSocket", ViewerPushSocket);
	commitGatewayConnection(window.location.origin, "test-token");
});

afterEach(() => {
	stopSessionListPushSync();
	setRenderApp(() => {});
	invalidateMcpApprovalBanner(["view-project", "additional-project"]);
	state.appView = original.appView;
	state.activeProjectId = original.activeProjectId;
	state.projects = original.projects;
	localStorage.removeItem("gateway.url");
	localStorage.removeItem("gateway.token");
	__resetGatewayConnectionForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function mcpResponse(states: Array<"pending" | "changed">): Response {
	return new Response(JSON.stringify(states.map((approvalState) => ({ approval: { state: approvalState } }))), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

async function flushFetchAndRender(): Promise<void> {
	for (let pass = 0; pass < 3; pass += 1) {
		await vi.advanceTimersByTimeAsync(20);
		await Promise.resolve();
	}
}

describe("viewer MCP approval push", () => {
	it("keeps plain Tools root-scoped and preserves case-sensitive owner cwd", () => {
		const source = {
			projects: [{ id: "project-1", name: "Project", rootPath: "/Repo" }],
			gatewaySessions: [{ id: "session-1", projectId: "project-1", cwd: "/repo" }],
			archivedSessions: [],
			goals: [],
			selectedSessionId: "session-1",
			remoteAgent: null,
			goalDashboardId: null,
			activeProjectId: "project-1",
		} as any;
		setConfigScope("project-1");

		expect(resolveMcpApprovalBannerScope({ view: "tools" }, source)).toEqual({
			projectId: "project-1",
		});
		expect(resolveMcpApprovalBannerScope({ view: "session", sessionId: "session-1" }, source)).toEqual({
			projectId: "project-1",
			cwd: "/repo",
			sessionId: "session-1",
		});
		expect(resolveMcpApprovalBannerScope({ view: "tools", mcpReviewSessionId: "session-1" }, source)).toEqual({
			projectId: "project-1",
			cwd: "/repo",
			sessionId: "session-1",
		});
	});

	it("removes a non-session additional-project banner after an approval decision", async () => {
		let pending = true;
		let requests = 0;
		vi.stubGlobal("fetch", async (input: string | URL) => {
			const url = new URL(String(input), window.location.origin);
			if (url.pathname !== "/api/mcp-servers") return new Response("{}", { status: 200 });
			requests += 1;
			return new Response(JSON.stringify(
				pending ? [{ approval: { state: "pending" } }] : [],
			), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		const host = document.createElement("div");
		document.body.append(host);
		setRenderApp(() => render(renderMcpApprovalBanner({ view: "landing" }), host));
		renderApp();
		await vi.waitFor(() => expect(document.querySelector('[data-testid="mcp-approval-banner"]')).not.toBeNull());
		const requestsBeforePush = requests;

		startSessionListPushSync();
		pending = false;
		ViewerPushSocket.instance!.emit({
			type: "mcp_approvals_changed",
			projectIds: ["view-project", "additional-project"],
			// Deliberately stale: the existing handler must refetch rather than trust it.
			pendingCounts: { "additional-project": 1 },
		});

		await vi.waitFor(() => expect(requests).toBeGreaterThan(requestsBeforePush));
		await vi.waitFor(() => expect(document.querySelector('[data-testid="mcp-approval-banner"]')).toBeNull());
	});
});

describe("Tools MCP approval banner revalidation", () => {
	function mountTools(projectId: string): void {
		setConfigScope(projectId);
		state.projects = [{ id: projectId, name: "Refresh project" } as any];
		history.replaceState({}, "", "#/tools");
		const host = document.createElement("div");
		document.body.append(host);
		setRenderApp(() => render(renderMcpApprovalBanner({ view: "tools" }), host));
		renderApp();
	}

	async function cleanup(projectId: string): Promise<void> {
		history.replaceState({}, "", "#/");
		setRenderApp(() => {});
		invalidateMcpApprovalBanner([projectId]);
		await vi.advanceTimersByTimeAsync(20);
		vi.clearAllTimers();
		vi.useRealTimers();
	}

	it("keeps the confirmed pending banner mounted throughout a deferred periodic refresh without overlap", async () => {
		vi.useFakeTimers();
		const projectId = "mcp-refresh-mounted";
		const refresh = deferred<Response>();
		let requests = 0;
		vi.stubGlobal("fetch", () => {
			requests += 1;
			if (requests === 1) return Promise.resolve(mcpResponse(["pending"]));
			if (requests === 2) return refresh.promise;
			throw new Error("unexpected overlapping MCP refresh");
		});
		try {
			mountTools(projectId);
			await flushFetchAndRender();
			expect(requests).toBe(1);
			const confirmedBanner = document.querySelector('[data-testid="mcp-approval-banner"]');
			expect(confirmedBanner).not.toBeNull();

			await vi.advanceTimersByTimeAsync(2_000);
			expect(requests).toBe(2);
			expect(document.querySelector('[data-testid="mcp-approval-banner"]')).toBe(confirmedBanner);

			await vi.advanceTimersByTimeAsync(2_000);
			expect(requests).toBe(2);
			expect(document.querySelector('[data-testid="mcp-approval-banner"]')).toBe(confirmedBanner);

			refresh.resolve(mcpResponse(["pending", "changed"]));
			await flushFetchAndRender();
			expect(document.querySelector('[data-testid="mcp-approval-banner"]')).toBe(confirmedBanner);
			expect(document.querySelector('[data-testid="mcp-approval-banner-count"]')?.textContent).toBe("2");
		} finally {
			await cleanup(projectId);
		}
	});

	it("reveals zero-to-pending and removes pending only after periodic responses are confirmed", async () => {
		vi.useFakeTimers();
		const projectId = "mcp-refresh-transitions";
		const becomesPending = deferred<Response>();
		const becomesZero = deferred<Response>();
		let requests = 0;
		vi.stubGlobal("fetch", () => {
			requests += 1;
			if (requests === 1) return Promise.resolve(mcpResponse([]));
			if (requests === 2) return becomesPending.promise;
			if (requests === 3) return becomesZero.promise;
			throw new Error("unexpected MCP refresh");
		});
		try {
			mountTools(projectId);
			await flushFetchAndRender();
			expect(requests).toBe(1);
			expect(document.querySelector('[data-testid="mcp-approval-banner"]')).toBeNull();

			await vi.advanceTimersByTimeAsync(2_000);
			expect(document.querySelector('[data-testid="mcp-approval-banner"]')).toBeNull();
			becomesPending.resolve(mcpResponse(["pending"]));
			await flushFetchAndRender();
			const confirmedBanner = document.querySelector('[data-testid="mcp-approval-banner"]');
			expect(confirmedBanner).not.toBeNull();

			await vi.advanceTimersByTimeAsync(2_000);
			expect(document.querySelector('[data-testid="mcp-approval-banner"]')).toBe(confirmedBanner);
			becomesZero.resolve(mcpResponse([]));
			await flushFetchAndRender();
			expect(document.querySelector('[data-testid="mcp-approval-banner"]')).toBeNull();
		} finally {
			await cleanup(projectId);
		}
	});

	it("rejects a stale periodic response after revision invalidation", async () => {
		vi.useFakeTimers();
		const projectId = "mcp-refresh-revision";
		const staleRefresh = deferred<Response>();
		let requests = 0;
		vi.stubGlobal("fetch", () => {
			requests += 1;
			if (requests === 1) return Promise.resolve(mcpResponse(["pending"]));
			if (requests === 2) return staleRefresh.promise;
			if (requests === 3) return Promise.resolve(mcpResponse(["pending", "changed"]));
			throw new Error("unexpected MCP refresh");
		});
		try {
			mountTools(projectId);
			await flushFetchAndRender();
			expect(requests).toBe(1);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(requests).toBe(2);

			invalidateMcpApprovalBanner([projectId]);
			await flushFetchAndRender();
			expect(requests).toBe(3);
			expect(document.querySelector('[data-testid="mcp-approval-banner-count"]')?.textContent).toBe("2");

			staleRefresh.resolve(mcpResponse([]));
			await flushFetchAndRender();
			expect(document.querySelector('[data-testid="mcp-approval-banner-count"]')?.textContent).toBe("2");
		} finally {
			await cleanup(projectId);
		}
	});
});
