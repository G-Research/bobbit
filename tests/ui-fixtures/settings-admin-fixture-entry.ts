import { render } from "lit";
import { renderSettingsPage } from "../../src/app/settings-page.js";
import { clearRolePageState, loadRolePageData, navigateToRoleEdit, renderRoleManagerPage } from "../../src/app/role-manager-page.js";
import { clearToolPageState, loadToolPageData, renderToolManagerPage } from "../../src/app/tool-manager-page.js";
import { setConfigScope } from "../../src/app/config-scope.js";
import { setProjects, setRenderApp, state, type Project } from "../../src/app/state.js";
import type { RoleData, ToolInfo, Workflow } from "../../src/app/api.js";

type FetchLogEntry = { url: string; method: string; body: any };
type OAuthStatus = Partial<Record<"anthropic" | "openai-codex" | "google", { authenticated: boolean; expires?: number }>>;
type CloudProviderStatus = {
	id: "anthropic" | "openai" | "google";
	label: string;
	enabled: boolean;
	configured: boolean;
	authenticated: boolean;
	expired: boolean;
	needsReauth: boolean;
	status: "disabled" | "enabled_without_credential" | "authenticated" | "expired" | "invalid" | "oauth_unavailable" | "aigw_bypass";
	credentialTypes: Array<"oauth" | "api_key" | "env" | "host_token">;
	oauthSupported: boolean;
	apiKeySupported: boolean;
	expires?: number;
	message?: string;
};
type StructuredProject = { components: any[]; workflows?: Record<string, unknown>; worktree_root?: string };

const STORE_PREFIX = "bobbit-settings-admin-fixture";
const PREFS_KEY = `${STORE_PREFIX}:prefs`;
const ROLES_KEY = `${STORE_PREFIX}:roles`;
const STRUCTURED_KEY = `${STORE_PREFIX}:structured`;

const DEFAULT_PROJECTS: Project[] = [
	{ id: "proj-1", name: "Scope UI Project", rootPath: "/fixture/project", colorLight: "#2563eb", colorDark: "#60a5fa", palette: "blue" },
];

