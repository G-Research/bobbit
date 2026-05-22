import "../../src/ui/components/AgentInterface.js";
import { setRenderApp, state } from "../../src/app/state.js";

type FetchLogEntry = { url: string; method: string; body: unknown };

let proposalTypes: string[] = [];
let continueId = "continued-session-id";
let fetchLog: FetchLogEntry[] = [];

localStorage.setItem("gateway.url", "http://fixture.test");
localStorage.setItem("gateway.token", "fixture-token");

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
	const method = (init?.method || "GET").toUpperCase();
	fetchLog.push({ url, method, body: parseBody(init) });

	if (url === "/api/preferences") return response({});
	if (url === "/api/cloud-providers/status") {
		return response({
			mode: "direct-cloud",
			aigwConfigured: false,
			authGateRequired: false,
			providers: [
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
			],
		});
	}
	if (/^\/api\/sessions\/[^/]+\/proposals$/.test(url)) {
		return response({ proposals: proposalTypes.map((proposalType) => ({ proposalType })) });
	}
	if (/^\/api\/sessions\/[^/]+\/continue$/.test(url) && method === "POST") {
		return response({ id: continueId, title: "Continued: Archived fixture", status: "idle" }, 201);
	}
	return response({});
}) as typeof window.fetch;

setRenderApp(() => {});

function makeSession(id: string, modelId: string): any {
	return {
		sessionId: id,
		title: "Archived fixture",
		streamFn: undefined,
		state: {
			messages: [],
			tools: [],
			pendingToolCalls: new Set<string>(),
			isStreaming: false,
			streamingMessage: null,
			model: { provider: "anthropic", id: modelId, contextWindow: 200_000 },
			thinkingLevel: "off",
			serverCost: { totalCost: 0 },
		},
		subscribe: () => () => {},
		abort: () => {},
	};
}

(window as any).__renderArchivedFixture = async (opts: {
	sessionId?: string;
	proposalTypes?: string[];
	continueId?: string;
	modelId?: string;
	projectId?: string | null;
	knownProject?: boolean;
	goalId?: string;
	delegateOf?: string;
	teamGoalId?: string;
	assistantType?: string;
}) => {
	proposalTypes = opts.proposalTypes || [];
	continueId = opts.continueId || "continued-session-id";
	fetchLog = [];
	document.body.querySelectorAll("continue-session-chooser,[data-continue-error]").forEach((el) => el.remove());
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	app.innerHTML = "";

	const projectId = opts.projectId === null ? undefined : (opts.projectId || "fixture-project");
	state.projects = opts.knownProject === false || !projectId
		? []
		: [{ id: projectId, name: "Fixture Project", rootPath: "/tmp/fixture-project" } as any];

	const el = document.createElement("agent-interface") as any;
	el.session = makeSession(opts.sessionId || "archived-session-id", opts.modelId || "claude-sonnet-4-20250514");
	el.readOnly = true;
	el.projectId = projectId;
	el.goalId = opts.goalId || "";
	el.delegateOf = opts.delegateOf || "";
	el.teamGoalId = opts.teamGoalId || "";
	el.assistantType = opts.assistantType || "";
	el.cwd = "/tmp/fixture-project";
	el.gitRepoKnown = "no";
	el.enableAttachments = false;
	el.enableThinkingSelector = false;
	app.appendChild(el);
	await el.updateComplete;
};

(window as any).__getArchivedFetchLog = () => fetchLog.slice();
(window as any).__archiveFixtureReady = true;
