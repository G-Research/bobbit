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
} from "../../src/app/mcp-approval-banner.js";
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

describe("viewer MCP approval push", () => {
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
		setRenderApp(() => render(renderMcpApprovalBanner({ view: "landing" }), document.body));
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
