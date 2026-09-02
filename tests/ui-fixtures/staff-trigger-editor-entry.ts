import { render } from "lit";
import { commitGatewayConnection } from "../../src/app/gateway-fetch.js";
import { loadStaffPageData, navigateToStaffEdit, renderStaffPage } from "../../src/app/staff-page.js";
import { setRenderApp, state } from "../../src/app/state.js";

const STAFF_ID = "staff-trigger-fixture";
const PROJECT_ID = "staff-trigger-project";
const STAFF = {
	id: STAFF_ID,
	name: "Trigger Fixture Staff",
	description: "Exercises the staff trigger editor.",
	systemPrompt: "Watch goal lifecycle events.",
	cwd: "/tmp/staff-trigger-project",
	projectId: PROJECT_ID,
	state: "active",
	triggers: [],
	accessory: "none",
	sandboxed: false,
	createdAt: 1,
	updatedAt: 1,
};

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const url = new URL(raw, window.location.href);
	const path = url.pathname.replace(/^\/fixture-gateway/, "");
	if (path === "/api/staff") return response({ staff: [STAFF] });
	if (path.startsWith("/api/roles")) return response({ roles: [] });
	if (path === `/api/staff/${STAFF_ID}` && init?.method === "PUT") {
		(window as any).__staffTriggerPutBody = JSON.parse(String(init.body ?? "{}"));
		return response({ ...STAFF, ...(window as any).__staffTriggerPutBody });
	}
	if (path.startsWith("/api/sessions/")) return response({ id: "staff-session", cwd: STAFF.cwd });
	return response({});
}) as typeof window.fetch;

function renderFixture(): void {
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	render(renderStaffPage(), app);
}

async function start(): Promise<void> {
	commitGatewayConnection("https://fixture.test/fixture-gateway", "fixture-token");
	Object.assign(state, {
		activeProjectId: PROJECT_ID,
		projects: [{ id: PROJECT_ID, name: "Trigger Project", rootPath: STAFF.cwd }],
		gatewaySessions: [],
	});
	setRenderApp(renderFixture);
	await loadStaffPageData();
	navigateToStaffEdit(STAFF_ID);
	renderFixture();
	(window as any).__staffTriggerEditorReady = true;
}

void start();
