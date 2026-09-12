import { html, nothing, type TemplateResult } from "lit";
import { fetchMcpServers, type McpServerRequestScope } from "./api.js";
import { getConfigApiProjectId, setConfigScope } from "./config-scope.js";
import { getRouteFromHash, setHashRoute, setMcpReviewToolsRoute, type AppRoute } from "./routing.js";
import { renderApp, state, type GatewaySession, type Goal, type Project } from "./state.js";

interface McpApprovalBannerState {
	projects: Project[];
	gatewaySessions: GatewaySession[];
	archivedSessions: GatewaySession[];
	goals: Goal[];
	selectedSessionId: string | null;
	remoteAgent: { gatewaySessionId?: string } | null;
	goalDashboardId: string | null;
	activeProjectId: string | null;
}

export type McpApprovalReviewScope = McpServerRequestScope;

const reviewCountByScope = new Map<string, number>();
const countRequestByScope = new Map<string, Promise<void>>();
const countRevisionByScope = new Map<string, number>();
let toolsRevalidationTimer: ReturnType<typeof setTimeout> | undefined;
let toolsRevalidationScopeKey: string | undefined;

function scopeForSession(sessionId: string | undefined, source: McpApprovalBannerState): McpApprovalReviewScope | undefined {
	if (!sessionId) return undefined;
	const session = source.gatewaySessions.find((candidate) => candidate.id === sessionId)
		?? source.archivedSessions.find((candidate) => candidate.id === sessionId);
	if (!session?.projectId) return undefined;
	return { projectId: session.projectId, sessionId, ...(session.cwd ? { cwd: session.cwd } : {}) };
}

function scopeForGoal(goalId: string | undefined, source: McpApprovalBannerState): McpApprovalReviewScope | undefined {
	if (!goalId) return undefined;
	const goal = source.goals.find((candidate) => candidate.id === goalId);
	if (!goal?.projectId) return undefined;
	return { projectId: goal.projectId, goalId, ...(goal.cwd ? { cwd: goal.cwd } : {}) };
}

/** Resolve the project and optional existing session/goal cwd represented by the current surface. */
export function resolveMcpApprovalBannerScope(
	route: AppRoute,
	source: McpApprovalBannerState = state,
): McpApprovalReviewScope | undefined {
	if (route.view === "session") {
		const routeScope = scopeForSession(route.sessionId, source);
		if (routeScope) return routeScope;
	}
	if (route.view === "goal-dashboard") {
		const routeScope = scopeForGoal(route.goalId, source);
		if (routeScope) return routeScope;
	}
	if (route.view === "tools") {
		const reviewScope = scopeForSession(route.mcpReviewSessionId, source)
			?? scopeForGoal(route.mcpReviewGoalId, source);
		// Plain Tools is always the selected configuration project's root scope.
		// Only an explicit opaque owner route may retain a session/goal cwd.
		return reviewScope ?? { projectId: getConfigApiProjectId() };
	}

	const activeSessionScope = scopeForSession(source.selectedSessionId ?? undefined, source)
		?? scopeForSession(source.remoteAgent?.gatewaySessionId, source);
	if (activeSessionScope) return activeSessionScope;

	const activeGoalScope = scopeForGoal(source.goalDashboardId ?? undefined, source);
	if (activeGoalScope) return activeGoalScope;
	return source.activeProjectId ? { projectId: source.activeProjectId } : undefined;
}

/** Backwards-compatible project-only projection for existing callers/tests. */
export function resolveMcpApprovalBannerProjectId(
	route: AppRoute,
	source: McpApprovalBannerState = state,
): string | undefined {
	return resolveMcpApprovalBannerScope(route, source)?.projectId;
}

function scopeKey(scope: McpServerRequestScope): string {
	// Cwd and opaque owner are server-authored. Preserve them byte-for-byte:
	// client-side folding can conflate distinct POSIX execution directories.
	return JSON.stringify([scope.projectId, scope.cwd ?? null, scope.sessionId ?? null, scope.goalId ?? null]);
}

function scheduleToolsRevalidation(scope: McpApprovalReviewScope, route: AppRoute): void {
	const key = scopeKey(scope);
	if (route.view !== "tools" || toolsRevalidationTimer && toolsRevalidationScopeKey === key) return;
	if (toolsRevalidationTimer) clearTimeout(toolsRevalidationTimer);
	toolsRevalidationScopeKey = key;
	toolsRevalidationTimer = setTimeout(() => {
		toolsRevalidationTimer = undefined;
		toolsRevalidationScopeKey = undefined;
		const currentRoute = getRouteFromHash();
		const currentScope = resolveMcpApprovalBannerScope(currentRoute);
		if (currentRoute.view !== "tools" || !currentScope || scopeKey(currentScope) !== key) return;
		reviewCountByScope.delete(key);
		countRequestByScope.delete(key);
		countRevisionByScope.set(key, (countRevisionByScope.get(key) ?? 0) + 1);
		renderApp();
	}, 2_000);
}

