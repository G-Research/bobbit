import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_helpers/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/hq-explicit-project-scope.spec.ts. The real Skills and
// Settings renderers are mounted directly under happy-dom; HTTP remains a
// deterministic fixture so the asserted projectId boundary is observable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { clearSkillsPageState, loadSkillsPageData, renderSkillsPage } from "../../src/app/skills-page.js";
import { renderSettingsPage } from "../../src/app/settings-page.js";
import { setConfigScope } from "../../src/app/config-scope.js";
import { HEADQUARTERS_PROJECT_ID, HEADQUARTERS_PROJECT_KIND, HEADQUARTERS_PROJECT_NAME } from "../../src/app/headquarters.js";
import { setRenderApp, state, type Project } from "../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: unknown };
type PageKind = "skills" | "settings";

const NORMAL_PROJECT_ID = "proj-1";
const PROJECTS: Project[] = [
	{ id: HEADQUARTERS_PROJECT_ID, name: HEADQUARTERS_PROJECT_NAME, kind: HEADQUARTERS_PROJECT_KIND, rootPath: "/fixture/.bobbit/headquarters" } as Project,
	{ id: NORMAL_PROJECT_ID, name: "Fixture Project", kind: "normal", rootPath: "/fixture/project", colorLight: "#2563eb", colorDark: "#60a5fa", palette: "blue" } as Project,
];
const skillsByProject: Record<string, any[]> = {
	[HEADQUARTERS_PROJECT_ID]: [
		{ name: "hq-skill", description: "Headquarters skill", source: "custom", filePath: "/fixture/hq/SKILL.md", content: "# HQ skill" },
	],
	[NORMAL_PROJECT_ID]: [
		{ name: "project-skill", description: "Project skill", source: "project", filePath: "/fixture/project/SKILL.md", content: "# Project skill" },
	],
};
const configDirsByProject: Record<string, any[]> = {
	[HEADQUARTERS_PROJECT_ID]: [
		{ path: "/fixture/.bobbit/headquarters/config/skills", types: ["skills"], scope: "user", exists: true, isRemovable: false },
	],
	[NORMAL_PROJECT_ID]: [
		{ path: "/fixture/project/.bobbit/config/skills", types: ["skills"], scope: "project", exists: true, isRemovable: false },
	],
};

let currentPage: PageKind = "skills";
let fetchLog: FetchLogEntry[] = [];
let projectConfigs: Record<string, Record<string, unknown>> = {};
let previousProjects: Project[];
let previousActiveProjectId: string | null;

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function requestPath(input: RequestInfo | URL): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try { const url = new URL(raw, window.location.href); return `${url.pathname}${url.search}`; } catch { return raw; }
}

function parseBody(init?: RequestInit): unknown {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

function installFetch(): void {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestPath(input);
		const [pathname, query = ""] = url.split("?");
		const params = new URLSearchParams(query);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = parseBody(init);
		fetchLog.push({ url, method, body });

		if (pathname === "/api/projects") return response(PROJECTS);
		if (pathname === "/api/preferences") return response({});
		if (pathname === "/api/harness-status") return response({ restartAvailable: false });
		if (pathname === "/api/worktree-pool") return response({ enabled: false });
		if (pathname === "/api/sandbox-status") return response({ available: false, configured: false });
		if (pathname === "/api/sandbox/host-tokens") return response([]);
		if (pathname === "/api/aigw/status") return response({ configured: false, url: "", models: [] });
		if (pathname === "/api/models" || pathname === "/api/image-models") return response([]);
		if (pathname === "/api/oauth/status") return response({ authenticated: false });
		if (pathname.startsWith("/api/search/") || pathname.startsWith("/api/maintenance/")) return response({ count: 0, sample: [] });

		if (pathname === "/api/project-config") {
			if (method === "PUT" && body && typeof body === "object") {
				projectConfigs[HEADQUARTERS_PROJECT_ID] = { ...projectConfigs[HEADQUARTERS_PROJECT_ID], ...(body as Record<string, unknown>) };
			}
			return response(method === "PUT" ? { ok: true } : projectConfigs[HEADQUARTERS_PROJECT_ID]);
		}
		const projectConfigMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config$/);
		if (projectConfigMatch) {
			const id = decodeURIComponent(projectConfigMatch[1]);
			if (method === "PUT" && body && typeof body === "object") projectConfigs[id] = { ...projectConfigs[id], ...(body as Record<string, unknown>) };
			return response(method === "PUT" ? { ok: true } : projectConfigs[id] ?? {});
		}
		if (pathname === "/api/slash-skills/details" && method === "GET") {
			const projectId = params.get("projectId");
			if (!projectId) return response({ error: "projectId required", code: "PROJECT_ID_REQUIRED" }, 400);
			return response({
				skills: skillsByProject[projectId] ?? [],
				directories: [{ path: `/fixture/${projectId}/skills`, source: projectId === HEADQUARTERS_PROJECT_ID ? "server" : "project", isCustom: false }],
			});
		}
		if (pathname === "/api/config-directories" && method === "GET") {
			const projectId = params.get("projectId");
			if (!projectId) return response({ error: "projectId required", code: "PROJECT_ID_REQUIRED" }, 400);
			return response(configDirsByProject[projectId] ?? []);
		}
		return response({ ok: true });
	});
}

