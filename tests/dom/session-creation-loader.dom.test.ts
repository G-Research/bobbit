import { beforeAll as syncBeforeAll } from "vitest";
import { syncCustomElements } from "../support/helpers/dom/setup/custom-elements.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

syncBeforeAll(() => syncCustomElements());

type StateModule = typeof import("../../src/app/state.js");
type RenderModule = typeof import("../../src/app/render.js");

let state: StateModule["state"];
let setRenderApp: StateModule["setRenderApp"];
let doRenderApp: RenderModule["doRenderApp"];
let createAndConnectSession: typeof import("../../src/app/session-manager.js")["createAndConnectSession"];

syncBeforeAll(async () => {
	(window as any).happyDOM?.setURL?.("http://localhost/#/settings/system/general");
	localStorage.setItem("gateway.url", "http://localhost");
	const sessionModule = await import("../../src/app/session-manager.js");
	createAndConnectSession = sessionModule.createAndConnectSession;
	const stateModule = await import("../../src/app/state.js");
	const renderModule = await import("../../src/app/render.js");
	state = stateModule.state;
	setRenderApp = stateModule.setRenderApp;
	doRenderApp = renderModule.doRenderApp;
	syncCustomElements();
});

beforeEach(() => {
	vi.stubGlobal("fetch", async () => new Response("{}", {
		status: 200,
		headers: { "Content-Type": "application/json" },
	}));
	document.body.innerHTML = '<div id="app"></div>';
	Object.assign(state, {
		appView: "authenticated",
		creatingSession: false,
		connectingSessionId: null,
		selectedSessionId: null,
		remoteAgent: null,
		chatPanel: null,
		gatewaySessions: [],
		archivedSessions: [],
		goals: [],
	});
	setRenderApp(() => {});
});

afterEach(() => {
	setRenderApp(() => {});
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("session creation loader", () => {
	it("gates every non-session route while session creation is pending", () => {
		state.creatingSession = true;
		for (const hash of ["#/settings/system/general", "#/market", "#/roles"]) {
			window.location.hash = hash;
			doRenderApp();
			expect(document.querySelector('[data-testid="bobbit-loader"]'), hash).not.toBeNull();
		}

		window.location.hash = "#/";
		state.creatingSession = false;
		doRenderApp();
		expect(document.querySelector('[data-testid="bobbit-loader"]')).toBeNull();
	});

	it("commits the loader before the create-session request settles", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input).includes("/api/sessions")) {
				await held;
				return new Response(JSON.stringify({ error: "intentional test failure" }), {
					status: 500,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});
		setRenderApp(doRenderApp);
		const pending = createAndConnectSession(undefined, undefined, undefined, false, false, "project-1");

		await vi.waitFor(() => expect(state.creatingSession).toBe(true));
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		expect(document.querySelector('[data-testid="bobbit-loader"]')).not.toBeNull();

		release();
		await pending;
		expect(state.creatingSession).toBe(false);
	});
});
