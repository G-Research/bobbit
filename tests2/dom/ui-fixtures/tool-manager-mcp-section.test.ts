import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/tool-manager-mcp-section.spec.ts (v2-dom tier).
// Renders the REAL renderToolManagerPage() MCP section under happy-dom (was an
// esbuild file:// bundle). fetch is stubbed to serve tools/roles/mcp-servers and
// to capture tool-group-policy PUTs, mirroring the legacy fixture entry glue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { clearToolPageState, loadToolPageData, renderToolManagerPage } from "../../../src/app/tool-manager-page.js";
import { setRenderApp } from "../../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: any };

const FAKE_SERVERS = [
	{
		name: "halo",
		status: "connected",
		toolCount: 2,
		tools: [
			{ name: "mcp__halo__get-direct-reports", description: "Returns the direct reports for an entity.", op: "get-direct-reports" },
			{ name: "mcp__halo__list-employees", description: "Lists employees.", op: "list-employees" },
		],
	},
	{ name: "broken", status: "error", toolCount: 0, error: "stdio transport: ENOENT spawn", tools: [] },
];

const GATEWAY_SERVERS = [
	{
		name: "gr",
		status: "connected",
		toolCount: 3,
		tools: [
			{ name: "mcp__gr__ai-adoption__list-articles", description: "List adoption articles.", subNamespace: "ai-adoption", op: "list-articles" },
			{ name: "mcp__gr__ai-adoption__create-article", description: "Create an adoption article.", subNamespace: "ai-adoption", op: "create-article" },
			{ name: "mcp__gr__jira__get-queue", description: "Read the jira queue.", subNamespace: "jira", op: "get-queue" },
		],
	},
	{
		name: "playwright",
		status: "connected",
		toolCount: 2,
		tools: [
			{ name: "mcp__playwright__click", description: "Click a CSS selector.", op: "click" },
			{ name: "mcp__playwright__snap", description: "Snapshot accessibility tree.", op: "snap" },
		],
	},
];

let mcpServers: any[] = [];
let policies: Record<string, string> = {};
let fetchLog: FetchLogEntry[] = [];

function response(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function requestPath(input: any): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try { const u = new URL(raw, window.location.href); return `${u.pathname}${u.search}`; } catch { return raw; }
}
function parseBody(init?: any): any {
	if (!init?.body || typeof init.body !== "string") return null;
	try { return JSON.parse(init.body); } catch { return init.body; }
}

function installFetch(): void {
	vi.stubGlobal("fetch", async (input: any, init?: any) => {
		const url = requestPath(input);
		const method = (init?.method || "GET").toUpperCase();
		const body = parseBody(init);
		fetchLog.push({ url, method, body });
		if (url.includes("/side-panel-workspace")) return response({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" });
		if (url.startsWith("/api/tools")) return response({ tools: [{ name: "bash", description: "Run a shell command.", group: "Shell" }] });
		if (url.startsWith("/api/roles")) return response([]);
		if (url.startsWith("/api/mcp-servers")) return response(mcpServers);
		if (url.startsWith("/api/tool-group-policies") && method === "GET") {
			const cascade: Record<string, { policy: string; origin: string }> = {};
			for (const [key, policy] of Object.entries(policies)) cascade[key] = { policy, origin: "fixture" };
			return response(cascade);
		}
		if (url.startsWith("/api/tool-group-policies/") && method === "PUT") {
			const key = decodeURIComponent(url.split("/").pop() || "");
			const policy = body?.policy ?? null;
			if (policy) policies[key] = policy; else delete policies[key];
			return response({ ok: true });
		}
		return response({});
	});
}

function container(): HTMLElement { return document.getElementById("container")!; }
function doRender(): void { render(renderToolManagerPage(), container()); }
// renderApp() is rAF-debounced (state.ts) and the policy handlers chain two
// fetches before re-rendering, so settle across a few macrotasks each step.
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((r) => setTimeout(r, 0)); };

const $ = (sel: string, root: ParentNode = container()) => root.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string, root: ParentNode = container()) => Array.from(root.querySelectorAll(sel)) as HTMLElement[];
const text = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
const selectedText = (sel: HTMLSelectElement) => (sel.options[sel.selectedIndex]?.textContent || "").replace(/\s+/g, " ").trim();

function selectOption(sel: HTMLSelectElement, value: string): void {
	sel.value = value;
	sel.dispatchEvent(new Event("change", { bubbles: true }));
}

