import type { SessionManager } from "./agent/session-manager.js";
import type { TeamManager } from "./agent/team-manager.js";
import type { GateStore } from "./agent/gate-store.js";
import type { RoleManager } from "./agent/role-manager.js";
import type { ToolManager } from "./agent/tool-manager.js";
import type { ColorStore } from "./agent/color-store.js";
import type { PrStatusStore } from "./agent/pr-status-store.js";
import type { PersonalityManager } from "./agent/personality-manager.js";
import type { BgProcessManager } from "./agent/bg-process-manager.js";
import type { StaffManager } from "./agent/staff-manager.js";
import type { WorkflowManager } from "./agent/workflow-manager.js";
import type { VerificationHarness } from "./agent/verification-harness.js";
import type { PreferencesStore } from "./agent/preferences-store.js";
import type { ProjectConfigStore } from "./agent/project-config-store.js";

export interface TlsConfig {
	cert: string;   // path to PEM certificate
	key: string;    // path to PEM private key
	caCert?: string; // path to CA certificate (for mkcert-based certs)
}

export interface GatewayConfig {
	host: string;
	port: number;
	portExplicit?: boolean;
	authToken: string;
	defaultCwd: string;
	staticDir?: string;
	agentCliPath?: string;
	systemPromptPath?: string;
	tls?: TlsConfig;
	/** Force auth even on localhost (used by E2E tests). */
	forceAuth?: boolean;
}

export interface AppContext {
	config: GatewayConfig;
	sessionManager: SessionManager;
	teamManager: TeamManager;
	gateStore: GateStore;
	roleManager: RoleManager;
	toolManager: ToolManager;
	colorStore: ColorStore;
	prStatusStore: PrStatusStore;
	personalityManager: PersonalityManager;
	bgProcessManager: BgProcessManager;
	staffManager: StaffManager;
	workflowManager: WorkflowManager;
	verificationHarness: VerificationHarness;
	preferencesStore: PreferencesStore;
	projectConfigStore: ProjectConfigStore;
	broadcastToGoal: (goalId: string, event: Record<string, unknown>) => void;
	broadcastToAll: (event: Record<string, unknown>) => void;
}
