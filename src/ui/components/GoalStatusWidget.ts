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
 *   - Inline sign-off cards: label + substituted prompt (markdown), View content
 *     launcher for the review pane.
 *   - Goal Dashboard icon button at the bottom.
 *
 * Data:
 *   - Initial: `GET /api/goals/:id/gates` and `GET /api/goals/:id/verifications/active`.
 *   - Live: viewer WebSocket subscription on `gate_signal_received`,
 *     `gate_status_changed`, `gate_verification_step_started`,
 *     `gate_verification_step_complete`, `gate_verification_phase_started`,
 *     `gate_verification_complete`, and the new `gate_verification_awaiting_human`.
 *
 * Authz: trusts the gateway token (v1 — no identity model). Sign-off submission
 * records only a server-side timestamp.
 */
import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing, render, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Goal as GoalIcon, LayoutDashboard } from "lucide";
import { ensureMarkdownBlock } from "../lazy/markdown-block.js";
import { renderGateProgressBadge, renderGateStatusIcon } from "../../app/render-helpers.js";
import { setHashRoute } from "../../app/routing.js";

type GateStatus = "pending" | "passed" | "failed" | "running";

interface GateSummary {
	id: string;
	name: string;
	status: GateStatus;
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
	@state() private _loading = true;
	@state() private _expanded = false;
	@state() private _reviewLaunchLoading: Set<string> = new Set();
	@state() private _reviewLaunchErrors: Map<string, string> = new Map();
	@state() private _closing = false;

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
		this._ensureWidgetStyles();
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
			this._reviewLaunchLoading = new Set();
			this._reviewLaunchErrors = new Map();
			this._loading = true;
			this._disconnectWs();
			if (this.goalId) {
				void this._fetchInitial();
				this._connectWs();
			}
		}
		if (changed.has("_expanded") || changed.has("_gates") || changed.has("_awaitingSignoffs") || changed.has("_reviewLaunchLoading") || changed.has("_reviewLaunchErrors")) {
			this._syncDropdown();
		}
	}

	// ── Data fetch ───────────────────────────────────────────────────

	private async _fetchInitial(): Promise<void> {
		this._loading = true;
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
				if (data?.verifications) this._awaitingSignoffs = this._extractSignoffs(data.verifications);
			}
		} catch {
			// non-fatal — WS events will rehydrate
		}
		this._loading = false;
	}

	private async _refreshGates(): Promise<void> {
		try {
			const resp = await this._fetch(`/api/goals/${this.goalId}/gates`);
			if (!resp?.ok) return;
			const data = await resp.json().catch(() => null);
			if (data?.gates) this._gates = this._normalizeGates(data.gates);
		} catch { /* non-fatal */ }
	}

	private async _refreshActive(): Promise<void> {
		try {
			const resp = await this._fetch(`/api/goals/${this.goalId}/verifications/active`);
			if (!resp?.ok) return;
			const data = await resp.json().catch(() => null);
			if (data?.verifications) this._awaitingSignoffs = this._extractSignoffs(data.verifications);
		} catch { /* non-fatal */ }
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
				: "pending";
			out.push({ id, name, status });
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
		switch (t) {
			case "gate_signal_received":
			case "gate_status_changed":
			case "gate_verification_complete":
			case "gate_verification_phase_started":
				void this._refreshGates();
				void this._refreshActive();
				break;
			case "gate_verification_step_started":
			case "gate_verification_step_complete":
				void this._refreshActive();
				if (t === "gate_verification_step_complete") void this._refreshGates();
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

	// ── Sign-off content ──────────────────────────────────────────────

	private async _openSignoffContentInReviewPane(req: SignoffRequest): Promise<void> {
		const key = signoffKey(req);
		const loading = new Set(this._reviewLaunchLoading); loading.add(key); this._reviewLaunchLoading = loading;
		const errors = new Map(this._reviewLaunchErrors); errors.delete(key); this._reviewLaunchErrors = errors;
		try {
			const resp = await this._fetch(`/api/goals/${this.goalId}/gates/${encodeURIComponent(req.gateId)}/signals`);
			if (!resp?.ok) throw new Error(`Unable to load signal content (${resp?.status ?? "network"})`);
			const data = await resp.json().catch(() => null);
			const signals = Array.isArray(data?.signals) ? data.signals : [];
			const signal = signals.find((s: unknown) => !!s && typeof s === "object" && (s as Record<string, unknown>).id === req.signalId) as Record<string, unknown> | undefined;
			if (!signal) throw new Error("Signal content is no longer available");
			const markdown = typeof signal.content === "string" && signal.content.trim()
				? signal.content
				: "No content was attached to this sign-off signal.";
			const goalTitle = this._reviewGoalTitle();
			const gateName = this._gateName(req.gateId);
			const title = this._reviewDocumentTitle(req, goalTitle, gateName);
			window.dispatchEvent(new CustomEvent("bobbit-open-review-document", {
				detail: {
					title,
					markdown,
					source: {
						kind: "verification-signoff-markdown",
						goalId: this.goalId,
						gateId: req.gateId,
						signalId: req.signalId,
						stepName: req.stepName,
						goalTitle,
						gateName,
						stepLabel: req.label,
					},
				},
			}));
			this._closeDropdown();
		} catch (err) {
			const next = new Map(this._reviewLaunchErrors);
			next.set(key, err instanceof Error ? err.message : "Unable to open review document");
			this._reviewLaunchErrors = next;
		} finally {
			const next = new Set(this._reviewLaunchLoading); next.delete(key); this._reviewLaunchLoading = next;
		}
	}

	private _gateName(gateId: string): string {
		return this._gates.find(g => g.id === gateId)?.name || gateId;
	}

	private _reviewGoalTitle(): string {
		return this.branch || this.goalId || "Goal";
	}

	private _reviewDocumentTitle(req: SignoffRequest, goalTitle: string, gateName: string): string {
		const base = `Sign-off: ${goalTitle} / ${gateName} / ${req.label || req.stepName}`;
		const duplicateCount = this._awaitingSignoffs.filter(s => this._gateName(s.gateId) === gateName && (s.label || s.stepName) === (req.label || req.stepName)).length;
		return duplicateCount > 1 ? `${base} (${req.signalId.slice(0, 8)})` : base;
	}

	// ── Pill toggle ──────────────────────────────────────────────────

	private _togglePill(e: MouseEvent) {
		e.stopPropagation();
		if (this._expanded && !this._closing) {
			this._closeDropdown();
		} else {
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

	// ── Render ───────────────────────────────────────────────────────

	private _renderDropdownContent(): TemplateResult {
		const live = this._awaitingSignoffs;
		return html`
			<div class="flex items-center gap-1.5 mb-2 text-foreground font-medium text-sm">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
				<span>Goal status</span>
				${renderGateProgressBadge(this.goalId)}
			</div>

			${this._gates.length === 0
				? html`<div class="text-muted-foreground" style="font-size:12px">${this._loading ? "Loading gates\u2026" : "No gates"}</div>`
				: html`
					<div class="flex flex-col gap-1 mb-2" data-testid="goal-widget-gates">
						${this._gates.map(g => html`
							<div class="flex items-center gap-2" data-testid="goal-widget-gate" data-gate-id=${g.id} data-gate-status=${g.status}>
								${renderGateStatusIcon(g.status)}
								<span class="truncate text-foreground" title=${g.name}>${g.name}</span>
							</div>
						`)}
					</div>
				`}

			${live.length > 0 ? html`
				<div class="border-t border-border pt-2 mt-2 flex flex-col gap-2" data-testid="goal-widget-signoffs">
					<div class="text-muted-foreground" style="font-size:12px;font-weight:500">Awaiting sign-off</div>
					${live.map(req => this._renderSignoffCard(req))}
				</div>
			` : nothing}

			<div class="border-t border-border pt-2 mt-2 flex justify-end">
				<button
					class="inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/80"
					style="font-size:12px;border:1px solid var(--border);background:transparent;cursor:pointer;padding:3px 8px"
					@click=${(e: MouseEvent) => { e.stopPropagation(); this._closeDropdown(); setHashRoute("goal-dashboard", this.goalId); }}
					data-testid="goal-widget-dashboard-link"
					title="Goal dashboard"
				>${icon(LayoutDashboard, "xs")}<span>Goal Dashboard</span></button>
			</div>
		`;
	}

	private _renderSignoffCard(req: SignoffRequest): TemplateResult {
		ensureMarkdownBlock();
		const key = signoffKey(req);
		const launchLoading = this._reviewLaunchLoading.has(key);
		const launchError = this._reviewLaunchErrors.get(key);
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
				<div class="flex items-center gap-2 mt-1">
					<button
						class="hover:bg-secondary/80"
						style="font-size:12px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--foreground);cursor:${launchLoading ? "wait" : "pointer"};font-weight:500;${launchLoading ? "opacity:0.7" : ""}"
						?disabled=${launchLoading}
						@click=${(e: MouseEvent) => { e.stopPropagation(); void this._openSignoffContentInReviewPane(req); }}
						data-testid="goal-widget-signoff-content-toggle"
					>${launchLoading ? "Opening…" : "View content"}</button>
				</div>
				${launchError ? html`<div style="font-size:11px;color:var(--destructive)" data-testid="goal-widget-signoff-content-error">${launchError}</div>` : nothing}
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
		return html`
			<button
				class="goal-status-pill inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-[12px] leading-tight"
				style="max-width:100%; height:var(--pill-h, auto)"
				title=${titleParts.join(" \u2014 ")}
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
			goal-status-widget .goal-status-pill > span[title*="gates passed"] {
				height: 12px;
				transform: translateY(-1px);
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
		`;
	}
}
