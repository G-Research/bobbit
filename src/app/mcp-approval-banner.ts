import { html, nothing, type TemplateResult } from "lit";
import { fetchMcpServers } from "./api.js";
import { setConfigScope } from "./config-scope.js";
import { getRouteFromHash, setHashRoute, type AppRoute } from "./routing.js";
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

const reviewCountByProject = new Map<string, number>();
const countRequestByProject = new Map<string, Promise<void>>();
const countRevisionByProject = new Map<string, number>();
let toolsRevalidationTimer: ReturnType<typeof setTimeout> | undefined;
let toolsRevalidationProjectId: string | undefined;

function sessionProjectId(sessionId: string | undefined, source: McpApprovalBannerState): string | undefined {
	if (!sessionId) return undefined;
	return source.gatewaySessions.find((session) => session.id === sessionId)?.projectId
		?? source.archivedSessions.find((session) => session.id === sessionId)?.projectId;
}

/** Resolve the project represented by the current surface without inferring it from cwd. */
export function resolveMcpApprovalBannerProjectId(
	route: AppRoute,
	source: McpApprovalBannerState = state,
): string | undefined {
	if (route.view === "session") {
		const routeProjectId = sessionProjectId(route.sessionId, source);
		if (routeProjectId) return routeProjectId;
	}
	if (route.view === "goal-dashboard") {
		const routeProjectId = source.goals.find((goal) => goal.id === route.goalId)?.projectId;
		if (routeProjectId) return routeProjectId;
	}

	const activeSessionProjectId = sessionProjectId(source.selectedSessionId ?? undefined, source)
		?? sessionProjectId(source.remoteAgent?.gatewaySessionId, source);
	if (activeSessionProjectId) return activeSessionProjectId;

	const activeGoalProjectId = source.goals.find((goal) => goal.id === source.goalDashboardId)?.projectId;
	return activeGoalProjectId ?? source.activeProjectId ?? undefined;
}

function scheduleToolsRevalidation(projectId: string, route: AppRoute): void {
	if (route.view !== "tools" || toolsRevalidationTimer && toolsRevalidationProjectId === projectId) return;
	if (toolsRevalidationTimer) clearTimeout(toolsRevalidationTimer);
	toolsRevalidationProjectId = projectId;
	toolsRevalidationTimer = setTimeout(() => {
		toolsRevalidationTimer = undefined;
		toolsRevalidationProjectId = undefined;
		const currentRoute = getRouteFromHash();
		if (currentRoute.view !== "tools" || resolveMcpApprovalBannerProjectId(currentRoute) !== projectId) return;
		reviewCountByProject.delete(projectId);
		countRequestByProject.delete(projectId);
		countRevisionByProject.set(projectId, (countRevisionByProject.get(projectId) ?? 0) + 1);
		renderApp();
	}, 2_000);
}

function ensureReviewCount(projectId: string): void {
	if (reviewCountByProject.has(projectId) || countRequestByProject.has(projectId)) return;
	const revision = countRevisionByProject.get(projectId) ?? 0;
	let request: Promise<void>;
	request = fetchMcpServers({ projectId, ensure: true })
		.then((servers) => {
			if ((countRevisionByProject.get(projectId) ?? 0) !== revision) return;
			const count = servers.filter((server) =>
				server.approval?.state === "pending" || server.approval?.state === "changed"
			).length;
			reviewCountByProject.set(projectId, count);
			renderApp();
		})
		.finally(() => {
			if (countRequestByProject.get(projectId) === request) countRequestByProject.delete(projectId);
		});
	countRequestByProject.set(projectId, request);
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

async function reviewProjectServers(projectId: string): Promise<void> {
	setConfigScope(projectId);
	const alreadyOnTools = getRouteFromHash().view === "tools";
	setHashRoute("tools");
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
	const affected = ids?.length ? [...new Set(ids)] : [...new Set([
		...reviewCountByProject.keys(),
		...countRequestByProject.keys(),
	])];
	for (const projectId of affected) {
		reviewCountByProject.delete(projectId);
		countRequestByProject.delete(projectId);
		countRevisionByProject.set(projectId, (countRevisionByProject.get(projectId) ?? 0) + 1);
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
	const projectId = resolveMcpApprovalBannerProjectId(route);
	if (!projectId) return nothing;
	ensureReviewCount(projectId);
	const count = reviewCountByProject.get(projectId) ?? 0;
	if (count === 0) return nothing;
	// The Tools route intentionally has no active session socket. Revalidate its
	// compact count while review is outstanding; the normal WS invalidation is
	// still the immediate path everywhere an active session exists.
	scheduleToolsRevalidation(projectId, route);
	const projectName = state.projects.find((project) => project.id === projectId)?.name ?? "this project";
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
				@click=${() => { void reviewProjectServers(projectId); }}
			>Review servers</button>
		</div>
	`;
}