function container(): HTMLElement {
	return document.getElementById("container")!;
}

function doRender(): void {
	render(currentPage === "settings" ? renderSettingsPage() : renderSkillsPage(), container());
}

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("waitFor timed out");
}

async function waitForFetch(pattern: RegExp, method = "GET"): Promise<void> {
	await waitFor(() => fetchLog.some((entry) => entry.method === method && pattern.test(entry.url)));
}

async function renderSkills(scope: string): Promise<void> {
	currentPage = "skills";
	state.activeProjectId = scope === "system" ? HEADQUARTERS_PROJECT_ID : scope;
	setConfigScope(scope);
	clearSkillsPageState();
	history.replaceState({}, "", "#/skills");
	await loadSkillsPageData();
	doRender();
}

function renderSettings(hash: string): void {
	currentPage = "settings";
	history.replaceState({}, "", hash);
	doRender();
}

function exactButton(text: string): HTMLButtonElement {
	const button = [...container().querySelectorAll<HTMLButtonElement>("button")]
		.find((candidate) => candidate.textContent?.trim() === text);
	if (!button) throw new Error(`missing button ${text}`);
	return button;
}

beforeEach(() => {
	previousProjects = state.projects;
	previousActiveProjectId = state.activeProjectId;
	document.body.innerHTML = '<div id="container"></div>';
	fetchLog = [];
	projectConfigs = {
		[HEADQUARTERS_PROJECT_ID]: { skill_directories: "[]", config_directories: [] },
		[NORMAL_PROJECT_ID]: { skill_directories: "[]", config_directories: [] },
	};
	state.projects = PROJECTS;
	state.activeProjectId = HEADQUARTERS_PROJECT_ID;
	state.gatewaySessions = [];
	state.goals = [];
	state.appView = "authenticated";
	state.connectionStatus = "disconnected";
	currentPage = "skills";
	setConfigScope("system");
	clearSkillsPageState();
	history.replaceState({}, "", "#/skills");
	installFetch();
	setRenderApp(doRender);
});

afterEach(() => {
	setRenderApp(() => {});
	setConfigScope("system");
	clearSkillsPageState();
	state.projects = previousProjects;
	state.activeProjectId = previousActiveProjectId;
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("Headquarters explicit projectId UI calls", () => {
	it("Headquarters Skills loads and refreshes details with projectId=headquarters", async () => {
		await renderSkills("system");
		await waitForFetch(/^\/api\/slash-skills\/details\?projectId=headquarters$/);
		expect(container().textContent).toContain("/hq-skill");
		expect(fetchLog.some((entry) => entry.url === "/api/slash-skills/details" && entry.method === "GET")).toBe(false);

		fetchLog = [];
		exactButton("Skill Directories").click();
		await waitFor(() => !!container().querySelector('input[placeholder="~/my-skills or /absolute/path"]'));
		const input = container().querySelector<HTMLInputElement>('input[placeholder="~/my-skills or /absolute/path"]')!;
		input.value = "/fixture/custom-skills";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await waitFor(() => !exactButton("Add").disabled);
		exactButton("Add").click();
		await waitForFetch(/^\/api\/project-config$/, "PUT");
		await waitForFetch(/^\/api\/slash-skills\/details\?projectId=headquarters$/);
		expect(fetchLog.some((entry) => entry.url === "/api/slash-skills/details" && entry.method === "GET")).toBe(false);
	});

	it("normal project Skills loads details with the normal project id", async () => {
		await renderSkills("proj-1");
		await waitForFetch(/^\/api\/slash-skills\/details\?projectId=proj-1$/);
		expect(container().textContent).toContain("/project-skill");
	});

	it("Headquarters Config Directories loads with projectId=headquarters", async () => {
		renderSettings("#/settings/system/directories");
		await waitForFetch(/^\/api\/config-directories\?projectId=headquarters$/);
		await waitFor(() => container().textContent?.includes("/fixture/.bobbit/headquarters/config/skills") === true);
		expect(container().textContent).toContain("/fixture/.bobbit/headquarters/config/skills");
	});

	it("normal project Config Directories loads with the normal project id", async () => {
		renderSettings("#/settings/proj-1/directories");
		await waitForFetch(/^\/api\/config-directories\?projectId=proj-1$/);
		await waitFor(() => container().textContent?.includes("/fixture/project/.bobbit/config/skills") === true);
		expect(container().textContent).toContain("/fixture/project/.bobbit/config/skills");
	});
});
