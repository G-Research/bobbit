/**
 * Shared fixture setup for v2 browser smoke journeys.
 *
 * Re-exports the gateway harness test extension and common helpers
 * so journey files have a single import point.
 *
 * Helpers are lane-local under tests/browser/_helpers/.
 */
export { test, expect } from "./gateway-harness.js";
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
} from "./e2e-setup.js";
export {
	openApp,
	navigateToHash,
	sendMessage,
	waitForAgentResponse,
	createSessionViaUI,
} from "../fixtures/ui-helpers.js";
