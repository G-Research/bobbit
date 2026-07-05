import type { GatewayDeps } from "./gateway-deps.js";

/**
 * Migration-only CLI bridge for GatewayDeps wiring.
 *
 * The DI foundation keeps production behavior unchanged: the CLI does not install
 * test doubles here. Legacy env-flag mappings may be added temporarily as the
 * individual seams are wired, then this bridge is deleted at switchover.
 */
export function resolveCliGatewayDeps(_env: NodeJS.ProcessEnv = process.env): GatewayDeps | undefined {
	return undefined;
}
