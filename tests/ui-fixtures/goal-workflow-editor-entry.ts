import { render } from "lit";
import { renderWorkflowPage, loadWorkflowPageData, navigateToWorkflowEdit, clearWorkflowPageState } from "../../src/app/workflow-page.js";
import { setRenderApp, state } from "../../src/app/state.js";
import { setConfigScope } from "../../src/app/config-scope.js";

const PROJECT_ID = "fixture-project";

type FixtureWorkflow = {
	id: string;
	name: string;
	description: string;
	gates: Array<{
		id: string;
		name: string;
		dependsOn: string[];
		verify?: Array<Record<string, any>>;
		[key: string]: any;
	}>;
	[key: string]: any;
};

type FetchLogEntry = { url: string; method: string; body: any };

let workflows: FixtureWorkflow[] = [];
let fetchLog: FetchLogEntry[] = [];

class FixtureWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FixtureWebSocket.OPEN;
	addEventListener(): void {}
	removeEventListener(): void {}
	send(): void {}
	close(): void { this.readyState = FixtureWebSocket.CLOSED; }
}

(window as any).WebSocket = FixtureWebSocket;
window.confirm = () => true;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function response(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestPath(input: RequestInfo | URL): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try {
		const url = new URL(raw, window.location.href);
		return `${url.pathname}${url.search}`;
	} catch {
		return raw;
	}
}

function parseBody(init?: RequestInit): any {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

function workflowIdFromPath(path: string): string | null {
	const match = path.match(/^\/api\/workflows\/([^?]+)/);
	return match ? decodeURIComponent(match[1]) : null;
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	const body = parseBody(init);
	fetchLog.push({ url, method, body: clone(body) });

	if (url.startsWith("/api/workflows") && !workflowIdFromPath(url)) {
		if (method === "GET") return response({ workflows: clone(workflows) });
		if (method === "POST") {
			const workflow = { ...body, createdAt: Date.now(), updatedAt: Date.now() };
			workflows = [...workflows, workflow];
			return response(clone(workflow), 201);
		}
	}

	const id = workflowIdFromPath(url);
	if (id) {
		const idx = workflows.findIndex((wf) => wf.id === id);
		if (method === "GET") {
			return idx >= 0 ? response(clone(workflows[idx])) : response({ error: "not found" }, 404);
		}
		if (method === "PUT") {
			if (idx < 0) return response({ error: "not found" }, 404);
			workflows[idx] = { ...workflows[idx], ...body, id, updatedAt: Date.now() };
			return response(clone(workflows[idx]));
		}
		if (method === "DELETE") {
			workflows = workflows.filter((wf) => wf.id !== id);
			return response({ ok: true });
		}
	}

	return response({});
}) as typeof window.fetch;

function doRender(): void {
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	render(renderWorkflowPage(), app);
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

setRenderApp(doRender);
localStorage.setItem("gateway.url", "http://fixture");
localStorage.setItem("gateway.token", "fixture-token");

(window as any).__loadGoalWorkflowFixture = async (workflow: FixtureWorkflow) => {
	workflows = [clone(workflow)];
	fetchLog = [];
	state.projects = [{
		id: PROJECT_ID,
		name: "Fixture Project",
		rootPath: "/fixture/project",
		colorLight: "#6366f1",
		colorDark: "#818cf8",
	}];
	state.activeProjectId = PROJECT_ID;
	setConfigScope(PROJECT_ID);
	clearWorkflowPageState();
	window.location.hash = "#/workflows";
	await loadWorkflowPageData();
	navigateToWorkflowEdit(workflow.id);
	doRender();
	await nextFrame();
};

(window as any).__goalWorkflowFetchLog = () => clone(fetchLog);
(window as any).__goalWorkflowData = () => clone(workflows);
(window as any).__goalWorkflowEditorReady = true;
