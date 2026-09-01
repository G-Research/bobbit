import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/goal-workflow-editor.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled tests/ui-fixtures/goal-workflow-editor-entry.ts
// (which rendered the REAL src/app/workflow-page.ts renderWorkflowPage() into #app
// driven by state.setRenderApp) and drove it through a mocked /api/workflows.
// This port imports the SAME real modules and replicates the entry's window
// helpers as module functions. The gate/step bodies are ALWAYS in the DOM (expand
// is CSS-only, no layout under happy-dom), so we assert element presence/absence +
// values + the captured PUT payload rather than Playwright CSS visibility.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let render: typeof import("lit").render;
let renderWorkflowPage: typeof import("../../../src/app/workflow-page.js").renderWorkflowPage;
let loadWorkflowPageData: typeof import("../../../src/app/workflow-page.js").loadWorkflowPageData;
let navigateToWorkflowEdit: typeof import("../../../src/app/workflow-page.js").navigateToWorkflowEdit;
let clearWorkflowPageState: typeof import("../../../src/app/workflow-page.js").clearWorkflowPageState;
let setRenderApp: typeof import("../../../src/app/state.js").setRenderApp;
let state: any;
let setConfigScope: typeof import("../../../src/app/config-scope.js").setConfigScope;

const PROJECT_ID = "fixture-project";

type FixtureWorkflow = {
	id: string;
	name: string;
	description: string;
	gates: Array<{ id: string; name: string; dependsOn: string[]; verify?: Array<Record<string, any>>; [k: string]: any }>;
	[k: string]: any;
};

function workflowWithSteps(verify: Array<Record<string, any>>): FixtureWorkflow {
	return {
		id: "fixture-workflow",
		name: "Fixture Workflow",
		description: "Workflow editor fixture",
		gates: [{ id: "gate-1", name: "Gate 1", dependsOn: [], verify }],
	};
}

// ── in-memory backend + fetch log (ported from the entry) ───────────────────
let workflows: FixtureWorkflow[] = [];
let fetchLog: Array<{ url: string; method: string; body: any }> = [];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function response(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function requestPath(input: any): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try { const url = new URL(raw, "http://fixture"); return `${url.pathname}${url.search}`; } catch { return raw; }
}
function parseBody(init?: any): any {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}
function workflowIdFromPath(path: string): string | null {
	const match = path.match(/^\/api\/workflows\/([^?]+)/);
	return match ? decodeURIComponent(match[1]) : null;
}
function installFetchMock() {
	vi.stubGlobal("fetch", async (input: any, init?: any) => {
		const url = requestPath(input);
		const method = (init?.method || "GET").toUpperCase();
		const body = parseBody(init);
		fetchLog.push({ url, method, body: clone(body) });

		if (url.includes("/side-panel-workspace")) {
			return response({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" });
		}
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
			if (method === "GET") return idx >= 0 ? response(clone(workflows[idx])) : response({ error: "not found" }, 404);
			if (method === "PUT") {
				if (idx < 0) return response({ error: "not found" }, 404);
				workflows[idx] = { ...workflows[idx], ...body, id, updatedAt: Date.now() };
				return response(clone(workflows[idx]));
			}
			if (method === "DELETE") { workflows = workflows.filter((wf) => wf.id !== id); return response({ ok: true }); }
		}
		return response({});
	});
}

function doRender(): void {
	// state.ts schedules deferred renderApp() calls via setImmediate; one can fire
	// after afterEach tears down #app. A missing container is a no-op straggler,
	// not an error (mirrors the guide's fire-and-forget handling).
	const app = document.getElementById("app");
	if (!app) return;
	render(renderWorkflowPage(), app);
}

const settle = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function loadWorkflow(workflow: FixtureWorkflow): Promise<void> {
	workflows = [clone(workflow)];
	fetchLog = [];
	state.projects = [{ id: PROJECT_ID, name: "Fixture Project", rootPath: "/fixture/project", colorLight: "#6366f1", colorDark: "#818cf8" }];
	state.activeProjectId = PROJECT_ID;
	setConfigScope(PROJECT_ID);
	clearWorkflowPageState();
	window.location.hash = "#/workflows";
	await loadWorkflowPageData();
	navigateToWorkflowEdit(workflow.id);
	doRender();
	await settle();
}

const q = <T extends Element = Element>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const qa = (sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel));
function buttonByText(text: string | RegExp): HTMLButtonElement | undefined {
	return qa("button").find((b) => {
		const t = (b.textContent || "").trim();
		return typeof text === "string" ? t === text : text.test(t);
	}) as HTMLButtonElement | undefined;
}
function stepBody(): HTMLElement { return q<HTMLElement>(".wf-vstep-body")!; }
async function lastPutBody(timeout = 3000): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const put = fetchLog.filter((e) => e.method === "PUT").at(-1);
		if (put) return put.body;
		await new Promise((r) => setTimeout(r, 15));
	}
	return null;
}

beforeAll(async () => {
	localStorage.setItem("gateway.url", "http://fixture");
	localStorage.setItem("gateway.token", "fixture-token");
	await import("../../../src/app/session-manager.js");
	({ render } = await import("lit"));
	({ renderWorkflowPage, loadWorkflowPageData, navigateToWorkflowEdit, clearWorkflowPageState } = await import("../../../src/app/workflow-page.js"));
	({ setRenderApp, state } = await import("../../../src/app/state.js"));
	({ setConfigScope } = await import("../../../src/app/config-scope.js"));
	(window as any).WebSocket = class { static OPEN = 1; readyState = 1; addEventListener() {} removeEventListener() {} send() {} close() {} };
	window.confirm = () => true;
	setRenderApp(doRender);
	__syncCE();
});

