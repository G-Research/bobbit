/**
 * <goal-status-widget> — chat-header pill that surfaces gate progress + pending
 * human sign-offs for the session's goal. Mounted next to <git-status-widget>
 * by AgentInterface, lazy-loaded via `ensureGoalStatusWidget()`.
 *
 * Pill content (collapsed):
 *   - Goal icon + `(passed/total)` badge via the shared `renderGateProgressBadge`
 *     helper (extracted from sidebar's `renderGoalBadge` so visual vocabulary is
 *     shared).
 *   - Pulsing primary-colour exclamation icon between the goal icon and gate
 *     counter when ≥1 human-signoff step is awaiting input.
 *
 * Popover (click pill):
 *   - Gate list with status icons via `renderGateStatusIcon`.
 *   - Inline sign-off cards: label + substituted prompt (markdown), Start Review
 *     launcher for the review pane.
 *   - Passed gate View / Reset controls and a top-right Goal Dashboard button.
 *
 * Data:
 *   - Initial: `GET /api/goals/:id/gates` and `GET /api/goals/:id/verifications/active`.
 *   - Live: viewer WebSocket subscription using the centralized gate event
 *     refresh contract in `app/gate-status-events.ts`.
 *
 * Authz: trusts the gateway token (v1 — no identity model). Sign-off submission
 * records only a server-side timestamp.
 */
import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing, render, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { AlertTriangle, CheckCircle2, Eye, Goal as GoalIcon, LayoutDashboard, Loader2, RotateCcw } from "lucide";
import { ensureMarkdownBlock } from "../lazy/markdown-block.js";
import { completeTeam, refreshSessions, scheduleGateStatusRefreshForGoal } from "../../app/api.js";
import type { SignoffReviewTarget } from "../../app/signoff-review-launch.js";
import "./SignoffReviewLauncher.js";
import { GATE_STATUS_CACHE_UPDATED_EVENT_TYPE, GATE_STATUS_CLIENT_EVENT, HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE, shouldRefreshActiveVerificationsForEvent, shouldRefreshGateDetailsForEvent, shouldRefreshGateStatusForEvent } from "../../app/gate-status-events.js";
import { renderGateProgressBadge, renderGateStatusIcon } from "../../app/render-helpers.js";
import { setHashRoute } from "../../app/routing.js";
import { state as appState } from "../../app/state.js";

type GateStatus = "pending" | "passed" | "failed" | "running" | "bypassed";

interface GateSummary {
	id: string;
	name: string;
	status: GateStatus;
	latestPassedSignalId?: string;
	/** Human justification recorded when a gate was bypassed (honesty system). */
	whyBypassed?: string;
	/** Free-text “who am I” label of whoever bypassed the gate. */
	whoAmI?: string;
}

interface SignoffRequest {
	signalId: string;
	gateId: string;
	stepName: string;
	label: string;
	prompt: string;
}

/** Stable key for a pending sign-off row. */
function signoffKey(s: { signalId: string; stepName: string }): string {
	return `${s.signalId}::${s.stepName}`;
}

@customElement("goal-status-widget")
export class GoalStatusWidget extends LitElement {
	@property() goalId = "";
	@property() token = "";
	@property() branch = "";

	@state() private _gates: GateSummary[] = [];
	@state() private _awaitingSignoffs: SignoffRequest[] = [];
	@state() private _activeGateIds: Set<string> = new Set();
	@state() private _loading = true;
	@state() private _expanded = false;
	@state() private _resetLoading: Set<string> = new Set();
	@state() private _resetErrors: Map<string, string> = new Map();
	// Inline bypass form (human-only gate override). `_bypassing` holds the gate
	// id whose form is open, or null. Mirrors the reset loading/error patterns.
	@state() private _bypassing: string | null = null;
	@state() private _bypassWhy = "";
	@state() private _bypassWho = "";
	@state() private _bypassLoading: Set<string> = new Set();
	@state() private _bypassErrors: Map<string, string> = new Map();
	@state() private _confirmCompletionLoading = false;
	@state() private _confirmCompletionError = "";
	/** Reversible snapshot of the authoritative app goal lifecycle. */
	@state() private _goalState: string | undefined;
	@state() private _closing = false;

	private _goalStateWatchFrame: number | null = null;
	private _ws: WebSocket | null = null;
	private _wsIntentionalClose = false;
	private _wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _dropdownEl: HTMLElement | null = null;
	private _closeToken = 0;
	private _onHashChange = () => {
		if (this._expanded) this._closeDropdown();
	};

	private _onDocumentClick = (e: MouseEvent) => {
		const target = e.target as Node;
		if (this._expanded && !this._closing && !this.contains(target) && !this._dropdownEl?.contains(target)) {
			this._closeDropdown();
		}
	};

