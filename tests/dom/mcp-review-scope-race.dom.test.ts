import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigApiProjectId, setConfigScope } from "../../src/app/config-scope.js";
import {
	__resetGatewayConnectionForTests,
	commitGatewayConnection,
} from "../../src/app/gateway-fetch.js";
import {
	clearToolPageState,
	loadToolPageData,
	renderToolManagerPage,
} from "../../src/app/tool-manager-page.js";
import { setRenderApp, state } from "../../src/app/state.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	return {
		promise: new Promise<T>((done) => { resolve = done; }),
		resolve,
	};
}

const original = {
	projects: state.projects,
	gatewaySessions: state.gatewaySessions,
	archivedSessions: state.archivedSessions,
	goals: state.goals,
};

beforeEach(() => {
	state.projects = [
		{ id: "old-project", name: "Old project" },
		{ id: "new-project", name: "New project" },
	] as any;
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.goals = [];
	setConfigScope("new-project");
	clearToolPageState();
	setRenderApp(() => {});
	commitGatewayConnection(window.location.origin, "test-token");
});

afterEach(() => {
	setRenderApp(() => {});
	clearToolPageState();
	setConfigScope("system");
	state.projects = original.projects;
	state.gatewaySessions = original.gatewaySessions;
	state.archivedSessions = original.archivedSessions;
	state.goals = original.goals;
	history.replaceState({}, "", "#/tools");
	localStorage.removeItem("gateway.url");
	localStorage.removeItem("gateway.token");
	__resetGatewayConnectionForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Tools MCP review scope ownership", () => {
	it("does not let a delayed old review owner mutate a newer root-scoped load", async () => {
		const oldOwner = deferred<Response>();
		const newTools = deferred<Response>();
		const newToolsStarted = deferred<void>();
		const requests: URL[] = [];

		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
			requests.push(url);
			if (url.pathname === "/api/sessions/stale-session") return oldOwner.promise;
			if (url.pathname === "/api/tools" && url.searchParams.get("projectId") === "new-project") {
				newToolsStarted.resolve();
				return newTools.promise;
			}
			if (url.pathname === "/api/tools") return Response.json({ tools: [], diagnostics: [] });
			if (url.pathname === "/api/roles") return Response.json({ roles: [] });
			if (url.pathname === "/api/tool-group-policies") return Response.json({});
			if (url.pathname === "/api/mcp-servers") return Response.json([]);
			return Response.json({});
		}));

		history.replaceState({}, "", "#/tools?reviewSession=stale-session");
		const staleLoad = loadToolPageData();
		await vi.waitFor(() => expect(requests.some((url) => url.pathname === "/api/sessions/stale-session")).toBe(true));

		history.replaceState({}, "", "#/tools");
		setConfigScope("new-project");
		const currentLoad = loadToolPageData();
		await newToolsStarted.promise;

		oldOwner.resolve(Response.json({
			id: "stale-session",
			projectId: "old-project",
			cwd: "/old/worktree",
		}));
		await staleLoad;
		newTools.resolve(Response.json({ tools: [], diagnostics: [] }));
		await currentLoad;

		expect(getConfigApiProjectId()).toBe("new-project");
		expect(requests.some((url) =>
			url.pathname === "/api/mcp-servers"
			&& url.searchParams.get("projectId") === "new-project"
			&& !url.searchParams.has("cwd")
			&& !url.searchParams.has("sessionId")
		)).toBe(true);
		render(renderToolManagerPage(), document.body);
		expect(document.querySelector(".tools-loading")).toBeNull();
	});
});