beforeEach(() => {
	fetchLog = [];
	installFetchMock();
	document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
	// Restore the shared config scope: setConfigScope(PROJECT_ID) in setup mutates
	// a module-global in config-scope.js that would otherwise leak "fixture-project"
	// into later files (e.g. tool-manager, which expects the "system" default).
	setConfigScope("system");
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

// The render callback is installed once in beforeAll, so it must be neutralized
// once here (not per-test) — otherwise a debounced straggler render scheduled by
// this file fires doRender into a torn-down / foreign container under
// isolate:false (the state module is shared across files).
afterAll(() => { setRenderApp(() => {}); });

describe("Goal/workflow editor fixture (v2-dom)", () => {
	it("agent-qa type shows prompt textarea and hides command-only controls", async () => {
		await loadWorkflow(workflowWithSteps([{ name: "Test step", type: "command", run: "echo test", phase: 0 }]));

		const typeSelect = q<HTMLSelectElement>('[data-testid="wf-step-type"]', stepBody())!;
		expect(typeSelect.value).toBe("command");
		expect(q('[data-testid="wf-step-run"]', stepBody())).toBeTruthy();

		typeSelect.value = "agent-qa";
		typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();

		expect(q('[data-testid="wf-step-prompt"]', stepBody())).toBeTruthy();
		expect(q('[data-testid="wf-step-run"]', stepBody())).toBeNull();
		expect(qa("select.wf-select", stepBody()).length).toBe(1);
	});

	it("free-form command run hint advertises supported variables only", async () => {
		await loadWorkflow(workflowWithSteps([{ name: "Run step", type: "command", run: "echo test", phase: 0 }]));

		const hint = q('[data-testid="wf-step-run-hint"]', stepBody())!;
		expect(hint).toBeTruthy();
		const hintText = hint.textContent || "";
		expect(hintText).toContain("{{baseBranch}}");
		expect(hintText).not.toContain("{{master}}");
		expect(hintText).not.toContain("{{project.");
	});

	it("phase grouping renders headers and defaults missing phase to phase 0", async () => {
		await loadWorkflow(workflowWithSteps([
			{ name: "No phase step", type: "command", run: "echo default" },
			{ name: "Lint check", type: "command", run: "echo lint", phase: 0 },
			{ name: "Integration test", type: "command", run: "echo integration", phase: 1 },
		]));

		expect(qa(".wf-phase-group").length).toBe(2);
		const headerTexts = qa(".wf-phase-header").map((h) => h.textContent || "");
		expect(headerTexts.some((t) => /Phase 0/.test(t))).toBe(true);
		expect(headerTexts.some((t) => /Phase 1/.test(t))).toBe(true);
		expect(qa(".wf-vstep-card", qa(".wf-phase-group")[0]).length).toBe(2);
		expect(qa(".wf-vstep-card", qa(".wf-phase-group")[1]).length).toBe(1);
	});

	it("optional checkbox reveals label input and save payload preserves optional fields", async () => {
		await loadWorkflow(workflowWithSteps([{ name: "QA step", type: "agent-qa", prompt: "Run QA", phase: 0 }]));

		const optionalCheckbox = q<HTMLInputElement>('.wf-vstep-optional-row input[type="checkbox"]', stepBody())!;
		expect(optionalCheckbox).toBeTruthy();
		optionalCheckbox.checked = true;
		optionalCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();

		const labelInput = q<HTMLInputElement>('[data-testid="wf-step-optional-label"]', stepBody())!;
		expect(labelInput).toBeTruthy();
		labelInput.value = "Enable QA Testing";
		labelInput.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();

		buttonByText("Save")!.click();
		const body = await lastPutBody();
		expect(body).not.toBeNull();
		expect(body.gates[0].verify[0]).toMatchObject({
			name: "QA step",
			type: "agent-qa",
			optional: true,
			optionalLabel: "Enable QA Testing",
		});
		expect(body.gates[0].verify[0].label).toBeUndefined();
	});

	it("Add Phase creates a removable empty phase group", async () => {
		await loadWorkflow(workflowWithSteps([{ name: "Step 1", type: "command", run: "echo ok", phase: 0 }]));

		const initialCount = qa(".wf-phase-group").length;
		buttonByText(/Add Phase/i)!.click();
		await settle();
		expect(qa(".wf-phase-group").length).toBe(initialCount + 1);

		const deleteBtn = qa(".wf-phase-delete").at(-1) as HTMLElement;
		expect(deleteBtn).toBeTruthy();
		deleteBtn.click();
		await settle();
		expect(qa(".wf-phase-group").length).toBe(initialCount);
	});

	it("save compacts non-contiguous phase numbers in the PUT payload", async () => {
		await loadWorkflow(workflowWithSteps([
			{ name: "Step A", type: "command", run: "echo a", phase: 0 },
			{ name: "Step B", type: "command", run: "echo b", phase: 2 },
		]));

		buttonByText("Save")!.click();
		const body = await lastPutBody();
		expect(body).not.toBeNull();
		expect(body.gates[0].verify.map((step: any) => step.phase ?? 0)).toEqual([0, 1]);
	});
});
