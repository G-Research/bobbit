// src/server/routes/core-route-ctx.ts
//
// STR-01: the shared per-request context handed to every core (non-pack)
// registry-migrated route handler. See docs/design/route-registry.md.
//
// Deliberately data-only (no imports back from server.ts — see that doc's
// "avoiding the server.ts import cycle" section): every field is either a
// leaf-module type or a plain function reference built fresh inside
// `handleApiRoute` for each request from state it already has in scope
// (mirrors the existing delegate-route-module pattern in
// e.g. src/server/agent/nested-goal-routes.ts's `NestedGoalRouteDeps`).
//
// Grow this interface as later cohorts need more; cohort 1 (projects) only
// needed the fields below.

import type http from "node:http";
import type { SessionManager } from "../agent/session-manager.js";
import type { ProjectRegistry, RegisteredProject } from "../agent/project-registry.js";
import type { ProjectContextManager } from "../agent/project-context-manager.js";
import type { ProjectContext } from "../agent/project-context.js";

export interface CoreRouteCtx {
	req: http.IncomingMessage;
	res: http.ServerResponse;
	url: URL;

	/** Per-request response helpers (bound to `res`; identical to the legacy inline closures). */
	json(data: unknown, status?: number): void;
	jsonError(status: number, err: unknown, extra?: Record<string, unknown>): void;
	readBody(req: http.IncomingMessage): Promise<any>;

	sessionManager: SessionManager;
	projectRegistry: ProjectRegistry;
	projectContextManager: ProjectContextManager;
	broadcastToAll(event: unknown): void;

	// Small per-request closures already defined once in handleApiRoute and
	// shared with not-yet-migrated legacy routes — passed through by
	// reference rather than duplicated or imported back from server.ts.
	isHeadquartersOwnedPath(candidatePath: string): boolean;
	listProjectsForApi(): RegisteredProject[];
	writeSpecialProjectMutationError(err: unknown): boolean;
	headquartersProject(): RegisteredProject | undefined;

	// Pure module-level helpers in server.ts that are ALSO still called by
	// not-yet-migrated legacy routes (so they stay defined once, in
	// server.ts, and are threaded through here rather than moved — moving
	// them would force a choice between duplicating them or importing this
	// module's route file back into server.ts, both worse than passing the
	// function reference through ctx).
	wireGoalManagerResolvers(
		ctx: ProjectContext,
		deps: { sessionManager: SessionManager; projectContextManager: ProjectContextManager; projectRegistry: ProjectRegistry },
	): void;
	validateComponentsConfig(components: unknown): string | null;
	isValidBaseRefBranchGrammar(name: string): boolean;
	detectedRefExistsInAllComponents(rootPath: string, comps: Array<{ repo: string }>, ref: string): Promise<boolean>;
}
