import { render } from "lit";
import { clearSkillsPageState, loadSkillsPageData, renderSkillsPage } from "../../src/app/skills-page.js";
import { renderSettingsPage } from "../../src/app/settings-page.js";
import { setConfigScope } from "../../src/app/config-scope.js";
import { HEADQUARTERS_PROJECT_ID, HEADQUARTERS_PROJECT_KIND, HEADQUARTERS_PROJECT_NAME } from "../../src/app/headquarters.js";
import { setProjects, setRenderApp, state, type Project } from "../../src/app/state.js";

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
let projectConfig: Record<string, unknown> = { skill_directories: "[]" };

function hydrateAppState(): void {
	setProjects(PROJECTS);
	state.gatewaySessions = [];
	state.goals = [];
	state.appView = "authenticated";
	state.connectionStatus = "disconnected";
}

function response(body: unknown, status = 200): Response {
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

function parseBody(init?: RequestInit): unknown {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const [pathname, query = ""] = url.split("?");
	const params = new URLSearchParams(query);
	const method = (init?.method || "GET").toUpperCase();
	const body = parseBody(init);
	fetchLog.push({ url, method, body });

	if (pathname === "/api/projects" && method === "GET") return response(PROJECTS);
	if (pathname === "/api/preferences") return response({});
	if (pathname === "/api/harness-status") return response({ restartAvailable: false });
	if (pathname === "/api/worktree-pool") return response({ enabled: false });
	if (pathname === "/api/sandbox-status") return response({ available: false, configured: false });
	if (pathname === "/api/sandbox/host-tokens") return response([]);
	if (pathname === "/api/aigw/status") return response({ configured: false, url: "", models: [] });
	if (pathname === "/api/models") return response([]);
	if (pathname === "/api/image-models") return response([]);
	if (pathname === "/api/oauth/status") return response({ authenticated: false });
	if (pathname.startsWith("/api/search/") || pathname.startsWith("/api/maintenance/")) return response({ count: 0, sample: [] });

	if (pathname === "/api/project-config") {
		if (method === "GET") return response(projectConfig);
		if (method === "PUT") {
			if (body && typeof body === "object") projectConfig = { ...projectConfig, ...(body as Record<string, unknown>) };
			return response({ ok: true });
		}
	}

	if (pathname === "/api/slash-skills/details" && method === "GET") {
		const projectId = params.get("projectId");
		if (!projectId) return response({ error: "projectId required", code: "PROJECT_ID_REQUIRED" }, 400);
		return response({
			skills: skillsByProject[projectId] || [],
			directories: [
				{ path: `/fixture/${projectId}/skills`, source: projectId === HEADQUARTERS_PROJECT_ID ? "server" : "project", isCustom: false },
			],
		});
	}

	if (pathname === "/api/config-directories" && method === "GET") {
		const projectId = params.get("projectId");
		if (!projectId) return response({ error: "projectId required", code: "PROJECT_ID_REQUIRED" }, 400);
		return response(configDirsByProject[projectId] || []);
	}

	return response({ ok: true });
}) as typeof window.fetch;

function doRender(): void {
	hydrateAppState();
	const container = document.getElementById("container");
	if (!container) throw new Error("#container missing");
	render(currentPage === "settings" ? renderSettingsPage() : renderSkillsPage(), container);
}

setRenderApp(doRender);
hydrateAppState();

(window as any).__resetHqExplicitScopeFixture = () => {
	currentPage = "skills";
	fetchLog = [];
	projectConfig = { skill_directories: "[]" };
	setConfigScope("system");
	clearSkillsPageState();
	history.replaceState({}, "", "#/skills");
	hydrateAppState();
	doRender();
};

(window as any).__renderHqExplicitSkills = async (scope: string) => {
	currentPage = "skills";
	setConfigScope(scope);
	clearSkillsPageState();
	history.replaceState({}, "", "#/skills");
	await loadSkillsPageData();
	doRender();
};

(window as any).__renderHqExplicitSettings = (hash: string) => {
	currentPage = "settings";
	if (window.location.hash !== hash) history.replaceState({}, "", hash);
	doRender();
};

(window as any).__getHqExplicitFetchLog = () => fetchLog.slice();
(window as any).__clearHqExplicitFetchLog = () => { fetchLog = []; };
(window as any).__hqExplicitScopeReady = true;
