/**
 * Shared fixture setup for v2 browser smoke journeys.
 *
 * Re-exports the gateway harness test extension and common helpers
 * so journey files have a single import point.
 *
 * Support imports remain centralized here so journeys have one fixture entry.
 */
export { test, expect } from "../../../harnesses/browser/gateway-harness.js";
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
} from "../../../harnesses/browser/e2e-setup.js";
export {
	openApp,
	navigateToHash,
	sendMessage,
	waitForAgentResponse,
	createSessionViaUI,
} from "../fixtures/ui-helpers.js";