const DEFAULT_IMAGE_MODELS = [
	{ id: "gpt-image-2", name: "GPT Image 2", provider: "openai", api: "openai-images", authenticated: true },
	{ id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", provider: "google", api: "gemini-images", authenticated: true },
	{ id: "imagen-4.0-fast-generate-001", name: "Imagen 4 Fast", provider: "google", api: "google-imagen", authenticated: true },
];

const DEFAULT_MODELS = [
	{ id: "claude-opus-4-1", provider: "anthropic", reasoning: true },
	{ id: "claude-sonnet", provider: "anthropic", reasoning: true },
	{ id: "gpt-4o", provider: "openai", reasoning: false },
];

function defaultRoles(): RoleData[] {
	return [
		{
			name: "coder",
			label: "Coder",
			promptTemplate: "You write code.",
			accessory: "none",
			toolPolicies: {},
			createdAt: 1,
			updatedAt: 1,
			origin: "builtin",
		} as RoleData & { origin: string },
		{
			name: "reviewer",
			label: "Reviewer",
			promptTemplate: "You review code.",
			accessory: "glasses",
			toolPolicies: {},
			createdAt: 1,
			updatedAt: 1,
			origin: "server",
		} as RoleData & { origin: string },
	];
}

function defaultTools(): ToolInfo[] {
	return [
		{ name: "bash", description: "Run a shell command.", group: "Shell", origin: "builtin" } as ToolInfo & { origin: string },
		{ name: "grep", description: "Search file contents.", group: "File System", origin: "server" } as ToolInfo & { origin: string },
	];
}

function defaultWorkflows(): Workflow[] {
	return [
		{ id: "wf-fixture", name: "Fixture Workflow", description: "A workflow fixture", gates: [], createdAt: 1, updatedAt: 1 },
	];
}

function defaultStructuredProjects(): Record<string, StructuredProject> {
	return {
		"proj-1": {
			components: [
				{ name: "app", repo: ".", relative_path: "", worktree_setup_command: "", commands: {}, config: {} },
			],
			workflows: {},
			worktree_root: "",
		},
	};
}

let currentPage: "settings" | "roles" | "tools" = "settings";
let prefs: Record<string, any> = readJson(PREFS_KEY, {});
let roles: RoleData[] = readJson(ROLES_KEY, defaultRoles());
let projects: Project[] = DEFAULT_PROJECTS;
let tools: ToolInfo[] = defaultTools();
let workflows: Workflow[] = defaultWorkflows();
let structuredProjects: Record<string, StructuredProject> = readJson(STRUCTURED_KEY, defaultStructuredProjects());
function defaultCloudProviders(): CloudProviderStatus[] {
	return [
		{
			id: "anthropic",
			label: "Anthropic",
			enabled: true,
			configured: true,
			authenticated: true,
			expired: false,
			needsReauth: false,
			status: "authenticated",
			credentialTypes: ["oauth"],
			oauthSupported: true,
			apiKeySupported: false,
		},
		{
			id: "openai",
			label: "OpenAI",
			enabled: true,
			configured: false,
			authenticated: false,
			expired: false,
			needsReauth: false,
			status: "enabled_without_credential",
			credentialTypes: [],
			oauthSupported: true,
			apiKeySupported: true,
		},
		{
			id: "google",
			label: "Google Gemini",
			enabled: false,
			configured: false,
			authenticated: false,
			expired: false,
			needsReauth: false,
			status: "disabled",
			credentialTypes: [],
			oauthSupported: false,
			apiKeySupported: true,
			message: "Google sign-in is not available in this build. Add a Gemini API key instead.",
		},
	];
}

let oauthStatus: OAuthStatus = {
	anthropic: { authenticated: true },
	"openai-codex": { authenticated: false },
	google: { authenticated: false },
};
let cloudProviders: CloudProviderStatus[] = defaultCloudProviders();
let fetchLog: FetchLogEntry[] = [];

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) as T : fallback;
	} catch {
		return fallback;
	}
}

function writeJson(key: string, value: unknown): void {
	localStorage.setItem(key, JSON.stringify(value));
}

function persistStores(): void {
	writeJson(PREFS_KEY, prefs);
	writeJson(ROLES_KEY, roles);
	writeJson(STRUCTURED_KEY, structuredProjects);
}

