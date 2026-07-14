import { render } from "lit";
import { GateInspectRenderer } from "../../src/ui/tools/renderers/GateInspectRenderer.js";
import "../../src/ui/tools/renderers/GateVerificationLive.js";
import { state } from "../../src/app/state.js";

const GOAL_ID = "goal-timeout-fixture";
const PROJECT_ID = "fixture-project";
const WORKFLOW_ID = "timeout-workflow";
const GATE_ID = "review-findings";
const STEP_NAME = "LLM review";

const activeWorkflowSeed = {
	id: WORKFLOW_ID,
	name: "Frozen active goal workflow",
	description: "The active goal snapshot must not seed future-goal changes.",
	createdAt: 100,
	updatedAt: 200,
	activeSnapshotOnly: "keep-active-definition",
	gates: [
		{
			id: GATE_ID,
			name: "Review findings",
			dependsOn: ["implementation"],
			content: "Active goal review instructions",
			verify: [
				{ name: "Typecheck", type: "command", run: "npm run check", phase: 0, timeout: 30 },
				{ name: STEP_NAME, type: "llm-review", prompt: "Review the active goal", phase: 1, timeout: 7, activeOnly: true },
			],
		},
		{ id: "ready", name: "Ready", dependsOn: [GATE_ID], content: "Keep this active gate", verify: [] },
	],
};

const projectWorkflowSeed = {
	id: WORKFLOW_ID,
	name: "Future project workflow",
	description: "The project definition is independently resolved.",
	createdAt: 300,
	updatedAt: 400,
	futureTemplateOnly: "keep-project-definition",
	gates: [
		{
			id: GATE_ID,
			name: "Review findings template",
			dependsOn: ["implementation"],
			content: "Future goal review instructions",
			verify: [
				{ name: "Typecheck", type: "command", run: "npm run check", phase: 0, timeout: 35 },
				{ name: STEP_NAME, type: "llm-review", prompt: "Review future goals", phase: 1, timeout: 15, futureOnly: true },
			],
		},
		{ id: "publish", name: "Publish", dependsOn: [GATE_ID], content: "Keep this project gate", verify: [] },
	],
};

const timeoutStep = {
	name: STEP_NAME,
	type: "llm-review",
	status: "timeout",
	passed: false,
	timeout: { configuredSeconds: 7, elapsedMs: 7004 },
	duration_ms: 91_234,
	output: "opaque reviewer payload zxq-4711",
};

type FetchLogEntry = { url: string; method: string; body: any };
type ResetOptions = { goalPutError?: string };

let activeWorkflow: any;
let projectWorkflow: any;
let fetchLog: FetchLogEntry[] = [];
let goalPutError = "";
let projectCustomized = false;

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
	const url = new URL(raw, window.location.href);
	return `${url.pathname}${url.search}`;
}

function parseBody(init?: RequestInit): any {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const method = (init?.method || "GET").toUpperCase();
	const body = parseBody(init);
	fetchLog.push({ url, method, body: clone(body) });

	if (url === `/api/goals/${GOAL_ID}` && method === "GET") {
		return response({
			id: GOAL_ID,
			title: "Timeout fixture goal",
			projectId: PROJECT_ID,
			workflowId: WORKFLOW_ID,
			workflow: clone(activeWorkflow),
		});
	}
	if (url === `/api/projects/${PROJECT_ID}` && method === "GET") {
		return response({ id: PROJECT_ID, name: "Fixture Project", rootPath: "/fixture/project" });
	}
	if (url === `/api/goals/${GOAL_ID}/workflow` && method === "PUT") {
		if (goalPutError) return response({ error: goalPutError, code: "WORKFLOW_ACTIVE_VERIFICATION" }, 409);
		activeWorkflow = clone(body);
		return response(clone(activeWorkflow));
	}

	const workflowUrl = `/api/workflows/${WORKFLOW_ID}?projectId=${PROJECT_ID}`;
	const customizeUrl = `/api/workflows/${WORKFLOW_ID}/customize?projectId=${PROJECT_ID}`;
	if (url === workflowUrl && method === "GET") {
		return response({ ...clone(projectWorkflow), origin: projectCustomized ? "project" : "server" });
	}
	if (url === customizeUrl && method === "POST") {
		projectCustomized = true;
		return response(clone(projectWorkflow), 201);
	}
	if (url === workflowUrl && method === "PUT") {
		if (!projectCustomized) return response({ error: "Customize the inherited workflow first" }, 409);
		// Mirror the route: resolution metadata is read-only and is not persisted.
		projectWorkflow = {
			...projectWorkflow,
			name: body.name ?? projectWorkflow.name,
			description: body.description ?? projectWorkflow.description,
			gates: Array.isArray(body.gates) ? clone(body.gates) : projectWorkflow.gates,
			id: WORKFLOW_ID,
			updatedAt: body.updatedAt ?? projectWorkflow.updatedAt,
		};
		return response(clone(projectWorkflow));
	}

	// Terminal live fixtures should not reconcile, but keep accidental reads deterministic.
	if (url.includes(`/api/goals/${GOAL_ID}/gates/${GATE_ID}`) && method === "GET") {
		return response({ signals: [] });
	}
	return response({ error: `Unhandled fixture request: ${method} ${url}` }, 404);
}) as typeof window.fetch;

