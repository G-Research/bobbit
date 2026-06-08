// Test entry — pins the Wave-9B finding #2 fix: a marketplace mutation re-drives
// pack-renderer registration scoped to the ACTIVE CHAT SESSION's project
// (extension-host §4c), NOT the marketplace's focused/active *project* used for
// the install scope segment. The GLOBAL renderer registry must follow the
// still-active session, so installing/uninstalling a project-scope pack for a
// NON-active project must not clobber the active session's renderers.
//
// We stub `window.fetch` to record /api/tools request URLs, set the app `state`
// so the active session's project differs from `state.activeProjectId`, then
// drive `reconcileRenderersForActiveSession()` and assert the fetch carried the
// SESSION's project id.
import { reconcileRenderersForActiveSession, activeSessionProjectId } from "../../src/app/marketplace-page.js";
import { state } from "../../src/app/state.js";

const fetchCalls: string[] = [];
const toolsResponse = [{ name: "demo_pack_tool", rendererKind: "pack" }];
const RENDERER_MODULE =
	"export default function(){ return { render(){ return { content: '', isCustom: false }; } }; }";

(window as any).fetch = async (input: any): Promise<Response> => {
	const url = typeof input === "string" ? input : (input && input.url) || String(input);
	fetchCalls.push(url);
	if (url.includes("/renderer")) {
		return new Response(RENDERER_MODULE, { status: 200, headers: { "Content-Type": "text/javascript" } });
	}
	return new Response(JSON.stringify({ tools: toolsResponse }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};

(window as any).__calls = (): string[] => fetchCalls.slice();
(window as any).__clearCalls = () => { fetchCalls.length = 0; };
(window as any).__activeSessionProjectId = (): string | undefined => activeSessionProjectId();
(window as any).__refresh = (): Promise<void> => reconcileRenderersForActiveSession();

/** Configure app state: the active chat session and the (distinct) active
 *  project, so a test can prove the refresh follows the SESSION, not the
 *  marketplace's focus/active project. */
(window as any).__setup = (opts: { sessionId?: string; sessionProjectId?: string; activeProjectId?: string | null }) => {
	state.selectedSessionId = opts.sessionId ?? null;
	state.remoteAgent = opts.sessionId ? ({ gatewaySessionId: opts.sessionId } as any) : null;
	state.gatewaySessions = opts.sessionId
		? ([{ id: opts.sessionId, projectId: opts.sessionProjectId }] as any)
		: ([] as any);
	state.activeProjectId = opts.activeProjectId ?? null;
};

(window as any).__ready = true;
