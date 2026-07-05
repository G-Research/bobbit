/**
 * Shared fork-scoped runtime state for the v2-integration compat shims.
 *
 * Both in-process-harness.ts (the Playwright-flavoured `test`) and e2e-setup.ts
 * (the REST/WS helpers) must observe the SAME booted gateway + the SAME
 * per-test scope, otherwise a spec that mixes the compat `test` wrapper with a
 * locally-defined `apiFetch`/`base()` would see an unbooted gateway. Keeping the
 * state in one module guarantees a single source of truth per fork.
 */
import { getGateway, type GatewayFixture } from "../../harness/gateway.js";
import type { TestScope } from "../../harness/scope.js";

let _gw: GatewayFixture | undefined;
let _scope: TestScope | undefined;

export async function ensureGateway(): Promise<GatewayFixture> {
	_gw = await getGateway();
	return _gw;
}

export function gatewaySync(): GatewayFixture {
	if (!_gw) throw new Error("[tests2/e2e-compat] gateway not booted — call helpers from within the compat `test`/hooks (they await getGateway first)");
	return _gw;
}

export function setScope(scope: TestScope | undefined): void { _scope = scope; }
export function currentScope(): TestScope | undefined { return _scope; }