// Expansion (expandedMcpServers/expandedMcpTools) is module-private ephemeral
// view state with no reset hook — a real browser reload clears it by getting a
// fresh module. happy-dom shares the module across tests/reloads, so we collapse
// everything back to the fresh-mount (all-collapsed) baseline explicitly.
async function collapseAll(): Promise<void> {
	for (let g = 0; g < 100; g++) {
		const ops = $('[data-testid="mcp-server-ops"]');
		if (!ops) break;
		const toolRow = ops.closest('[data-testid="mcp-tool-row"]') as HTMLElement | null;
		const toggle = toolRow ? $('[data-testid="mcp-tool-toggle"]', toolRow) : null;
		if (!toggle) break;
		toggle.click();
		await tick();
	}
	for (let g = 0; g < 100; g++) {
		const toolRow = $('[data-testid="mcp-tool-row"]');
		if (!toolRow) break;
		const serverRow = toolRow.closest('[data-testid="mcp-server-row"]') as HTMLElement | null;
		const toggle = serverRow ? $('[data-testid="mcp-server-toggle"]', serverRow) : null;
		if (!toggle) break;
		toggle.click();
		await tick();
	}
}

async function setupMcp(servers: unknown = FAKE_SERVERS, pol: Record<string, string> = {}): Promise<void> {
	mcpServers = servers as any[];
	policies = { ...pol };
	fetchLog = [];
	clearToolPageState();
	doRender();
	await loadToolPageData();
	await tick();
	await collapseAll();
	expect($('[data-testid="mcp-section"]')).toBeTruthy();
}

// Fresh-page reload equivalent: the legacy spec reloaded the page (fresh module).
// clearToolPageState() is the app's reset hook; re-loading data re-fetches the
// server/policy state exactly as a real mount would.
async function reloadWithMcp(servers: unknown = FAKE_SERVERS, pol: Record<string, string> = {}): Promise<void> {
	await setupMcp(servers, pol);
}

beforeEach(() => {
	const div = document.createElement("div");
	div.id = "container";
	document.body.appendChild(div);
	installFetch();
	setRenderApp(doRender);
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	mcpServers = [];
	policies = {};
	fetchLog = [];
});