	private _onEscapeKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return;
		if (this._expanded && !this._closing) {
			e.stopPropagation();
			this._closeDropdown();
		}
	};

	private _onGateStatusClientEvent = (e: Event) => {
		const msg = (e as CustomEvent).detail;
		if (!msg || typeof msg !== "object") return;
		if (typeof msg.goalId === "string" && msg.goalId !== this.goalId) return;
		if (msg.type === GATE_STATUS_CACHE_UPDATED_EVENT_TYPE) {
			this.requestUpdate();
			this._syncDropdown();
			return;
		}
		this._handleWsEvent(msg);
	};

	// Render into light DOM so global styles (Tailwind, the inline keyframe
	// styles we inject below) apply identically to the rest of the chat header.
	createRenderRoot() {
		return this;
	}

	connectedCallback() {
		super.connectedCallback();
		document.addEventListener("click", this._onDocumentClick, true);
		document.addEventListener("keydown", this._onEscapeKey, true);
		window.addEventListener("hashchange", this._onHashChange);
		window.addEventListener(GATE_STATUS_CLIENT_EVENT, this._onGateStatusClientEvent);
		this._ensureWidgetStyles();
		this._syncGoalStateFromApp();
		if (this.goalId) {
			void this._fetchInitial();
			this._connectWs();
		}
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("click", this._onDocumentClick, true);
		document.removeEventListener("keydown", this._onEscapeKey, true);
		window.removeEventListener("hashchange", this._onHashChange);
		window.removeEventListener(GATE_STATUS_CLIENT_EVENT, this._onGateStatusClientEvent);
		this._stopGoalStateWatch();
		this._closeToken++;
		this._removeDropdown();
		this._disconnectWs();
		this._closing = false;
		this._expanded = false;
	}

	override updated(changed: Map<string, unknown>) {
		super.updated(changed);
		if (changed.has("goalId")) {
			// Goal switched (rare — the host AgentInterface re-mounts per session,
			// but defensive).
			this._gates = [];
			this._awaitingSignoffs = [];
			this._activeGateIds = new Set();
			this._resetLoading = new Set();
			this._resetErrors = new Map();
			this._bypassing = null;
			this._bypassWhy = "";
			this._bypassWho = "";
			this._bypassLoading = new Set();
			this._bypassErrors = new Map();
			this._confirmCompletionLoading = false;
			this._confirmCompletionError = "";
			this._goalState = appState.goals.find(g => g.id === this.goalId)?.state;
			this._loading = true;
			this._disconnectWs();
			if (this.goalId) {
				void this._fetchInitial();
				this._connectWs();
			}
		}
		if (changed.has("_expanded")) {
			if (this._expanded) this._startGoalStateWatch();
			else this._stopGoalStateWatch();
		}
		if (changed.has("_expanded") || changed.has("_gates") || changed.has("_awaitingSignoffs") || changed.has("_activeGateIds") || changed.has("_resetLoading") || changed.has("_resetErrors") || changed.has("_bypassing") || changed.has("_bypassWhy") || changed.has("_bypassWho") || changed.has("_bypassLoading") || changed.has("_bypassErrors") || changed.has("_confirmCompletionLoading") || changed.has("_confirmCompletionError") || changed.has("_goalState")) {
			this._syncDropdown();
		}
	}

	// ── Data fetch ───────────────────────────────────────────────────

	private async _fetchInitial(): Promise<void> {
		this._loading = true;
		scheduleGateStatusRefreshForGoal(this.goalId, 0);
		try {
			const [gatesResp, vActiveResp] = await Promise.all([
				this._fetch(`/api/goals/${this.goalId}/gates`),
				this._fetch(`/api/goals/${this.goalId}/verifications/active`),
			]);
			if (gatesResp?.ok) {
				const data = await gatesResp.json().catch(() => null);
				if (data?.gates) this._gates = this._normalizeGates(data.gates);
			}
			if (vActiveResp?.ok) {
				const data = await vActiveResp.json().catch(() => null);
				if (data?.verifications) {
					this._awaitingSignoffs = this._extractSignoffs(data.verifications);
					this._activeGateIds = this._extractActiveGateIds(data.verifications);
				}
			}
		} catch {
			// non-fatal — WS events will rehydrate
		}
		this._loading = false;
	}

	private async _refreshGates(): Promise<void> {
		scheduleGateStatusRefreshForGoal(this.goalId, 0);
		try {
			const resp = await this._fetch(`/api/goals/${this.goalId}/gates`);
			if (!resp?.ok) return;
			const data = await resp.json().catch(() => null);
			if (data?.gates) this._gates = this._normalizeGates(data.gates);
		} catch { /* non-fatal */ }
	}

	private async _refreshActive(): Promise<void> {
		scheduleGateStatusRefreshForGoal(this.goalId, 0);
		try {
			const resp = await this._fetch(`/api/goals/${this.goalId}/verifications/active`);
			if (!resp?.ok) return;
			const data = await resp.json().catch(() => null);
			if (data?.verifications) {
				this._awaitingSignoffs = this._extractSignoffs(data.verifications);
				this._activeGateIds = this._extractActiveGateIds(data.verifications);
			}
		} catch { /* non-fatal */ }
	}

	private _syncGoalStateFromApp(): void {
		const goal = appState.goals.find(g => g.id === this.goalId);
		if (goal && goal.state !== this._goalState) this._goalState = goal.state;
	}

	/**
	 * App goal refreshes replace `appState.goals` but do not remount this custom
	 * element or emit a component-local event. While the lifecycle UI is visible,
	 * observe that authoritative state once per paint so completion from
	 * team_complete, another tab, or polling is reflected without a monotonic
	 * local latch. Opening the popover also synchronizes before its first paint.
	 */
	private _startGoalStateWatch(): void {
		if (this._goalStateWatchFrame !== null) return;
		const watch = () => {
			this._goalStateWatchFrame = null;
			if (!this.isConnected || !this._expanded) return;
			this._syncGoalStateFromApp();
			this._goalStateWatchFrame = requestAnimationFrame(watch);
		};
		watch();
	}

	private _stopGoalStateWatch(): void {
		if (this._goalStateWatchFrame === null) return;
		cancelAnimationFrame(this._goalStateWatchFrame);
		this._goalStateWatchFrame = null;
	}

	private async _refreshGoalState(): Promise<void> {
		await refreshSessions();
		this._syncGoalStateFromApp();
	}

	private async _fetch(path: string, init?: RequestInit): Promise<Response | null> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
		try {
			return await fetch(path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
		} catch {
			return null;
		}
	}

	private _normalizeGates(rawGates: unknown[]): GateSummary[] {
		const out: GateSummary[] = [];
		for (const g of rawGates) {
			if (!g || typeof g !== "object") continue;
			const obj = g as Record<string, unknown>;
			const id = typeof obj.gateId === "string" ? obj.gateId : typeof obj.id === "string" ? obj.id : null;
			if (!id) continue;
			const name = typeof obj.name === "string" ? obj.name : id;
			const status: GateStatus = obj.status === "passed" ? "passed"
				: obj.status === "failed" ? "failed"
				: obj.status === "running" ? "running"
				: obj.status === "bypassed" ? "bypassed"
				: "pending";
			const latestPassedSignalId = typeof obj.latestPassedSignalId === "string"
				? obj.latestPassedSignalId
				: this._latestPassedSignalId(obj.signals);
			let whyBypassed: string | undefined;
			let whoAmI: string | undefined;
			if (status === "bypassed") {
				// Canonical top-level read-model fields (server §5), with a fallback
				// to the latest synthetic bypass signal for robustness.
				whyBypassed = typeof obj.whyBypassed === "string" ? obj.whyBypassed : undefined;
				whoAmI = typeof obj.whoAmI === "string" ? obj.whoAmI : undefined;
				if (whyBypassed === undefined || whoAmI === undefined) {
					const fallback = this._latestBypassSignalMeta(obj.signals);
					if (whyBypassed === undefined) whyBypassed = fallback?.whyBypassed;
					if (whoAmI === undefined) whoAmI = fallback?.whoAmI;
				}
			}
			out.push({ id, name, status, latestPassedSignalId, whyBypassed, whoAmI });
		}
		return out;
	}

	/** Fallback reader: pull why/who from the latest signal whose metadata
	 *  marks it as a bypass audit signal (metadata.bypass === "true"). Used only
	 *  when the canonical top-level read-model fields are absent. */
	private _latestBypassSignalMeta(rawSignals: unknown): { whyBypassed?: string; whoAmI?: string } | undefined {
		if (!Array.isArray(rawSignals)) return undefined;
		for (let i = rawSignals.length - 1; i >= 0; i--) {
			const signal = rawSignals[i];
			if (!signal || typeof signal !== "object") continue;
			const meta = (signal as Record<string, unknown>).metadata;
			if (!meta || typeof meta !== "object") continue;
			const m = meta as Record<string, unknown>;
			if (m.bypass !== "true") continue;
			return {
				whyBypassed: typeof m.whyBypassed === "string" ? m.whyBypassed : undefined,
				whoAmI: typeof m.whoAmI === "string" ? m.whoAmI : undefined,
			};
		}
		return undefined;
	}

	private _latestPassedSignalId(rawSignals: unknown): string | undefined {
		if (!Array.isArray(rawSignals)) return undefined;
		for (let i = rawSignals.length - 1; i >= 0; i--) {
			const signal = rawSignals[i];
			if (!signal || typeof signal !== "object") continue;
			const obj = signal as Record<string, unknown>;
			const verification = obj.verification;
			const vStatus = verification && typeof verification === "object" ? (verification as Record<string, unknown>).status : undefined;
			if (vStatus !== "passed") continue;
			if (typeof obj.id === "string") return obj.id;
			if (typeof obj.signalId === "string") return obj.signalId;
		}
		return undefined;
	}

	private _extractActiveGateIds(verifications: unknown[]): Set<string> {
		const out = new Set<string>();
		for (const v of verifications) {
			if (!v || typeof v !== "object") continue;
			const vv = v as Record<string, unknown>;
			const gateId = typeof vv.gateId === "string" ? vv.gateId : null;
			if (!gateId) continue;
			const status = typeof vv.overallStatus === "string" ? vv.overallStatus : typeof vv.status === "string" ? vv.status : "running";
			if (status === "running" || status === "pending") out.add(gateId);
		}
		return out;
	}

	private _extractSignoffs(verifications: unknown[]): SignoffRequest[] {
		const out: SignoffRequest[] = [];
		for (const v of verifications) {
			if (!v || typeof v !== "object") continue;
			const vv = v as Record<string, unknown>;
			const signalId = typeof vv.signalId === "string" ? vv.signalId : null;
			const gateId = typeof vv.gateId === "string" ? vv.gateId : null;
			if (!signalId || !gateId) continue;
			const steps = Array.isArray(vv.steps) ? vv.steps : [];
			for (const s of steps) {
				if (!s || typeof s !== "object") continue;
				const ss = s as Record<string, unknown>;
				if (ss.awaitingHuman !== true) continue;
				const stepName = typeof ss.name === "string" ? ss.name : null;
				if (!stepName) continue;
				const label = typeof ss.humanLabel === "string" ? ss.humanLabel
					: typeof ss.label === "string" ? ss.label
					: stepName;
				const prompt = typeof ss.humanPrompt === "string" ? ss.humanPrompt
					: typeof ss.prompt === "string" ? ss.prompt
					: "";
				out.push({ signalId, gateId, stepName, label, prompt });
			}
		}
		return out;
	}

	// ── WebSocket ────────────────────────────────────────────────────

	private _connectWs(): void {
		if (!this.goalId) return;
		if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;
		this._wsIntentionalClose = false;
		const protocol = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${location.host}/ws/viewer`);
		this._ws = ws;

		const subscribe = () => {
			if (ws.readyState === WebSocket.OPEN && this.goalId) {
				ws.send(JSON.stringify({ type: "subscribe_goal", goalId: this.goalId }));
			}
		};
		ws.addEventListener("open", () => {
			if (this.token) {
				ws.send(JSON.stringify({ type: "auth", token: this.token, goalId: this.goalId }));
			} else {
				subscribe();
			}
		});
		ws.addEventListener("message", (event) => {
			try {
				const msg = JSON.parse(event.data as string);
				if (msg?.type === "auth_ok") { subscribe(); return; }
				if (typeof msg?.goalId === "string" && msg.goalId !== this.goalId) return;
				this._handleWsEvent(msg);
			} catch {
				// ignore unparseable
			}
		});
		ws.addEventListener("close", () => {
			if (this._wsIntentionalClose || !this.goalId) return;
			this._wsReconnectTimer = setTimeout(() => {
				if (!this._wsIntentionalClose && this.goalId) this._connectWs();
			}, 3000);
		});
		ws.addEventListener("error", () => { /* close handles reconnect */ });
	}

	private _disconnectWs(): void {
		this._wsIntentionalClose = true;
		if (this._wsReconnectTimer != null) {
			clearTimeout(this._wsReconnectTimer);
			this._wsReconnectTimer = null;
		}
		if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
			this._ws.close();
		}
		this._ws = null;
	}

	private _handleWsEvent(msg: any): void {
		const t = msg?.type;
		if (t === HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE) {
			this._removeAwaitingSignoff(msg);
		}
		if (shouldRefreshGateStatusForEvent(msg)) {
			scheduleGateStatusRefreshForGoal(this.goalId);
		}
		if (shouldRefreshGateDetailsForEvent(msg)) {
			void this._refreshGates();
		}
		if (shouldRefreshActiveVerificationsForEvent(msg)) {
			void this._refreshActive();
		}
		switch (t) {
			case "goal_state_changed":
				// This widget has its own goal-scoped viewer subscription, so reconcile
				// completion even when the app-wide RemoteAgent socket is not mounted.
				void Promise.all([
					this._refreshGoalState(),
					this._refreshGates(),
					this._refreshActive(),
				]);
				break;
			case "gate_verification_awaiting_human": {
				const signalId = typeof msg.signalId === "string" ? msg.signalId : null;
				const gateId = typeof msg.gateId === "string" ? msg.gateId : null;
				const stepName = typeof msg.stepName === "string" ? msg.stepName : null;
				if (!signalId || !gateId || !stepName) { void this._refreshActive(); break; }
				const label = typeof msg.label === "string" ? msg.label : stepName;
				const prompt = typeof msg.prompt === "string" ? msg.prompt : "";
				// Dedupe — replace any existing entry for the same key.
				const key = `${signalId}::${stepName}`;
				const filtered = this._awaitingSignoffs.filter(s => signoffKey(s) !== key);
				filtered.push({ signalId, gateId, stepName, label, prompt });
				this._awaitingSignoffs = filtered;
				break;
			}
			default:
				break;
		}
	}

	private _removeAwaitingSignoff(msg: any): void {
		const signalId = typeof msg?.signalId === "string" ? msg.signalId : null;
		const stepName = typeof msg?.stepName === "string" ? msg.stepName : null;
		if (!signalId || !stepName) return;
		const key = `${signalId}::${stepName}`;
		const filtered = this._awaitingSignoffs.filter(s => signoffKey(s) !== key);
		if (filtered.length !== this._awaitingSignoffs.length) this._awaitingSignoffs = filtered;
	}

	// ── Sign-off content ──────────────────────────────────────────────

	private _gateName(gateId: string): string {
		return this._gates.find(g => g.id === gateId)?.name || gateId;
	}

	private _signoffReviewTarget(req: SignoffRequest): SignoffReviewTarget {
		const gateName = this._gateName(req.gateId);
		const duplicateCount = this._awaitingSignoffs.filter(s => {
			return this._gateName(s.gateId) === gateName
				&& (s.label || s.stepName) === (req.label || req.stepName);
		}).length;
		return {
			goalId: this.goalId,
			gateId: req.gateId,
			signalId: req.signalId,
			stepName: req.stepName,
			stepLabel: req.label,
			goalTitle: this.branch || this.goalId || "Goal",
			gateName,
			disambiguateWithSignal: duplicateCount > 1,
		};
	}

	// ── Pill toggle ──────────────────────────────────────────────────

	private _togglePill(e: MouseEvent) {
		e.stopPropagation();
		if (this._expanded && !this._closing) {
			this._closeDropdown();
		} else {
			this._syncGoalStateFromApp();
			this._closeToken++;
			this._closing = false;
			this._expanded = true;
		}
	}

	private _closeDropdown(): void {
		if (this._closing || !this._dropdownEl) {
			this._expanded = false;
			return;
		}
		this._closing = true;
		const token = ++this._closeToken;
		this._dropdownEl.classList.add("goal-status-closing");
		const reset = () => {
			if (token !== this._closeToken) return;
			this._closing = false;
			this._expanded = false;
		};
		this._dropdownEl.addEventListener("animationend", reset, { once: true });
		this._dropdownEl.addEventListener("animationcancel", reset, { once: true });
	}

	private _removeDropdown(): void {
		if (this._dropdownEl) {
			this._dropdownEl.remove();
			this._dropdownEl = null;
		}
	}

	private _syncDropdown(): void {
		if (this._expanded) {
			if (!this._dropdownEl) {
				this._dropdownEl = document.createElement("div");
				this._dropdownEl.id = "goal-status-dropdown";
				this._dropdownEl.className = "fixed z-[9999] bg-card border border-border rounded-lg shadow-lg p-3 text-[13px]";
				this._dropdownEl.style.maxWidth = "min(420px, calc(100vw - 1rem))";
				this._dropdownEl.style.minWidth = "260px";
				this._dropdownEl.style.maxHeight = "min(70vh, 520px)";
				this._dropdownEl.style.overflowY = "auto";
				document.body.appendChild(this._dropdownEl);
			}
			render(this._renderDropdownContent(), this._dropdownEl);
			this._positionDropdown();
		} else if (!this._closing) {
			this._removeDropdown();
		} else if (this._dropdownEl) {
			// Closing — re-render once so any state changes show during the fade.
			render(this._renderDropdownContent(), this._dropdownEl);
		}
	}

	private _positionDropdown(): void {
		const btn = this.querySelector("button");
		const dropdown = this._dropdownEl;
		if (!btn || !dropdown) return;
		const rect = btn.getBoundingClientRect();
		const vw = window.innerWidth;
		const pad = 8;
		let rightVal = vw - rect.right;
		const dropdownWidth = dropdown.offsetWidth || 0;
		if (dropdownWidth > 0) {
			const leftEdge = vw - rightVal - dropdownWidth;
			if (leftEdge < pad) rightVal = Math.max(pad, vw - dropdownWidth - pad);
		}
		dropdown.style.right = `${rightVal}px`;
		dropdown.style.left = "";
		const spaceBelow = window.innerHeight - rect.bottom;
		const spaceAbove = rect.top;
		if (spaceAbove > spaceBelow) {
			dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
			dropdown.style.top = "";
		} else {
			dropdown.style.top = `${rect.bottom + 4}px`;
			dropdown.style.bottom = "";
		}
	}

	// ── Gate actions ─────────────────────────────────────────────────

	private _viewGate(gate: GateSummary): void {
		this._closeDropdown();
		const params = new URLSearchParams({ tab: "gates", gate: gate.id });
		params.set("signal", gate.latestPassedSignalId || "latest-passed");
		window.location.hash = `#/goal/${encodeURIComponent(this.goalId)}?${params.toString()}`;
	}

	private async _resetGate(gate: GateSummary): Promise<void> {
		if (this._resetLoading.has(gate.id)) return;
		const { confirmAction } = await import("../../app/dialogs-lazy.js");
		this._dropdownEl?.classList.add("goal-status-confirming");
		const isBypassed = gate.status === "bypassed";
		const confirmed = await confirmAction(
			isBypassed ? `Remove bypass on “${gate.name}”?` : `Reset “${gate.name}”?`,
			isBypassed
				? "This will remove the human bypass and return this gate (and downstream dependent gates) to pending, so it must be verified again. Historical signals and content will be preserved. The team lead will be notified that downstream work may need to be revisited."
				: "This will clear the passed state for this gate and downstream dependent gates. Historical signals and content will be preserved. The team lead will be notified that downstream work may need to be revisited.",
			isBypassed ? "Remove bypass" : "Reset",
			true,
		);
		this._dropdownEl?.classList.remove("goal-status-confirming");
		if (!confirmed) return;

		const loading = new Set(this._resetLoading); loading.add(gate.id); this._resetLoading = loading;
		const errors = new Map(this._resetErrors); errors.delete(gate.id); this._resetErrors = errors;
		try {
			const resp = await this._fetch(`/api/goals/${encodeURIComponent(this.goalId)}/gates/${encodeURIComponent(gate.id)}/reset`, {
				method: "POST",
				body: JSON.stringify({ reason: "user reset from goal status widget" }),
			});
			if (!resp) throw new Error("Unable to reset gate (network)");
			if (!resp.ok) throw new Error(await this._resetErrorMessage(resp));
			const data = await resp.json().catch(() => null);
			const reopen = data?.reopen;
			if (typeof reopen?.state === "string") this._goalState = reopen.state;

			// Reflect the successful reset before the follow-up reads complete. The
			// server returns the full affected set (selected plus dependants).
			const affectedGateIds = Array.isArray(data?.affectedGateIds)
				? data.affectedGateIds.filter((id: unknown): id is string => typeof id === "string")
				: [gate.id];
			const affected = new Set(affectedGateIds);
			this._gates = this._gates.map(current => affected.has(current.id)
				? { ...current, status: "pending", latestPassedSignalId: undefined }
				: current);
			this._activeGateIds = new Set([...this._activeGateIds].filter(id => !affected.has(id)));
			this._awaitingSignoffs = this._awaitingSignoffs.filter(signoff => !affected.has(signoff.gateId));

			await Promise.all([this._refreshGoalState(), this._refreshGates(), this._refreshActive()]);
		} catch (err) {
			const next = new Map(this._resetErrors);
			next.set(gate.id, err instanceof Error ? err.message : "Unable to reset gate");
			this._resetErrors = next;
		} finally {
			const next = new Set(this._resetLoading); next.delete(gate.id); this._resetLoading = next;
		}
	}

	private async _resetErrorMessage(resp: Response): Promise<string> {
		const data = await resp.json().catch(() => null);
		if (typeof data?.error === "string" && data.error.trim()) return data.error;
		return `Unable to reset gate (${resp.status})`;
	}

	// ── Bypass (human-only gate override) ─────────────────────────────

	private _openBypassForm(gate: GateSummary): void {
		const next = new Map(this._bypassErrors); next.delete(gate.id); this._bypassErrors = next;
		this._bypassWhy = "";
		this._bypassWho = "";
		this._bypassing = gate.id;
	}

	private _cancelBypassForm(): void {
		this._bypassing = null;
		this._bypassWhy = "";
		this._bypassWho = "";
	}

	private async _confirmBypass(gate: GateSummary): Promise<void> {
		if (this._bypassLoading.has(gate.id)) return;
		const whyBypassed = this._bypassWhy.trim();
		const whoAmI = this._bypassWho.trim();
		if (!whyBypassed || !whoAmI) return;
		const loading = new Set(this._bypassLoading); loading.add(gate.id); this._bypassLoading = loading;
		const errors = new Map(this._bypassErrors); errors.delete(gate.id); this._bypassErrors = errors;
		try {
			const resp = await this._fetch(`/api/goals/${encodeURIComponent(this.goalId)}/gates/${encodeURIComponent(gate.id)}/bypass`, {
				method: "POST",
				body: JSON.stringify({ whyBypassed, whoAmI, isInitiatedByHuman: true }),
			});
			if (!resp) throw new Error("Unable to bypass gate (network)");
			if (!resp.ok) throw new Error(await this._bypassErrorMessage(resp));
			this._bypassing = null;
			this._bypassWhy = "";
			this._bypassWho = "";
			await Promise.all([this._refreshGates(), this._refreshActive()]);
		} catch (err) {
			const next = new Map(this._bypassErrors);
			next.set(gate.id, err instanceof Error ? err.message : "Unable to bypass gate");
			this._bypassErrors = next;
		} finally {
			const next = new Set(this._bypassLoading); next.delete(gate.id); this._bypassLoading = next;
		}
	}

	private async _bypassErrorMessage(resp: Response): Promise<string> {
		const data = await resp.json().catch(() => null);
		if (typeof data?.error === "string" && data.error.trim()) return data.error;
		return `Unable to bypass gate (${resp.status})`;
	}

	private async _confirmCompletion(): Promise<void> {
		if (this._confirmCompletionLoading) return;
		const bypassedCount = this._gates.filter(g => g.status === "bypassed").length;
		const { confirmAction } = await import("../../app/dialogs-lazy.js");
		this._dropdownEl?.classList.add("goal-status-confirming");
		const confirmed = await confirmAction(
			"Complete goal despite bypassed gate(s)?",
			`${bypassedCount} gate(s) were forced past verification. Completing now records the goal as done with un-verified gates. This cannot be undone automatically.`,
			"Complete",
			true,
		);
		this._dropdownEl?.classList.remove("goal-status-confirming");
		if (!confirmed) return;
		this._confirmCompletionLoading = true;
		this._confirmCompletionError = "";
		try {
			const ok = await completeTeam(this.goalId, { confirmBypassedGates: true });
			if (!ok) {
				this._confirmCompletionError = "Unable to complete goal";
				return;
			}
			// Reflect the successful authoritative mutation immediately; completeTeam()
			// has already refreshed appState, and the watcher keeps this reversible.
			this._goalState = "complete";
			await Promise.all([this._refreshGates(), this._refreshActive()]);
		} catch (err) {
			this._confirmCompletionError = err instanceof Error ? err.message : "Unable to complete goal";
		} finally {
			this._confirmCompletionLoading = false;
		}
	}

	// ── Render ───────────────────────────────────────────────────────

	private _renderDropdownContent(): TemplateResult {
		const live = this._awaitingSignoffs;
		const anyBypassed = this._gates.some(g => g.status === "bypassed");
		// Completion is only possible once EVERY gate is resolved (passed or
		// bypassed) — mirrors the server rule in team-manager.completeTeam(). A
		// still-pending/failed/running gate means there is outstanding work, so the
		// human "Confirm completion" override must not be offered yet.
		const allGatesResolved = this._gates.length > 0
			&& this._gates.every(g => !this._activeGateIds.has(g.id) && (g.status === "passed" || g.status === "bypassed"));
		const goalComplete = this._goalState === "complete";
		const canConfirmCompletion = anyBypassed && allGatesResolved && !goalComplete;
		return html`
			<div class="flex items-center justify-between gap-2 mb-2 text-foreground font-medium text-sm">
				<div class="flex items-center gap-1.5 min-w-0">
					${icon(GoalIcon, "sm")}
					<span>Goal status</span>
					${renderGateProgressBadge(this.goalId)}
				</div>
				<div class="flex items-center gap-1.5 shrink-0">
					${canConfirmCompletion ? html`
						<button
							class="goal-widget-button goal-widget-button-bypass"
							?disabled=${this._confirmCompletionLoading}
							@click=${(e: MouseEvent) => { e.stopPropagation(); void this._confirmCompletion(); }}
							data-testid="goal-widget-confirm-completion"
							title="Confirm completion despite bypassed gate(s)"
						>${this._confirmCompletionLoading ? icon(Loader2, "xs", "animate-spin") : icon(CheckCircle2, "xs")}<span>${this._confirmCompletionLoading ? "Completing…" : "Confirm completion"}</span></button>
					` : goalComplete ? html`
						<span class="goal-widget-completed" data-testid="goal-widget-completed" title="This goal has been marked complete">${icon(CheckCircle2, "xs")}<span>Completed</span></span>
					` : nothing}
					<button
						class="goal-widget-button goal-widget-button-neutral"
						@click=${(e: MouseEvent) => { e.stopPropagation(); this._closeDropdown(); setHashRoute("goal-dashboard", this.goalId); }}
						data-testid="goal-widget-dashboard-link"
						title="Goal dashboard"
					>${icon(LayoutDashboard, "xs")}<span>Goal Dashboard</span></button>
				</div>
			</div>
			${canConfirmCompletion && this._confirmCompletionError ? html`<div class="goal-widget-gate-error mb-2" data-testid="goal-widget-confirm-completion-error">${this._confirmCompletionError}</div>` : nothing}

			<div class="border-t border-border mb-2"></div>

			${this._gates.length === 0
				? html`<div class="text-muted-foreground" style="font-size:12px">${this._loading ? "Loading gates\u2026" : "No gates"}</div>`
				: html`
					<div class="flex flex-col gap-1 mb-2" data-testid="goal-widget-gates">
						${this._gates.map(g => this._renderGateRow(g))}
					</div>
				`}

			${live.length > 0 ? html`
				<div class="border-t border-border pt-2 mt-2 flex flex-col gap-2" data-testid="goal-widget-signoffs">
					<div class="text-muted-foreground" style="font-size:12px;font-weight:500">Awaiting sign-off</div>
					${live.map(req => this._renderSignoffCard(req))}
				</div>
			` : nothing}
		`;
	}

	private _renderGateRow(gate: GateSummary): TemplateResult {
		const resetting = this._resetLoading.has(gate.id);
		const resetError = this._resetErrors.get(gate.id);
		const bypassError = this._bypassErrors.get(gate.id);
		const effectiveStatus: GateStatus = this._activeGateIds.has(gate.id) ? "running" : gate.status;
		const canBypass = effectiveStatus === "pending" || effectiveStatus === "failed";
		const formOpen = this._bypassing === gate.id;
		const rowTitle = effectiveStatus === "bypassed" && (gate.whoAmI || gate.whyBypassed)
			? `Bypassed by ${gate.whoAmI || "unknown"}${gate.whyBypassed ? `: ${gate.whyBypassed}` : ""}`
			: gate.name;
		return html`
			<div class="goal-widget-gate-row flex items-center gap-2 rounded-md" data-testid="goal-widget-gate" data-gate-id=${gate.id} data-gate-status=${effectiveStatus}>
				<div class="goal-widget-gate-main min-w-0 flex items-center gap-2">
					${this._renderGateStatusIndicator(gate)}
					<span class="truncate text-foreground" title=${rowTitle}>${gate.name}</span>
				</div>
				${effectiveStatus === "passed" ? html`
					<div class="goal-widget-gate-actions" data-testid="goal-widget-gate-actions">
						<button
							type="button"
							class="goal-widget-button goal-widget-button-neutral goal-widget-gate-action"
							@click=${(e: MouseEvent) => { e.stopPropagation(); this._viewGate(gate); }}
							data-testid="goal-widget-gate-view"
						>${icon(Eye, "xs")}<span>View</span></button>
						<button
							type="button"
							class="goal-widget-button goal-widget-button-reset goal-widget-gate-action"
							?disabled=${resetting}
							@click=${(e: MouseEvent) => { e.stopPropagation(); void this._resetGate(gate); }}
							data-testid="goal-widget-gate-reset"
						>${resetting ? icon(Loader2, "xs", "animate-spin") : icon(RotateCcw, "xs")}<span>${resetting ? "Resetting…" : "Reset"}</span></button>
					</div>
				` : nothing}
				${effectiveStatus === "bypassed" ? html`
					<div class="goal-widget-gate-actions" data-testid="goal-widget-gate-actions">
						<button
							type="button"
							class="goal-widget-button goal-widget-button-reset goal-widget-gate-action"
							?disabled=${resetting}
							@click=${(e: MouseEvent) => { e.stopPropagation(); void this._resetGate(gate); }}
							data-testid="goal-widget-gate-reset"
							title="Remove the bypass and return this gate to pending"
						>${resetting ? icon(Loader2, "xs", "animate-spin") : icon(RotateCcw, "xs")}<span>${resetting ? "Removing…" : "Remove bypass"}</span></button>
					</div>
				` : nothing}
				${canBypass && !formOpen ? html`
					<div class="goal-widget-gate-actions" data-testid="goal-widget-gate-actions">
						<button
							type="button"
							class="goal-widget-button goal-widget-button-bypass goal-widget-gate-action"
							@click=${(e: MouseEvent) => { e.stopPropagation(); this._openBypassForm(gate); }}
							data-testid="goal-widget-gate-bypass"
							title="Force this gate past verification (human override)"
						>${icon(AlertTriangle, "xs")}<span>Bypass</span></button>
					</div>
				` : nothing}
				${resetError ? html`<div class="goal-widget-gate-error" data-testid="goal-widget-gate-reset-error">${resetError}</div>` : nothing}
			</div>
			${effectiveStatus === "bypassed" && (gate.whoAmI || gate.whyBypassed) ? html`
				<div class="goal-widget-bypass-caption" data-testid="goal-widget-gate-bypass-info" title=${rowTitle}>
					Bypassed${gate.whoAmI ? html` by <span class="goal-widget-bypass-who">${gate.whoAmI}</span>` : nothing}${gate.whyBypassed ? html`: ${gate.whyBypassed}` : nothing}
				</div>
			` : nothing}
			${formOpen ? this._renderBypassForm(gate) : nothing}
			${bypassError ? html`<div class="goal-widget-gate-error" data-testid="goal-widget-gate-bypass-error">${bypassError}</div>` : nothing}
		`;
	}

	private _renderBypassForm(gate: GateSummary): TemplateResult {
		const loading = this._bypassLoading.has(gate.id);
		const canConfirm = !loading && this._bypassWhy.trim().length > 0 && this._bypassWho.trim().length > 0;
		return html`
			<div class="goal-widget-bypass-form" data-testid="goal-widget-bypass-form" @click=${(e: MouseEvent) => e.stopPropagation()}>
				<div class="goal-widget-bypass-warning">${icon(AlertTriangle, "xs")}<span>Forcing this gate past verification is a human-only override. It will not be a clean pass.</span></div>
				<label class="goal-widget-bypass-label">Why are you bypassing this gate?</label>
				<textarea
					class="goal-widget-bypass-input"
					data-testid="goal-widget-bypass-why"
					rows="3"
					placeholder="Justification (recorded for audit)"
					.value=${this._bypassWhy}
					@input=${(e: Event) => { this._bypassWhy = (e.target as HTMLTextAreaElement).value; }}
				></textarea>
				<label class="goal-widget-bypass-label">Who are you?</label>
				<input
					class="goal-widget-bypass-input"
					data-testid="goal-widget-bypass-who"
					type="text"
					placeholder="Your name / role"
					.value=${this._bypassWho}
					@input=${(e: Event) => { this._bypassWho = (e.target as HTMLInputElement).value; }}
				/>
				<div class="flex items-center justify-end gap-2 mt-1">
					<button
						type="button"
						class="goal-widget-button goal-widget-button-neutral"
						?disabled=${loading}
						@click=${(e: MouseEvent) => { e.stopPropagation(); this._cancelBypassForm(); }}
						data-testid="goal-widget-bypass-cancel"
					>Cancel</button>
					<button
						type="button"
						class="goal-widget-button goal-widget-button-bypass"
						?disabled=${!canConfirm}
						@click=${(e: MouseEvent) => { e.stopPropagation(); void this._confirmBypass(gate); }}
						data-testid="goal-widget-bypass-confirm"
					>${loading ? icon(Loader2, "xs", "animate-spin") : icon(AlertTriangle, "xs")}<span>${loading ? "Bypassing…" : "Confirm bypass"}</span></button>
				</div>
			</div>
		`;
	}

	private _renderGateStatusIndicator(gate: GateSummary): TemplateResult {
		if (gate.status === "running" || this._activeGateIds.has(gate.id)) {
			return html`<span class="goal-widget-running-dot shrink-0" data-testid="goal-widget-gate-running-dot" aria-label="running"></span>`;
		}
		return renderGateStatusIcon(gate.status);
	}

	private _renderSignoffCard(req: SignoffRequest): TemplateResult {
		ensureMarkdownBlock();
		return html`
			<div class="border border-border rounded-md p-2 flex flex-col gap-1.5"
				data-testid="goal-widget-signoff"
				data-signal-id=${req.signalId}
				data-step-name=${req.stepName}>
				<div class="text-foreground font-medium" style="font-size:13px">${req.label}</div>
				${req.prompt ? html`
					<div class="text-muted-foreground" style="font-size:12px;max-height:160px;overflow-y:auto">
						<markdown-block .content=${req.prompt}></markdown-block>
					</div>
				` : nothing}
				<div class="flex items-center justify-end gap-2 mt-1">
					<signoff-review-launcher
						.target=${this._signoffReviewTarget(req)}
						button-class="goal-widget-button goal-widget-button-neutral"
						button-testid="goal-widget-signoff-content-toggle"
						error-testid="goal-widget-signoff-content-error"
						@signoff-review-launched=${() => this._closeDropdown()}
					></signoff-review-launcher>
				</div>
			</div>
		`;
	}

	render() {
		if (!this.goalId) return nothing;
		const passed = this._gates.filter(g => g.status === "passed").length;
		const total = this._gates.length;
		const awaiting = this._awaitingSignoffs.length > 0;
		const titleParts = [`Goal status: ${passed}/${total} gates passed`];
		if (awaiting) titleParts.push(`${this._awaitingSignoffs.length} awaiting sign-off`);
		const label = titleParts.join(" \u2014 ");
		return html`
			<button
				class="goal-status-pill inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-[12px] leading-tight"
				style="max-width:100%; height:var(--pill-h, auto)"
				title=${label}
				aria-label=${label}
				data-testid="goal-status-widget-pill"
				data-awaiting-signoffs=${awaiting ? "true" : "false"}
				@click=${this._togglePill}
			>
				<span class="shrink-0" style="display:inline-flex;align-items:center" data-testid="goal-status-widget-icon">
					${icon(GoalIcon, "xs")}
				</span>
				${awaiting ? html`<span class="goal-signoff-pulse shrink-0" data-testid="goal-status-widget-awaiting" aria-label="Awaiting human sign-off" title="Awaiting human sign-off">!</span>` : nothing}
				${renderGateProgressBadge(this.goalId)}
			</button>
		`;
	}

	private _ensureWidgetStyles(): void {
		if (typeof document === "undefined") return;
		let style = document.getElementById("goal-status-widget-styles") as HTMLStyleElement | null;
		if (!style) {
			style = document.createElement("style");
			style.id = "goal-status-widget-styles";
			document.head.appendChild(style);
		}
		// Always refresh the style text so Vite/HMR and session reloads cannot keep
		// a stale pre-alignment rule around under the same element id.
		style.textContent = `
			goal-status-widget,
			git-status-widget {
				display: inline-flex;
				align-items: center;
				height: var(--pill-h, auto);
				line-height: 1;
				vertical-align: middle;
			}
			goal-status-widget .goal-status-pill,
			git-status-widget .git-status-pill {
				box-sizing: border-box;
				align-items: center;
			}
			goal-status-widget .goal-status-pill > span {
				display: inline-flex;
				align-items: center;
				line-height: 12px;
			}
			goal-status-widget .goal-status-pill > span[title*="gates passed"],
			goal-status-widget .goal-status-pill > span[aria-label*="gates passed"] {
				height: 12px;
				transform: translateY(-0.5px);
			}
			git-status-widget .git-status-pill > span:not(:first-child) {
				transform: translateY(-0.5px);
			}
			goal-status-widget .goal-status-pill svg {
				display: block;
			}
			@keyframes goal-signoff-pulse-anim {
				0%, 100% { transform: scale(1); opacity: 1; }
				50%      { transform: scale(1.16); opacity: 0.72; }
			}
			.goal-signoff-pulse {
				width: 10px;
				height: 14px;
				color: var(--primary) !important;
				background: transparent;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				font-size: 14px;
				font-weight: 800;
				line-height: 14px;
				animation: goal-signoff-pulse-anim 1.4s ease-in-out infinite;
				pointer-events: none;
			}
			@keyframes goal-status-in {
				0%   { opacity: 0; transform: translateY(8px) scale(0.92); filter: blur(3px); }
				70%  { opacity: 1; transform: translateY(-1px) scale(1.005); filter: blur(0); }
				100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
			}
			@keyframes goal-status-out {
				0%   { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
				100% { opacity: 0; transform: translateY(6px) scale(0.95); filter: blur(2px); }
			}
			#goal-status-dropdown {
				animation: goal-status-in 240ms cubic-bezier(0.175, 0.885, 0.32, 1.275);
			}
			#goal-status-dropdown.goal-status-closing {
				animation: goal-status-out 180ms cubic-bezier(0.4, 0, 1, 1) forwards;
			}
			.goal-widget-button {
				display: inline-flex !important;
				align-items: center;
				justify-content: center;
				gap: 3px;
				height: 22px;
				min-height: 22px;
				box-sizing: border-box;
				padding: 1px 7px;
				border-radius: 4px;
				border: 1px solid var(--border);
				background: transparent;
				color: var(--muted-foreground);
				cursor: pointer;
				font-size: 12px;
				font-weight: 500;
				line-height: 1;
				white-space: nowrap;
				transition: background 150ms, border-color 150ms, color 150ms, opacity 150ms;
			}
			.goal-widget-button svg {
				width: 12px;
				height: 12px;
				flex-shrink: 0;
				display: block;
			}
			.goal-widget-button:disabled {
				cursor: wait;
				opacity: 0.65;
			}
			.goal-widget-button-neutral:hover:not(:disabled) {
				background: var(--accent, var(--secondary));
				color: var(--foreground);
			}
			.goal-widget-button-reset:hover:not(:disabled) {
				background: color-mix(in oklch, var(--negative, var(--destructive, #dc2626)) 10%, transparent);
				border-color: color-mix(in oklch, var(--negative, var(--destructive, #dc2626)) 40%, var(--border));
				color: var(--negative, var(--destructive, #dc2626));
			}
			.goal-widget-button-bypass {
				color: var(--warning, var(--negative, var(--destructive, #dc2626)));
				border-color: color-mix(in oklch, var(--warning, var(--negative, #dc2626)) 35%, var(--border));
			}
			.goal-widget-button-bypass:hover:not(:disabled) {
				background: color-mix(in oklch, var(--warning, var(--negative, #dc2626)) 12%, transparent);
				border-color: color-mix(in oklch, var(--warning, var(--negative, #dc2626)) 55%, var(--border));
				color: var(--warning, var(--negative, var(--destructive, #dc2626)));
			}
			.goal-widget-completed {
				display: inline-flex;
				align-items: center;
				gap: 4px;
				font-size: 12px;
				font-weight: 600;
				color: var(--positive, #22c55e);
				white-space: nowrap;
			}
			.goal-widget-bypass-caption {
				font-size: 11px;
				color: var(--muted-foreground);
				padding: 0 0 2px 20px;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.goal-widget-bypass-who {
				color: var(--foreground);
				font-weight: 600;
			}
			.goal-widget-bypass-form {
				display: flex;
				flex-direction: column;
				gap: 4px;
				padding: 8px;
				margin: 2px 0 4px;
				border: 1px solid color-mix(in oklch, var(--warning, var(--negative, #dc2626)) 35%, var(--border));
				border-radius: 6px;
				background: color-mix(in oklch, var(--warning, var(--negative, #dc2626)) 6%, transparent);
			}
			.goal-widget-bypass-warning {
				display: flex;
				align-items: flex-start;
				gap: 5px;
				font-size: 11px;
				color: var(--warning, var(--negative, var(--destructive, #dc2626)));
				line-height: 1.3;
			}
			.goal-widget-bypass-warning svg {
				width: 12px;
				height: 12px;
				flex-shrink: 0;
				margin-top: 1px;
			}
			.goal-widget-bypass-label {
				font-size: 11px;
				font-weight: 500;
				color: var(--muted-foreground);
			}
			.goal-widget-bypass-input {
				width: 100%;
				box-sizing: border-box;
				padding: 5px 7px;
				border: 1px solid var(--border);
				border-radius: 4px;
				background: var(--background);
				color: var(--foreground);
				font-size: 12px;
				font-family: inherit;
				resize: vertical;
			}
			.goal-widget-bypass-input:focus {
				outline: none;
				border-color: color-mix(in oklch, var(--warning, var(--negative, #dc2626)) 55%, var(--border));
			}
			@keyframes goal-widget-running-dot-pulse {
				0%, 100% { transform: scale(0.86); opacity: 0.55; box-shadow: 0 0 0 0 color-mix(in oklch, var(--info, #3b82f6) 36%, transparent); }
				50% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 4px color-mix(in oklch, var(--info, #3b82f6) 0%, transparent); }
			}
			.goal-widget-running-dot {
				width: 9px;
				height: 9px;
				margin: 0 1.5px;
				border-radius: 999px;
				background: var(--info, #3b82f6);
				animation: goal-widget-running-dot-pulse 1.25s ease-in-out infinite;
			}
			#goal-status-dropdown.goal-status-confirming {
				z-index: 40;
			}
			.goal-widget-gate-row {
				min-height: 26px;
				padding: 2px 0;
				flex-wrap: nowrap;
			}
			.goal-widget-gate-main {
				flex: 1 1 auto;
				min-width: 0;
			}
			.goal-widget-gate-actions {
				display: inline-flex;
				align-items: center;
				gap: 4px;
				margin-left: auto;
				flex: 0 0 auto;
			}
			.goal-widget-gate-error {
				flex: 0 1 auto;
				min-width: 0;
				font-size: 11px;
				color: var(--negative, var(--destructive, var(--foreground)));
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}
			@media (max-width: 420px) {
				.goal-widget-gate-row {
					align-items: stretch;
				}
				.goal-widget-button {
					padding: 1px 6px;
				}
				.goal-widget-gate-main {
					flex-basis: auto;
				}
				.goal-widget-gate-actions {
					width: auto;
					margin-left: auto;
				}
				.goal-widget-gate-action {
					flex: 1 1 0;
				}
			}
		`;
	}
}
