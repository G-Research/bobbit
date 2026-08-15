/** Generic lifecycle provider facade for declarative graph status.
 *
 * Until EP-8 supplies a service lifecycle owner, these hooks return without
 * scheduling, spawning, or otherwise starting Graphify work.
 */
import { GraphRuntime, getGraphRuntime, type GraphContextBlock, type GraphHookResult, type GraphRuntimeFacade, type GraphRuntimeFacadeContext } from "./graph-runtime.js";

export interface GraphProviderContext extends GraphRuntimeFacadeContext {
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
	// `scopeContext` is injected by LifecycleHub's server-owned resolver. The
	// facade rejects legacy component fields and absent verified scope/identity.
	return context?.graphRuntime ?? context?.host?.graphRuntime ?? getGraphRuntime(context);
}

/** Default module contribution. Pack-level defaultDisabled activation omits this
 * provider entirely until opted in. Hooks use the host-only status facade and no
 * hook receives a graph path or starts a rebuild. */
const provider: GraphProvider = {
	goalProvisioned: async context => runtimeFrom(context).goalProvisioned(context),
	sessionSetup: async context => runtimeFrom(context).sessionSetup(context),
	afterTurn: async context => runtimeFrom(context).afterTurn(context),
};

export type { GraphContextBlock };
export default provider;