function hydrateAppState(): void {
	setProjects(projects);
	state.gatewaySessions = [];
	state.goals = [];
	state.appView = "authenticated";
	state.connectionStatus = "disconnected";
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

function applyPreferencePatch(body: Record<string, any>): void {
	for (const [key, value] of Object.entries(body || {})) {
		if (value === null || value === undefined || value === "") delete prefs[key];
		else prefs[key] = value;
	}
	persistStores();
}

function updatePlayFinishDataset(): void {
	document.documentElement.dataset.playAgentFinishSound = prefs.playAgentFinishSound === false ? "false" : "true";
}

function getRole(name: string): RoleData | undefined {
	return roles.find((r) => r.name === name);
}

function applyRoleUpdate(name: string, updates: Record<string, any>): RoleData {
	let role = getRole(name);
	if (!role) {
		role = {
			name,
			label: name,
			promptTemplate: "",
			accessory: "none",
			toolPolicies: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		roles.push(role);
	}
	for (const [key, value] of Object.entries(updates || {})) {
		if ((key === "model" || key === "thinkingLevel") && (value === "" || value === null || value === undefined)) {
			delete (role as any)[key];
		} else {
			(role as any)[key] = value;
		}
	}
	role.updatedAt = Date.now();
	persistStores();
	return role;
}

function projectIdFromPath(pathname: string, suffix: string): string | null {
	const re = new RegExp(`^/api/projects/([^/]+)${suffix}$`);
	const match = pathname.match(re);
	return match ? decodeURIComponent(match[1]) : null;
}

window.open = (() => null) as typeof window.open;
window.confirm = (() => true) as typeof window.confirm;

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = requestPath(input);
	const [pathname, query = ""] = url.split("?");
	const params = new URLSearchParams(query);
	const method = (init?.method || "GET").toUpperCase();
	const body = parseBody(init);
	fetchLog.push({ url, method, body });

	if (pathname === "/api/preferences") {
		if (method === "GET") {
			updatePlayFinishDataset();
			return response(prefs);
		}
		if (method === "PUT") {
			applyPreferencePatch(body || {});
			updatePlayFinishDataset();
			return response({ ok: true });
		}
	}

	if (pathname === "/api/aigw/status") return response({ configured: false, url: "", models: [] });
	if (pathname === "/api/cloud-providers/status") {
		return response({
			mode: "direct-cloud",
			aigwConfigured: false,
			authGateRequired: !cloudProviders.some((p) => p.enabled && p.authenticated),
			providers: cloudProviders,
		});
	}
	const cloudProviderMatch = pathname.match(/^\/api\/cloud-providers\/([^/]+)$/);
	if (cloudProviderMatch && method === "PUT") {
		const providerId = decodeURIComponent(cloudProviderMatch[1]) as CloudProviderStatus["id"];
		cloudProviders = cloudProviders.map((provider) => {
			if (provider.id !== providerId) return provider;
			const enabled = body?.enabled === true;
			return {
				...provider,
				enabled,
				status: enabled
					? (provider.authenticated ? "authenticated" : "enabled_without_credential")
					: "disabled",
			};
		});
		prefs[`providerEnabled.${providerId}`] = body?.enabled === true;
		persistStores();
		return response({ ok: true });
	}
	if (pathname === "/api/models") return response(DEFAULT_MODELS);
	if (pathname === "/api/image-models") return response(DEFAULT_IMAGE_MODELS);
	if (pathname === "/api/models/test") return response({ ok: true, latencyMs: 1 });
	if (pathname === "/api/oauth/status") {
		const provider = params.get("provider") as keyof OAuthStatus | null;
		return response((provider && oauthStatus[provider]) || { authenticated: false });
	}
	if (pathname === "/api/oauth/start" && method === "POST") {
		return response({ flowId: "fixture-flow", url: "https://auth.example/fixture", callbackServer: false, instructions: "Paste the fixture code." });
	}

	if (pathname === "/api/projects" && method === "GET") return response(projects);

	const structuredProjectId = projectIdFromPath(pathname, "/structured");
	if (structuredProjectId && method === "GET") {
		return response(structuredProjects[structuredProjectId] || { components: [], workflows: {}, worktree_root: "" });
	}

	const resolvedConfigProjectId = projectIdFromPath(pathname, "/config/resolved");
	if (resolvedConfigProjectId && method === "GET") return response({});

	const configProjectId = projectIdFromPath(pathname, "/config");
	if (configProjectId) {
		if (method === "GET") return response({});
		if (method === "PUT") {
			const current = structuredProjects[configProjectId] || { components: [], workflows: {}, worktree_root: "" };
			structuredProjects[configProjectId] = {
				...current,
				components: Array.isArray(body?.components) ? body.components : current.components,
				workflows: body?.workflows && typeof body.workflows === "object" ? body.workflows : current.workflows,
				worktree_root: typeof body?.worktree_root === "string" ? body.worktree_root : current.worktree_root,
			};
			persistStores();
			return response({ ok: true });
		}
	}

	if (pathname === "/api/roles" && method === "GET") return response({ roles });
	if (pathname === "/api/roles/assistant/prompts" && method === "GET") return response({ prompts: [] });
	const roleMatch = pathname.match(/^\/api\/roles\/([^/]+)$/);
	if (roleMatch) {
		const name = decodeURIComponent(roleMatch[1]);
		if (method === "GET") return getRole(name) ? response(getRole(name)) : response({ error: "not found" }, 404);
		if (method === "PUT") return response(applyRoleUpdate(name, body || {}));
		if (method === "DELETE") {
			roles = roles.filter((r) => r.name !== name);
			persistStores();
			return response({ ok: true });
		}
	}

	if (pathname === "/api/tools" && method === "GET") return response({ tools });
	if (pathname === "/api/mcp-servers" && method === "GET") return response([]);
	if (pathname === "/api/tool-group-policies" && method === "GET") return response({});
	if (pathname === "/api/workflows" && method === "GET") return response({ workflows });
	if (pathname === "/api/sandbox-status") return response({ available: false, configured: false });
	if (pathname === "/api/worktree-pool") return response({ enabled: false });
	if (pathname === "/api/sandbox/host-tokens") return response([]);
	if (pathname.startsWith("/api/search/") || pathname.startsWith("/api/maintenance/")) return response({ count: 0, sample: [] });

	return response({ ok: true });
}) as typeof window.fetch;