function ensureReviewCount(scope: McpApprovalReviewScope): void {
	const key = scopeKey(scope);
	if (reviewCountByScope.has(key) || countRequestByScope.has(key)) return;
	const revision = countRevisionByScope.get(key) ?? 0;
	let request: Promise<void>;
	request = fetchMcpServers({ ...scope, ensure: true })
		.then((servers) => {
			if ((countRevisionByScope.get(key) ?? 0) !== revision) return;
			const count = servers.filter((server) =>
				server.approval?.state === "pending" || server.approval?.state === "changed"
			).length;
			reviewCountByScope.set(key, count);
			renderApp();
		})
		.finally(() => {
			if (countRequestByScope.get(key) === request) countRequestByScope.delete(key);
		});
	countRequestByScope.set(key, request);
}

function focusFirstReviewRow(): void {
	let observer: MutationObserver | undefined;
	let attempts = 0;
	const reveal = (): boolean => {
		const status = document.querySelector<HTMLElement>(
			'.mcp-approval-status--pending, .mcp-approval-status--changed',
		);
		const toggle = status?.closest<HTMLElement>('[data-testid="mcp-server-row"]')
			?.querySelector<HTMLButtonElement>('[data-testid="mcp-server-toggle"]');
		if (!toggle) return false;
		if (toggle.getAttribute("aria-expanded") !== "true") {
			toggle.click();
			return false;
		}
		toggle.focus();
		return true;
	};
	const check = () => {
		if (reveal() || ++attempts >= 120) observer?.disconnect();
	};
	observer = new MutationObserver(check);
	observer.observe(document.body, { childList: true, subtree: true });
	check();
	setTimeout(() => observer?.disconnect(), 10_000);
}

async function reviewProjectServers(scope: McpApprovalReviewScope): Promise<void> {
	setConfigScope(scope.projectId);
	const currentRoute = getRouteFromHash();
	const alreadyOnTools = currentRoute.view === "tools";
	if (scope.cwd && scope.sessionId) setMcpReviewToolsRoute({ sessionId: scope.sessionId });
	else if (scope.cwd && scope.goalId) setMcpReviewToolsRoute({ goalId: scope.goalId });
	else setHashRoute("tools");
	// A same-route hash assignment emits no navigation event, so refresh the
	// existing Tools surface directly before starting the single reveal lifecycle.
	// Normal navigation owns its load, and the observer waits for that render.
	if (alreadyOnTools) {
		const { loadToolPageData } = await import("./tool-manager-page.js");
		await loadToolPageData();
	}
	focusFirstReviewRow();
}

/** Invalidate counts after a server decision or configuration reconciliation. */
export function invalidateMcpApprovalBanner(projectIds?: readonly string[]): void {
	const ids = projectIds?.filter((id): id is string => typeof id === "string" && id.length > 0);
	const knownKeys = [...new Set([
		...reviewCountByScope.keys(),
		...countRequestByScope.keys(),
		...countRevisionByScope.keys(),
	])];
	const affected = ids?.length
		? knownKeys.filter((key) => ids.some((projectId) => key.startsWith(`${JSON.stringify([projectId]).slice(0, -1)},`)))
		: knownKeys;
	for (const key of affected) {
		reviewCountByScope.delete(key);
		countRequestByScope.delete(key);
		countRevisionByScope.set(key, (countRevisionByScope.get(key) ?? 0) + 1);
	}
	renderApp();
}

export function handleMcpApprovalsChanged(message: unknown): void {
	const event = message && typeof message === "object" ? message as Record<string, unknown> : {};
	const projectIds = [
		...(Array.isArray(event.projectIds) ? event.projectIds : []),
		...(Array.isArray(event.affectedProjectIds) ? event.affectedProjectIds : []),
		event.projectId,
		event.sourceProjectId,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	invalidateMcpApprovalBanner(projectIds.length ? projectIds : undefined);
}

export function renderMcpApprovalBanner(route: AppRoute = getRouteFromHash()): TemplateResult | typeof nothing {
	const scope = resolveMcpApprovalBannerScope(route);
	if (!scope) return nothing;
	const key = scopeKey(scope);
	ensureReviewCount(scope);
	// The Tools route intentionally has no active session socket. Revalidate its
	// compact count even when it is zero so a later configuration change can make
	// the banner appear; active session surfaces still use immediate WS invalidation.
	scheduleToolsRevalidation(scope, route);
	const count = reviewCountByScope.get(key) ?? 0;
	if (count === 0) return nothing;
	const projectName = state.projects.find((project) => project.id === scope.projectId)?.name ?? "this project";
	return html`
		<div
			class="shrink-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-xs"
			style="background:color-mix(in oklch, var(--warning) 10%, var(--background));"
			role="status"
			aria-live="polite"
			aria-atomic="true"
			data-testid="mcp-approval-banner"
		>
			<span><strong data-testid="mcp-approval-banner-count">${count}</strong> MCP server${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} review for ${projectName}.</span>
			<button
				type="button"
				class="min-h-11 shrink-0 rounded-md border border-border bg-background px-3 py-1.5 font-medium text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				data-testid="mcp-review-servers"
				@click=${() => { void reviewProjectServers(scope); }}
			>Review servers</button>
		</div>
	`;
}
