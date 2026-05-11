import type { VerifyHandler, VerifyHandlerRegistry } from "../agent/verify-handlers/registry.js";

/**
 * `BobbitPluginApi` is the surface a plugin's gateway entry receives via
 * `activate(api)`. v1 is deliberately minimal: register verify-step handlers
 * and log. Host services (sessionManager, gateStore, projectContextManager)
 * are already plumbed into handlers through `VerifyExecCtx`; the plugin API
 * only needs to expose registration hooks.
 *
 * Plugins may return a `PluginActivation` from `activate` with a
 * `deactivate()` cleanup. Deactivation is best-effort — called on uninstall
 * or gateway shutdown — and must not throw.
 */
export interface BobbitPluginApi {
	readonly pluginName: string;
	registerVerifyHandler(handler: VerifyHandler): void;
	unregisterVerifyHandler(type: string): void;
	log(level: "info" | "warn" | "error", msg: string): void;
}

export interface PluginActivation {
	deactivate?(): void | Promise<void>;
}

export type PluginActivateFn = (api: BobbitPluginApi) => void | PluginActivation | Promise<void | PluginActivation>;

/** Build the api object for a single plugin, scoped so unregister can only touch this plugin's types. */
export function buildHostApi(args: {
	pluginName: string;
	registry: VerifyHandlerRegistry;
	logger: (level: "info" | "warn" | "error", msg: string) => void;
}): { api: BobbitPluginApi; registeredTypes: () => string[] } {
	const registered = new Set<string>();
	const api: BobbitPluginApi = {
		pluginName: args.pluginName,
		registerVerifyHandler(handler) {
			args.registry.register(handler);
			registered.add(handler.type);
			args.logger("info", `registered verify handler '${handler.type}'`);
		},
		unregisterVerifyHandler(type) {
			if (!registered.has(type)) {
				args.logger("warn", `attempted to unregister '${type}' but plugin did not register it`);
				return;
			}
			args.registry.unregister(type);
			registered.delete(type);
		},
		log: args.logger,
	};
	return { api, registeredTypes: () => [...registered] };
}