function doRender(): void {
	hydrateAppState();
	const container = document.getElementById("container");
	if (!container) throw new Error("#container missing");
	const template = currentPage === "roles"
		? renderRoleManagerPage()
		: currentPage === "tools"
			? renderToolManagerPage()
			: renderSettingsPage();
	render(template, container);
}

setRenderApp(doRender);
window.addEventListener("hashchange", () => doRender());
hydrateAppState();
updatePlayFinishDataset();

(window as any).__resetSettingsAdminFixture = (opts: {
	prefs?: Record<string, any>;
	projects?: Project[];
	roles?: RoleData[];
	tools?: ToolInfo[];
	workflows?: Workflow[];
	structuredProjects?: Record<string, StructuredProject>;
	oauthStatus?: OAuthStatus;
	cloudProviders?: CloudProviderStatus[];
} = {}) => {
	localStorage.removeItem(PREFS_KEY);
	localStorage.removeItem(ROLES_KEY);
	localStorage.removeItem(STRUCTURED_KEY);
	prefs = { ...(opts.prefs || {}) };
	projects = opts.projects || DEFAULT_PROJECTS;
	roles = opts.roles || defaultRoles();
	tools = opts.tools || defaultTools();
	workflows = opts.workflows || defaultWorkflows();
	structuredProjects = opts.structuredProjects || defaultStructuredProjects();
	oauthStatus = {
		anthropic: { authenticated: true },
		"openai-codex": { authenticated: false },
		google: { authenticated: false },
		...(opts.oauthStatus || {}),
	};
	cloudProviders = opts.cloudProviders || defaultCloudProviders();
	fetchLog = [];
	setConfigScope("system");
	persistStores();
	updatePlayFinishDataset();
	hydrateAppState();
	doRender();
};

(window as any).__renderSettingsAdminSettings = (hash: string) => {
	currentPage = "settings";
	if (window.location.hash !== hash) {
		history.replaceState({}, "", hash);
	}
	doRender();
};

(window as any).__loadSettingsAdminRoles = async (hash = "#/roles") => {
	currentPage = "roles";
	setConfigScope("system");
	if (window.location.hash !== hash) history.replaceState({}, "", hash);
	clearRolePageState();
	await loadRolePageData();
	const match = hash.match(/^#\/roles\/([^/]+)$/);
	if (match) navigateToRoleEdit(decodeURIComponent(match[1]));
	doRender();
};

(window as any).__loadSettingsAdminTools = async (hash = "#/tools") => {
	currentPage = "tools";
	setConfigScope("system");
	if (window.location.hash !== hash) history.replaceState({}, "", hash);
	clearToolPageState();
	await loadToolPageData();
	doRender();
};

(window as any).__putSettingsAdminRole = (name: string, updates: Record<string, any>) => applyRoleUpdate(name, updates);
(window as any).__getSettingsAdminPrefs = () => ({ ...prefs });
(window as any).__getSettingsAdminRoles = () => roles.map((r) => ({ ...r }));
(window as any).__getSettingsAdminStructured = (projectId = "proj-1") => JSON.parse(JSON.stringify(structuredProjects[projectId] || null));
(window as any).__getSettingsAdminFetchLog = () => fetchLog.slice();
(window as any).__clearSettingsAdminFetchLog = () => { fetchLog = []; };
(window as any).__settingsAdminReady = true;
