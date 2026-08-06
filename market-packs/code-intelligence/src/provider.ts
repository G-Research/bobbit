import { getGraphRuntime } from "./graph-runtime.js";

type ProviderContext = {
	projectId?: string;
	goalId?: string;
	sessionId?: string;
	config?: unknown;
	host?: unknown;
	[key: string]: unknown;
};

type ContextBlock = { id: string; title: string; authority: string; priority: number; reason: string; content: string };

/** Lifecycle adapter only. Scheduling and durable state remain inside
 * GraphRuntime; hooks never synchronously invoke Graphify or expose a path. */
async function invoke(ctx: ProviderContext, method: "sessionSetup" | "afterTurn" | "goalProvisioned"): Promise<ContextBlock[]> {
	try {
		const runtime = await getGraphRuntime(ctx);
		const result = await runtime[method](ctx);
		return Array.isArray(result?.blocks) ? result.blocks : [];
	} catch {
		// LifecycleHub treats optional providers as non-fatal. The runtime records
		// its own declared status error; never disrupt the agent turn here.
		return [];
	}
}

export default {
	async sessionSetup(ctx: ProviderContext): Promise<{ blocks: ContextBlock[] }> {
		return { blocks: await invoke(ctx, "sessionSetup") };
	},
	async afterTurn(ctx: ProviderContext): Promise<{ blocks: ContextBlock[] }> {
		return { blocks: await invoke(ctx, "afterTurn") };
	},
	async goalProvisioned(ctx: ProviderContext): Promise<{ blocks: ContextBlock[] }> {
		return { blocks: await invoke(ctx, "goalProvisioned") };
	},
};
