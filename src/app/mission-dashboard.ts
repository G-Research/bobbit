import { html, type TemplateResult } from "lit";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";
import {
	fetchMissionDetail,
	fetchMissionGates,
	refreshMissions,
	pauseMission,
	resumeMission,
	type GateState,
} from "./api.js";
import type { MissionDetail, PersistedMission } from "./mission-types.js";
import { MISSION_STATE_LABELS } from "./mission-types.js";
import { renderMissionDagSvg } from "../ui/components/MissionDagSvg.js";

// ============================================================================
// MODULE STATE
// ============================================================================

let currentMissionId: string | null = null;
let detail: MissionDetail | null = null;
let gates: GateState[] = [];
let loading = true;
let error = "";
let activeTab: "overview" | "plan" = "overview";
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// LIFECYCLE
// ============================================================================

export async function loadMissionDashboard(missionId: string): Promise<void> {
	currentMissionId = missionId;
	state.missionDashboardId = missionId;
	loading = true;
	error = "";
	detail = null;
	gates = [];
	renderApp();

	// Refresh mission list (best-effort) so sidebar reflects state.
	refreshMissions().catch(() => {});

	try {
		const [d, g] = await Promise.all([
			fetchMissionDetail(missionId),
			fetchMissionGates(missionId),
		]);
		if (currentMissionId !== missionId) return; // raced
		if (!d) {
			// Fall back to whatever we have in state.missions so the page can
			// still render minimal data even when the detail endpoint isn't
			// implemented yet.
			const stub = state.missions.find(m => m.id === missionId);
			if (stub) {
				detail = { mission: stub, plan: stub.plan ?? null, children: [], gates: [] };
				gates = [];
			} else {
				error = "Mission not found";
			}
		} else {
			detail = d;
			gates = g;
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		loading = false;
		renderApp();
	}

	// Periodic refresh so DAG/gates stay current. Cheap polling is fine until
	// WS event wiring lands.
	stopPolling();
	pollTimer = setInterval(() => {
		if (document.visibilityState !== "visible") return;
		if (!currentMissionId) return;
		refreshMissionData();
	}, 7_000);
}

export function clearMissionDashboardState(): void {
	currentMissionId = null;
	detail = null;
	gates = [];
	loading = true;
	error = "";
	state.missionDashboardId = null;
	stopPolling();
}

function stopPolling(): void {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export async function refreshMissionDashboard(): Promise<void> {
	await refreshMissionData();
}

async function refreshMissionData(): Promise<void> {
	if (!currentMissionId) return;
	try {
		const [d, g] = await Promise.all([
			fetchMissionDetail(currentMissionId),
			fetchMissionGates(currentMissionId),
		]);
		if (d) { detail = d; gates = g; renderApp(); }
	} catch { /* ignore */ }
}

// ============================================================================
// RENDER
// ============================================================================

export function renderMissionDashboard(): TemplateResult {
	if (loading) {
		return html`
			<div class="dashboard-container" style="flex:1;min-height:0;padding:24px;" data-testid="mission-dashboard-loading">
				<p style="color:var(--muted-foreground);">Loading mission…</p>
			</div>
		`;
	}
	if (error || !detail) {
		return html`
			<div class="dashboard-container" style="padding:24px;" data-testid="mission-dashboard-error">
				<p style="color:var(--muted-foreground);">${error || "Mission not found"}</p>
				<button class="back-btn" @click=${() => setHashRoute("landing")}>← Back to sessions</button>
			</div>
		`;
	}

	const m = detail.mission;
	return html`
		<div class="dashboard-container" data-testid="mission-dashboard" data-mission-id=${m.id}>
			${renderHeader(m)}
			${renderTabBar()}
			<div class="tab-content" style="padding:16px 20px;overflow-y:auto;flex:1;min-height:0;">
				${activeTab === "overview" ? renderOverviewTab() : renderPlanTab()}
			</div>
		</div>
	`;
}

function renderHeader(m: PersistedMission): TemplateResult {
	const stateLabel = MISSION_STATE_LABELS[m.state] ?? m.state;
	const statePillColor = stateColor(m.state);
	const isPaused = m.state === "paused";
	return html`
		<div class="nav" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);">
			<button class="back-btn" @click=${() => setHashRoute("landing")} title="Back to sessions"
				style="background:none;border:none;cursor:pointer;color:var(--muted-foreground);">←</button>
			<span style="font-size:16px;font-weight:600;" data-testid="mission-title">${m.title}</span>
			<span style="font-size:11px;padding:2px 8px;border-radius:9999px;background:${statePillColor.bg};color:${statePillColor.fg};font-weight:500;"
				data-testid="mission-state-pill">${stateLabel}</span>
			${m.integrationBranch ? html`<span style="font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono, monospace);">${m.integrationBranch}</span>` : ""}
			<span style="flex:1;"></span>
			<span style="font-size:11px;color:var(--muted-foreground);">policy: <b>${m.divergencePolicy}</b></span>
			<span style="font-size:11px;color:var(--muted-foreground);">max: <b>${m.maxConcurrentGoals}</b></span>
			${isPaused
				? html`<button class="btn-icon" @click=${() => onResume(m.id)} title="Resume mission" data-testid="mission-resume-btn">Resume</button>`
				: html`<button class="btn-icon" @click=${() => onPause(m.id)} title="Pause mission" data-testid="mission-pause-btn">Pause</button>`}
			${m.prUrl ? html`<a href=${m.prUrl} target="_blank" rel="noopener" class="btn-icon">PR</a>` : ""}
		</div>
	`;
}

function renderTabBar(): TemplateResult {
	return html`
		<div class="tab-bar" style="display:flex;gap:8px;padding:0 12px;border-bottom:1px solid var(--border);">
			${tabBtn("overview", "Overview")}
			${tabBtn("plan", "Plan")}
		</div>
	`;
}

function tabBtn(id: "overview" | "plan", label: string): TemplateResult {
	const isActive = activeTab === id;
	return html`
		<button
			class="tab ${isActive ? "active" : ""}"
			data-testid=${`mission-tab-${id}`}
			style="padding:8px 14px;border:none;background:none;cursor:pointer;border-bottom:2px solid ${isActive ? "var(--primary)" : "transparent"};color:${isActive ? "var(--foreground)" : "var(--muted-foreground)"};"
			@click=${() => { activeTab = id; renderApp(); }}
		>${label}</button>
	`;
}

function renderOverviewTab(): TemplateResult {
	if (!detail) return html``;
	const m = detail.mission;
	return html`
		<div style="display:flex;flex-direction:column;gap:20px;">
			<section data-testid="mission-section-dag">
				<h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--muted-foreground);letter-spacing:0.06em;">Plan</h3>
				${renderMissionDagSvg(detail.plan, {
					onNodeClick: (planId) => {
						const child = detail!.children.find(c => c.planId === planId);
						if (child?.goal?.id) setHashRoute("goal-dashboard", child.goal.id);
					},
				})}
			</section>

			<section data-testid="mission-section-gates">
				<h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--muted-foreground);letter-spacing:0.06em;">Mission Gates</h3>
				${renderGatesPanel(gates)}
			</section>

			<section data-testid="mission-section-children">
				<h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--muted-foreground);letter-spacing:0.06em;">Child Goals</h3>
				${renderChildGoalsGrid()}
			</section>

			<section data-testid="mission-section-spec">
				<h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--muted-foreground);letter-spacing:0.06em;">Spec</h3>
				<pre style="white-space:pre-wrap;font-size:12px;line-height:1.5;color:var(--foreground);background:var(--muted);padding:12px;border-radius:6px;max-height:280px;overflow-y:auto;">${m.spec}</pre>
			</section>

			${detail.commanderSessionId ? html`
				<section data-testid="mission-section-commander">
					<h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--muted-foreground);letter-spacing:0.06em;">Commander</h3>
					<button class="btn-icon" @click=${() => setHashRoute("session", detail!.commanderSessionId!)}
						data-testid="mission-commander-link">
						Open Commander session →
					</button>
				</section>
			` : ""}
		</div>
	`;
}

function renderPlanTab(): TemplateResult {
	if (!detail || !detail.plan) {
		return html`<p style="color:var(--muted-foreground);" data-testid="mission-plan-empty">Plan has not been proposed yet.</p>`;
	}
	const plan = detail.plan;
	const isPlanReady = isGoalPlanPending(gates);
	return html`
		<div style="display:flex;flex-direction:column;gap:14px;" data-testid="mission-plan-tab">
			<div style="display:flex;align-items:center;gap:12px;">
				<span style="font-size:12px;color:var(--muted-foreground);">Version ${plan.version} · ${plan.goals.length} goals · ${plan.dependencies.length} edges</span>
				<span style="flex:1;"></span>
				${isPlanReady ? html`
					<button class="btn-icon primary" data-testid="mission-approve-plan-btn"
						@click=${() => { /* phase 6 implements plan-approve flow */ }}
						title="Approve plan (signals goal-plan gate)"
						disabled
					>Approve plan (phase 6)</button>
				` : ""}
			</div>
			${renderMissionDagSvg(plan)}
			<div style="display:flex;flex-direction:column;gap:8px;">
				${plan.goals.map(g => html`
					<details style="border:1px solid var(--border);border-radius:6px;padding:8px 12px;" data-testid="planned-goal-card" data-plan-id=${g.planId}>
						<summary style="cursor:pointer;font-weight:500;">${g.title}</summary>
						<div style="margin-top:8px;font-size:12px;color:var(--muted-foreground);display:flex;flex-direction:column;gap:6px;">
							<div>workflow: <code>${g.workflowId}</code> · role: <code>${g.suggestedRole ?? "auto"}</code></div>
							${g.goalId ? html`<div>goal: <a href="#/goal/${g.goalId}" class="underline">${g.goalId.slice(0, 8)}…</a> · state: ${g.state ?? "?"}</div>` : ""}
							<pre style="white-space:pre-wrap;background:var(--muted);padding:8px;border-radius:4px;color:var(--foreground);">${g.spec}</pre>
						</div>
					</details>
				`)}
			</div>
			<div style="font-size:12px;color:var(--muted-foreground);"><b>Rationale:</b> ${plan.rationale}</div>
		</div>
	`;
}

function renderGatesPanel(g: GateState[]): TemplateResult {
	if (!g.length) {
		return html`<p style="color:var(--muted-foreground);font-size:12px;" data-testid="mission-gates-empty">No gates initialised yet.</p>`;
	}
	return html`
		<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px;" data-testid="mission-gates-list">
			${g.map(gate => html`
				<li style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;">
					<span style="font-weight:500;">${gate.name ?? gate.gateId}</span>
					<span style="font-size:11px;color:var(--muted-foreground);">${gate.gateId}</span>
					<span style="flex:1;"></span>
					<span style="font-size:11px;font-weight:500;color:${gateStatusColor(gate.status)};">${gate.status}</span>
				</li>
			`)}
		</ul>
	`;
}

function renderChildGoalsGrid(): TemplateResult {
	if (!detail) return html``;
	if (!detail.children.length) {
		return html`<p style="color:var(--muted-foreground);font-size:12px;" data-testid="mission-children-empty">No child goals spawned yet.</p>`;
	}
	return html`
		<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;" data-testid="mission-children-grid">
			${detail.children.map(c => {
				const title = c.goal?.title ?? c.planId;
				return html`
					<button
						style="text-align:left;border:1px solid var(--border);border-radius:6px;padding:10px 12px;background:var(--background);cursor:pointer;"
						data-testid="mission-child-card" data-plan-id=${c.planId}
						@click=${() => c.goal?.id && setHashRoute("goal-dashboard", c.goal.id)}
						?disabled=${!c.goal?.id}
					>
						<div style="font-weight:500;">${title}</div>
						<div style="font-size:11px;color:var(--muted-foreground);margin-top:4px;">
							${c.goal?.state ?? c.state ?? "pending"}
							${c.lastGate ? html` · last gate: <code>${c.lastGate}</code>` : ""}
						</div>
					</button>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// HELPERS
// ============================================================================

function stateColor(s: PersistedMission["state"]): { bg: string; fg: string } {
	switch (s) {
		case "complete": return { bg: "#bbf7d0", fg: "#166534" };
		case "in-progress": return { bg: "#fde68a", fg: "#92400e" };
		case "paused": return { bg: "#e0e7ff", fg: "#3730a3" };
		case "failed": return { bg: "#fecaca", fg: "#991b1b" };
		case "shelved": return { bg: "#e5e7eb", fg: "#374151" };
		default: return { bg: "#dbeafe", fg: "#1e40af" }; // planning
	}
}

function gateStatusColor(s: string): string {
	if (s === "passed") return "#16a34a";
	if (s === "failed") return "#dc2626";
	if (s === "verifying") return "#d97706";
	return "var(--muted-foreground)";
}

function isGoalPlanPending(gs: GateState[]): boolean {
	const planReview = gs.find(g => g.gateId === "plan-review");
	const goalPlan = gs.find(g => g.gateId === "goal-plan");
	return planReview?.status === "passed" && (!goalPlan || goalPlan.status === "pending");
}

async function onPause(id: string): Promise<void> {
	const reason = prompt("Pause reason (optional):") ?? "";
	if (await pauseMission(id, reason)) {
		await refreshMissionDashboard();
	}
}

async function onResume(id: string): Promise<void> {
	if (await resumeMission(id)) {
		await refreshMissionDashboard();
	}
}

// ============================================================================
// EXPORTS FOR TESTS
// ============================================================================

export const __test__ = {
	getDetail: () => detail,
	getGates: () => gates,
	getActiveTab: () => activeTab,
};
