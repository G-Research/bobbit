import { render } from "lit";
import { renderWorkflowPage, loadWorkflowPageData, navigateToWorkflowEdit, clearWorkflowPageState } from "../../../../../src/app/workflow-page.js";
import { setRenderApp, state } from "../../../../../src/app/state.js";
import { setConfigScope } from "../../../../../src/app/config-scope.js";

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

type HeldWorkflowRequest = {
	release: Promise<void>;
	releaseRequest: () => void;
	reportRequest: (request: FetchLogEntry) => void;
};

type HeldWorkflowCreate = HeldWorkflowRequest & { resultId: string };

let heldWorkflowCreate: HeldWorkflowCreate | null = null;
let heldWorkflowUpdate: HeldWorkflowRequest | null = null;
let nextWorkflowUpdate: ((request: FetchLogEntry) => void) | null = null;
let nextWorkflowListFetch: ((request: FetchLogEntry) => void) | null = null;
let omitNextWorkflowList = false;

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
		if (method === "GET") {
			const reportListFetch = nextWorkflowListFetch;
			nextWorkflowListFetch = null;
			reportListFetch?.({ url, method, body: clone(body) });
			if (omitNextWorkflowList) {
				omitNextWorkflowList = false;
				return response({});
			}
			return response({ workflows: clone(workflows) });
		}
		if (method === "POST") {
			const held = heldWorkflowCreate;
			const workflow = {
				...body,
				id: held?.resultId ?? body.id,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			workflows = [...workflows, workflow];
			if (held) {
				held.reportRequest({ url, method, body: clone(body) });
				await held.release;
				heldWorkflowCreate = null;
			}
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
			const held = heldWorkflowUpdate;
			if (held) {
				held.reportRequest({ url, method, body: clone(body) });
				await held.release;
				heldWorkflowUpdate = null;
			}
			const reportUpdate = nextWorkflowUpdate;
			nextWorkflowUpdate = null;
			reportUpdate?.({ url, method, body: clone(body) });
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
// The production app's route shell redraws after hash navigation. This focused
// page fixture owns no shell, so mirror that redraw for Back/list navigation.
window.addEventListener("hashchange", doRender);
localStorage.setItem("gateway.url", "http://fixture");
localStorage.setItem("gateway.token", "fixture-token");

(window as any).__loadGoalWorkflowFixture = async (workflow: FixtureWorkflow | FixtureWorkflow[] | null) => {
	workflows = workflow === null ? [] : Array.isArray(workflow) ? clone(workflow) : [clone(workflow)];
	fetchLog = [];
	heldWorkflowCreate = null;
	heldWorkflowUpdate = null;
	nextWorkflowUpdate = null;
	nextWorkflowListFetch = null;
	omitNextWorkflowList = false;
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
	if (workflows[0]) navigateToWorkflowEdit(workflows[0].id);
	doRender();
	await nextFrame();
};

(window as any).__holdNextWorkflowCreate = (resultId: string): Promise<FetchLogEntry> => {
	if (heldWorkflowCreate) throw new Error("A workflow create is already held");
	return new Promise((reportRequest) => {
		let releaseRequest!: () => void;
		const release = new Promise<void>((resolve) => { releaseRequest = resolve; });
		heldWorkflowCreate = { resultId, release, releaseRequest, reportRequest };
	});
};

(window as any).__releaseHeldWorkflowCreate = () => {
	if (!heldWorkflowCreate) throw new Error("No workflow create is held");
	heldWorkflowCreate.releaseRequest();
};

(window as any).__holdNextWorkflowUpdate = (): Promise<FetchLogEntry> => {
	if (heldWorkflowUpdate) throw new Error("A workflow update is already held");
	return new Promise((reportRequest) => {
		let releaseRequest!: () => void;
		const release = new Promise<void>((resolve) => { releaseRequest = resolve; });
		heldWorkflowUpdate = { release, releaseRequest, reportRequest };
	});
};

(window as any).__releaseHeldWorkflowUpdate = () => {
	if (!heldWorkflowUpdate) throw new Error("No workflow update is held");
	heldWorkflowUpdate.releaseRequest();
};

(window as any).__waitForNextWorkflowUpdate = (): Promise<FetchLogEntry> => {
	if (nextWorkflowUpdate) throw new Error("A workflow update is already awaited");
	return new Promise((resolve) => { nextWorkflowUpdate = resolve; });
};

(window as any).__waitForNextWorkflowListFetch = (): Promise<FetchLogEntry> => {
	if (nextWorkflowListFetch) throw new Error("A workflow list fetch is already awaited");
	return new Promise((resolve) => { nextWorkflowListFetch = resolve; });
};

(window as any).__omitNextWorkflowList = () => {
	omitNextWorkflowList = true;
};

(window as any).__goalWorkflowFetchLog = () => clone(fetchLog);
(window as any).__goalWorkflowData = () => clone(workflows);
(window as any).__goalWorkflowEditorReady = true;
