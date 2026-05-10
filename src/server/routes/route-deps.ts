/**
 * RouteDeps — the bag of server singletons every route handler may need.
 * Constructed once in createGateway() and passed by reference into the
 * dispatcher.
 */
import type { GatewayConfig } from "../server.js";
import type { SessionManager } from "../agent/session-manager.js";
import type { TeamManager } from "../agent/team-manager.js";
import type { RoleManager } from "../agent/role-manager.js";
import type { RoleStore } from "../agent/role-store.js";
import type { ToolManager } from "../agent/tool-manager.js";
import type { ToolGroupPolicyStore } from "../agent/tool-group-policy-store.js";
import type { PreferencesStore } from "../agent/preferences-store.js";
import type { ProjectConfigStore } from "../agent/project-config-store.js";
import type { ProjectRegistry } from "../agent/project-registry.js";
import type { ProjectContextManager } from "../agent/project-context-manager.js";
import type { ColorStore } from "../agent/color-store.js";
import type { PrStatusStore } from "../agent/pr-status-store.js";
import type { ReviewAnnotationStore } from "../review-annotation-store.js";
import type { BgProcessManager } from "../agent/bg-process-manager.js";
import type { StaffManager } from "../agent/staff-manager.js";
import type { VerificationHarness } from "../agent/verification-harness.js";
import type { SandboxManager } from "../agent/sandbox-manager.js";
import type { SandboxTokenStore } from "../auth/sandbox-token.js";
import type { ConfigCascade } from "../agent/config-cascade.js";

export interface RouteDeps {
	config: GatewayConfig;
	sessionManager: SessionManager;
	teamManager: TeamManager;
	roleManager: RoleManager;
	roleStore: RoleStore;
	toolManager: ToolManager;
	groupPolicyStore: ToolGroupPolicyStore;
	preferencesStore: PreferencesStore;
	projectConfigStore: ProjectConfigStore;
	projectRegistry: ProjectRegistry;
	projectContextManager: ProjectContextManager;
	colorStore: ColorStore;
	prStatusStore: PrStatusStore;
	reviewAnnotationStore: ReviewAnnotationStore;
	bgProcessManager: BgProcessManager;
	staffManager: StaffManager;
	verificationHarness: VerificationHarness;
	sandboxManager: SandboxManager | null;
	sandboxTokenStore: SandboxTokenStore;
	configCascade: ConfigCascade;
	// Broadcast hooks — assigned after wss is created.
	broadcastToGoal(goalId: string, event: any): void;
	broadcastToAll(event: any): void;
	broadcastToSession(sessionId: string, event: any): void;
}
