/** Generic lifecycle provider facade for the graph scheduler.
 *
 * The platform invokes this module on the host worker. It accepts only the
 * existing lifecycle context and delegates all graph-specific work through a
 * GraphRuntime port; it never exposes graph paths or mounts artifacts.
 */
import { GraphRuntime, type GraphContext, type GraphContextBlock, type GraphHookResult } from "./graph-runtime.js";

export interface GraphProviderContext extends GraphContext {
	worktreeId?: string;
	component?: string;
	/** Test/host injection seam. Normal callers do not control filesystem paths. */
	graphRuntime?: GraphRuntime<GraphProviderContext>;
	host?: { graphRuntime?: GraphRuntime<GraphProviderContext> };
}

export interface GraphProvider {
	goalProvisioned(context: GraphProviderContext): Promise<GraphHookResult>;
	sessionSetup(context: GraphProviderContext): Promise<GraphHookResult>;
	afterTurn(context: GraphProviderContext): Promise<GraphHookResult>;
}

/** Construct a provider with a host-owned runtime. Exported for isolated tests
 * and for the pack route/bootstrap module, which owns the real port wiring. */
export function createGraphProvider(runtime: GraphRuntime<GraphProviderContext>): GraphProvider {
	return {
		goalProvisioned: context => runtime.goalProvisioned(context),
		sessionSetup: context => runtime.sessionSetup(context),
		afterTurn: context => runtime.afterTurn(context),
	};
}

const dormantRuntime = new GraphRuntime<GraphProviderContext>({
	resolveTargets: async () => [],
	execute: async () => {},
});

function runtimeFrom(context: GraphProviderContext): GraphRuntime<GraphProviderContext> {
	return context?.graphRuntime ?? context?.host?.graphRuntime ?? dormantRuntime;
}

/** Default module contribution. A disabled provider is omitted by the existing
 * platform activation path; this defensive fallback is a no-op if host runtime
 * wiring is unavailable rather than attempting Graphify inside a hook. */
const provider: GraphProvider = {
	goalProvisioned: async context => runtimeFrom(context).goalProvisioned(context),
	sessionSetup: async context => runtimeFrom(context).sessionSetup(context),
	afterTurn: async context => runtimeFrom(context).afterTurn(context),
};

export type { GraphContextBlock };
export default provider;