function toolResult(data: any): any {
	return { isError: false, content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function mount(): Promise<void> {
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	app.innerHTML = `
		<section data-testid="inspect-surface"><h2>Inspect surface</h2><div data-testid="inspect-renderer"></div></section>
		<section data-testid="inspect-without-context-surface"><h2>Inspect surface without context</h2><div data-testid="inspect-without-context-renderer"></div></section>
		<section data-testid="live-surface"><h2>Live surface</h2><div data-testid="live-renderer"></div></section>
	`;

	const inspectResult = toolResult({
		section: "verification",
		gateId: GATE_ID,
		signalIndex: 0,
		signalId: "signal-timeout",
		status: "failed",
		statusCounts: { failed: 1 },
		steps: [clone(timeoutStep)],
	});
	const inspectParams = { gate_id: GATE_ID, section: "verification" };

	const inspectHost = app.querySelector("[data-testid='inspect-renderer']") as HTMLElement;
	const inspect = new GateInspectRenderer().render(inspectParams, inspectResult, undefined, { goalId: GOAL_ID });
	render(inspect.content, inspectHost);

	const inspectWithoutContextHost = app.querySelector("[data-testid='inspect-without-context-renderer']") as HTMLElement;
	const inspectWithoutContext = new GateInspectRenderer().render(inspectParams, inspectResult);
	render(inspectWithoutContext.content, inspectWithoutContextHost);

	const liveHost = app.querySelector("[data-testid='live-renderer']") as HTMLElement;
	const live = document.createElement("gate-verification-live") as any;
	live.goalId = GOAL_ID;
	live.gateId = GATE_ID;
	live.signalId = "signal-timeout-live";
	live.finalStatus = "failed";
	live.initialSteps = [clone(timeoutStep)];
	liveHost.appendChild(live);
	await live.updateComplete;
}

function reset(options: ResetOptions = {}): void {
	activeWorkflow = clone(activeWorkflowSeed);
	projectWorkflow = clone(projectWorkflowSeed);
	fetchLog = [];
	goalPutError = options.goalPutError || "";
	projectCustomized = false;
}

state.projects = [{
	id: PROJECT_ID,
	name: "Fixture Project",
	rootPath: "/fixture/project",
	colorLight: "#6366f1",
	colorDark: "#818cf8",
}] as any;
state.activeProjectId = PROJECT_ID;
document.documentElement.dataset.currentGoalId = GOAL_ID;
document.documentElement.dataset.currentProjectId = PROJECT_ID;
localStorage.setItem("gateway.url", "http://fixture");
localStorage.setItem("gateway.token", "fixture-token");

(window as any).__timeoutFixtureReset = (options?: ResetOptions) => reset(options);
(window as any).__timeoutFixtureRequests = () => clone(fetchLog);
(window as any).__timeoutFixtureState = () => clone({ activeWorkflow, projectWorkflow, projectCustomized });
(window as any).__timeoutFixtureConstants = clone({ GOAL_ID, PROJECT_ID, WORKFLOW_ID, GATE_ID, STEP_NAME });

reset();
mount().then(() => { (window as any).__timeoutRemediationReady = true; });
