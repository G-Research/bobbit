/** Shared real-fidelity browser fixture surface. */
export { test, expect } from "../../_helpers/gateway-harness.js";
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
} from "../../_helpers/e2e-setup.js";
export {
	openApp,
	navigateToHash,
	sendMessage,
	waitForAgentResponse,
	createSessionViaUI,
} from "./ui-helpers.js";
