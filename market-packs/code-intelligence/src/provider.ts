/** Generic lifecycle provider facade for the graph scheduler.
 *
 * The platform invokes this module on the host worker. It accepts only the
 * existing lifecycle context and delegates all graph-specific work through a
 * GraphRuntime port; it never exposes graph paths or mounts artifacts.
 */
import { GraphRuntime, getGraphRuntime, type GraphContextBlock, type GraphHookResult, type GraphRuntimeFacade, type GraphRuntimeFacadeContext } from "./graph-runtime.js";

export interface GraphProviderContext extends GraphRuntimeFacadeContext {
	worktreeId?: string;
	component?: string;
	/** Test seam only. Production resolves getGraphRuntime from server-derived context. */
	graphRuntime?: GraphProviderRuntime;
	host?: { graphRuntime?: GraphProviderRuntime };
}

type GraphProviderRuntime = Pick<GraphRuntime<GraphProviderContext>, "goalProvisioned" | "sessionSetup" | "afterTurn"> | GraphRuntimeFacade;

export interface GraphProvider {
	goalProvisioned(context: GraphProviderContext): Promise<GraphHookResult>;
	sessionSetup(context: GraphProviderContext): Promise<GraphHookResult>;
	afterTurn(context: GraphProviderContext): Promise<GraphHookResult>;
}

/** Construct a provider with a host-owned runtime. Exported for isolated tests
 * and for the pack route/bootstrap module, which owns the real port wiring. */
export function createGraphProvider(runtime: GraphProviderRuntime): GraphProvider {
	return {
		goalProvisioned: context => runtime.goalProvisioned(context),
		sessionSetup: context => runtime.sessionSetup(context),
		afterTurn: context => runtime.afterTurn(context),
	};
}

function runtimeFrom(context: GraphProviderContext): GraphProviderRuntime {
	return context?.graphRuntime ?? context?.host?.graphRuntime ?? getGraphRuntime(context);
}

/** Default module contribution. Pack-level defaultDisabled activation omits this
 * provider entirely until opted in. Once active, all hooks use the same host-only
 * runtime facade as routes and tools; no hook receives a graph path. */
const provider: GraphProvider = {
	goalProvisioned: async context => runtimeFrom(context).goalProvisioned(context),
	sessionSetup: async context => runtimeFrom(context).sessionSetup(context),
	afterTurn: async context => runtimeFrom(context).afterTurn(context),
};

export type { GraphContextBlock };
export default provider;
