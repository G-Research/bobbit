/**
 * Shared fixture setup for v2 browser smoke journeys.
 *
 * Re-exports the gateway harness test extension and common helpers
 * so journey files have a single import point.
 *
 * Import paths are relative to tests2/browser/_helpers/ :
 *   "../gateway-harness.js" → tests2/browser/gateway-harness.ts (shim)
 *   "../e2e-setup.js"       → tests2/browser/e2e-setup.ts (shim)
 *   "../fixtures/ui-helpers.js" → tests2/browser/fixtures/ui-helpers.ts (shim)
 */
export { test, expect } from "../gateway-harness.js";
export {
	apiFetch,
	createSession,
	deleteSession,
	createGoal,
	deleteGoal,
	waitForSessionStatus,
	defaultProject,
	defaultProjectId,
	waitForHealth,
	registerProject,
} from "../e2e-setup.js";
export {
	openApp,
	navigateToHash,
	sendMessage,
	waitForAgentResponse,
	createSessionViaUI,
} from "../fixtures/ui-helpers.js";