describe("Tools page → MCP section", () => {
	it("renders flat servers, expands operations, and resets expansion on reload", async () => {
		await setupMcp();

		const section = $('[data-testid="mcp-section"]')!;
		expect(text(section)).toContain("MCP");
		expect(text(section)).toContain("2 servers");
		expect($$('[data-testid="mcp-server-row"]').length).toBe(2);

		let halo = $('[data-server-name="halo"]')!;
		expect(text($('[data-testid="mcp-server-status"]', halo))).toBe("connected");
		expect(text(halo)).toContain("2 operations");
		expect($$('[data-testid="mcp-server-ops"]', halo).length).toBe(0);

		const broken = $('[data-server-name="broken"]')!;
		expect(text($('[data-testid="mcp-server-status"]', broken))).toBe("error");
		expect(text($('[data-testid="mcp-server-error"]', broken))).toContain("stdio transport: ENOENT spawn");

		$('[data-testid="mcp-server-toggle"]', halo)!.click();
		await tick();
		halo = $('[data-server-name="halo"]')!;
		const toolRows = $$('[data-testid="mcp-tool-row"]', halo);
		expect(toolRows.length).toBe(1);
		expect(toolRows[0].getAttribute("data-tool-name")).toBe("halo");

		$('[data-testid="mcp-tool-toggle"]', toolRows[0])!.click();
		await tick();
		halo = $('[data-server-name="halo"]')!;
		let ops = $('[data-testid="mcp-server-ops"]', halo);
		expect(ops).toBeTruthy();
		expect(text(ops)).toContain("mcp__halo__get-direct-reports");
		expect(text(ops)).toContain("mcp__halo__list-employees");

		$('[data-testid="mcp-tool-toggle"]', $('[data-testid="mcp-tool-row"]', halo)!)!.click();
		await tick();
		halo = $('[data-server-name="halo"]')!;
		expect($$('[data-testid="mcp-server-ops"]', halo).length).toBe(0);

		$('[data-testid="mcp-tool-toggle"]', $('[data-testid="mcp-tool-row"]', halo)!)!.click();
		await tick();
		halo = $('[data-server-name="halo"]')!;
		expect($('[data-testid="mcp-server-ops"]', halo)).toBeTruthy();

		await reloadWithMcp();
		halo = $('[data-server-name="halo"]')!;
		expect($$('[data-testid="mcp-server-ops"]', halo).length).toBe(0);
	});

	it("groups gateway sub-namespaces and flat servers", async () => {
		await setupMcp(GATEWAY_SERVERS);

		let gr = $('[data-server-name="gr"]')!;
		expect(gr).toBeTruthy();
		$('[data-testid="mcp-server-toggle"]', gr)!.click();
		await tick();
		gr = $('[data-server-name="gr"]')!;

		const toolRows = $$('[data-testid="mcp-tool-row"]', gr);
		expect(toolRows.length).toBe(2);
		expect($$('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"]', gr).length).toBe(1);
		expect($$('[data-testid="mcp-tool-row"][data-tool-name="jira"]', gr).length).toBe(1);

		let pw = $('[data-server-name="playwright"]')!;
		$('[data-testid="mcp-server-toggle"]', pw)!.click();
		await tick();
		pw = $('[data-server-name="playwright"]')!;
		const pwRows = $$('[data-testid="mcp-tool-row"]', pw);
		expect(pwRows.length).toBe(1);
		expect(pwRows[0].getAttribute("data-tool-name")).toBe("playwright");
	});

	it("writes server and tool policy updates", async () => {
		await setupMcp(GATEWAY_SERVERS);

		let gr = $('[data-server-name="gr"]')!;
		selectOption($('[data-testid="mcp-server-policy"]', gr) as HTMLSelectElement, "never");
		await tick();
		expect(fetchLog.filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr",
			method: "PUT",
			body: { policy: "never", projectId: "headquarters" },
		});

		gr = $('[data-server-name="gr"]')!;
		$('[data-testid="mcp-server-toggle"]', gr)!.click();
		await tick();
		gr = $('[data-server-name="gr"]')!;
		const aiTool = $('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"]', gr)!;
		selectOption($('[data-testid="mcp-tool-policy"]', aiTool) as HTMLSelectElement, "ask");
		await tick();
		expect(fetchLog.filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr__ai-adoption",
			method: "PUT",
			body: { policy: "ask", projectId: "headquarters" },
		});
	});

	it("uses supplied public MCP policy keys when gateway runtime names differ", async () => {
		await setupMcp([{
			name: "gateway_gr_jira_source_a_deadbeef",
			status: "connected",
			toolCount: 1,
			serverPolicyKey: "mcp__gr",
			policyKey: "mcp__gr",
			tools: [{
				name: "mcp__gr__jira__jira_search",
				description: "Search Jira issues.",
				subNamespace: "jira",
				op: "jira_search",
				serverPolicyKey: "mcp__gr",
				packagePolicyKey: "mcp__gr__jira",
				operationPolicyKey: "mcp__gr__jira__jira_search",
				policyKey: "mcp__gr__jira__jira_search",
			}],
		}]);

		let gateway = $('[data-server-name="gateway_gr_jira_source_a_deadbeef"]')!;
		expect(gateway.getAttribute("data-policy-key")).toBe("mcp__gr");
		$('[data-testid="mcp-server-toggle"]', gateway)!.click();
		await tick();
		gateway = $('[data-server-name="gateway_gr_jira_source_a_deadbeef"]')!;
		let jiraTool = $('[data-testid="mcp-tool-row"][data-tool-name="jira"]', gateway)!;
		selectOption($('[data-testid="mcp-server-policy"]', gateway) as HTMLSelectElement, "never");
		await tick();
		expect(fetchLog.filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr",
			method: "PUT",
			body: { policy: "never", projectId: "headquarters" },
		});

		gateway = $('[data-server-name="gateway_gr_jira_source_a_deadbeef"]')!;
		jiraTool = $('[data-testid="mcp-tool-row"][data-tool-name="jira"]', gateway)!;
		expect(jiraTool.getAttribute("data-policy-key")).toBe("mcp__gr__jira");
		selectOption($('[data-testid="mcp-tool-policy"]', jiraTool) as HTMLSelectElement, "ask");
		await tick();
		expect(fetchLog.filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr__jira",
			method: "PUT",
			body: { policy: "ask", projectId: "headquarters" },
		});

		gateway = $('[data-server-name="gateway_gr_jira_source_a_deadbeef"]')!;
		jiraTool = $('[data-testid="mcp-tool-row"][data-tool-name="jira"]', gateway)!;
		$('[data-testid="mcp-tool-toggle"]', jiraTool)!.click();
		await tick();
		gateway = $('[data-server-name="gateway_gr_jira_source_a_deadbeef"]')!;
		const op = $('[data-testid="mcp-operation-row"][data-tool-name="mcp__gr__jira__jira_search"]', gateway)!;
		expect(op.getAttribute("data-policy-key")).toBe("mcp__gr__jira__jira_search");
	});

	it("shows inherited parent MCP policy for unset sub-namespace rows without storing override", async () => {
		await setupMcp(GATEWAY_SERVERS, { "mcp__gr": "never" });

		let gr = $('[data-server-name="gr"]')!;
		expect(($('[data-testid="mcp-server-policy"]', gr) as HTMLSelectElement).value).toBe("never");
		$('[data-testid="mcp-server-toggle"]', gr)!.click();
		await tick();
		gr = $('[data-server-name="gr"]')!;

		let jiraPolicy = $('[data-testid="mcp-tool-row"][data-tool-name="jira"] [data-testid="mcp-tool-policy"]', gr) as HTMLSelectElement;
		expect(jiraPolicy.value).toBe("");
		expect(selectedText(jiraPolicy)).toMatch(/Never.*inherited/i);

		selectOption(jiraPolicy, "ask");
		await tick();
		expect(fetchLog.filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr__jira",
			method: "PUT",
			body: { policy: "ask", projectId: "headquarters" },
		});
		gr = $('[data-server-name="gr"]')!;
		jiraPolicy = $('[data-testid="mcp-tool-row"][data-tool-name="jira"] [data-testid="mcp-tool-policy"]', gr) as HTMLSelectElement;
		expect(jiraPolicy.value).toBe("ask");
		expect(selectedText(jiraPolicy)).toBe("Ask");

		selectOption(jiraPolicy, "");
		await tick();
		expect(fetchLog.filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr__jira",
			method: "PUT",
			body: { policy: null, projectId: "headquarters" },
		});
		gr = $('[data-server-name="gr"]')!;
		jiraPolicy = $('[data-testid="mcp-tool-row"][data-tool-name="jira"] [data-testid="mcp-tool-policy"]', gr) as HTMLSelectElement;
		expect(jiraPolicy.value).toBe("");
		expect(selectedText(jiraPolicy)).toMatch(/Never.*inherited/i);

		await reloadWithMcp(GATEWAY_SERVERS, { "mcp__gr": "never" });
		let reloadedGr = $('[data-server-name="gr"]')!;
		$('[data-testid="mcp-server-toggle"]', reloadedGr)!.click();
		await tick();
		reloadedGr = $('[data-server-name="gr"]')!;
		const reloadedJira = $('[data-testid="mcp-tool-row"][data-tool-name="jira"] [data-testid="mcp-tool-policy"]', reloadedGr) as HTMLSelectElement;
		expect(reloadedJira.value).toBe("");
		expect(selectedText(reloadedJira)).toMatch(/Never.*inherited/i);

		let playwright = $('[data-server-name="playwright"]')!;
		$('[data-testid="mcp-server-toggle"]', playwright)!.click();
		await tick();
		playwright = $('[data-server-name="playwright"]')!;
		const flatPolicy = $('[data-testid="mcp-tool-row"][data-tool-name="playwright"] [data-testid="mcp-tool-policy"]', playwright) as HTMLSelectElement;
		expect(flatPolicy.value).toBe("");
		expect(selectedText(flatPolicy)).toBe("Allow (default)");
	});

	it("loads default and persisted policies, and reset persists empty", async () => {
		await setupMcp(GATEWAY_SERVERS);
		let gr = $('[data-server-name="gr"]')!;
		expect(($('[data-testid="mcp-server-policy"]', gr) as HTMLSelectElement).value).toBe("");
		$('[data-testid="mcp-server-toggle"]', gr)!.click();
		await tick();
		gr = $('[data-server-name="gr"]')!;
		expect(($('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"] [data-testid="mcp-tool-policy"]', gr) as HTMLSelectElement).value).toBe("");

		await reloadWithMcp(GATEWAY_SERVERS, { "mcp__gr__ai-adoption": "ask", "mcp__gr": "never" });
		gr = $('[data-server-name="gr"]')!;
		expect(($('[data-testid="mcp-server-policy"]', gr) as HTMLSelectElement).value).toBe("never");
		$('[data-testid="mcp-server-toggle"]', gr)!.click();
		await tick();
		gr = $('[data-server-name="gr"]')!;
		expect(($('[data-testid="mcp-tool-row"][data-tool-name="ai-adoption"] [data-testid="mcp-tool-policy"]', gr) as HTMLSelectElement).value).toBe("ask");

		const serverSelect = $('[data-testid="mcp-server-policy"]', gr) as HTMLSelectElement;
		selectOption(serverSelect, "");
		await tick();
		expect(fetchLog.filter(e => e.method === "PUT").at(-1)).toEqual({
			url: "/api/tool-group-policies/mcp__gr",
			method: "PUT",
			body: { policy: null, projectId: "headquarters" },
		});
		expect(($('[data-testid="mcp-server-policy"]', $('[data-server-name="gr"]')!) as HTMLSelectElement).value).toBe("");

		await reloadWithMcp(GATEWAY_SERVERS);
		expect(($('[data-server-name="gr"] [data-testid="mcp-server-policy"]') as HTMLSelectElement).value).toBe("");
	});
});
