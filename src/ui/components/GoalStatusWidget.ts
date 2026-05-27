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
 *   - Inline sign-off cards: label + substituted prompt (markdown), signal
 *     content toggle, Approve and Reject buttons.
 *   - Reject opens a modal with a feedback textarea + Submit; on submit, POSTs
 *     `decision: "fail", feedback` to the sign-off endpoint.
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
import { LayoutDashboard } from "lucide";
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

interface ResolvedSignoff {
	decision: "pass" | "fail";
	feedback?: string;
	resolvedAt: number;
}

/** Stable key for a pending sign-off in the resolved map. */
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
	/** Optimistic local resolution map keyed by `signalId::stepName`.
	 *  Lets the popover show "Approved ✓"/"Rejected ✗" inline before the
	 *  WS resolution event lands. Cleared when the server-side step_complete
	 *  event removes the entry from `_awaitingSignoffs`. */
	@state() private _resolved: Map<string, ResolvedSignoff> = new Map();
	@state() private _loading = true;
	@state() private _expanded = false;
	@state() private _rejectFor: SignoffRequest | null = null;
	@state() private _rejectText = "";
	@state() private _rejectSubmitting = false;
	@state() private _rejectError = "";
	@state() private _submitting: Set<string> = new Set();
	@state() private _submitErrors: Map<string, string> = new Map();
	@state() private _contentExpanded: Set<string> = new Set();
	@state() private _contentLoading: Set<string> = new Set();
	@state() private _contentByKey: Map<string, string> = new Map();
	@state() private _contentErrors: Map<string, string> = new Map();
	@state() private _closing = false;

	private _ws: WebSocket | null = null;
	private _wsIntentionalClose = false;
	private _wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _dropdownEl: HTMLElement | null = null;
	private _modalEl: HTMLElement | null = null;
	private _closeToken = 0;
	private _onHashChange = () => {
		if (this._expanded) this._closeDropdown();
		if (this._modalEl) this._closeRejectModal();
	};

	private _onDocumentClick = (e: MouseEvent) => {
		const target = e.target as Node;
		if (this._expanded && !this._closing && !this.contains(target) && !this._dropdownEl?.contains(target) && !this._modalEl?.contains(target)) {
			this._closeDropdown();
		}
	};

	private _onEscapeKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return;
		if (this._modalEl) {
			e.stopPropagation();
			this._closeRejectModal();
			return;
		}
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
		this._removeRejectModal();
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
			this._resolved.clear();
			this._contentExpanded = new Set();
			this._contentLoading = new Set();
			this._contentByKey = new Map();
			this._contentErrors = new Map();
			this._loading = true;
			this._disconnectWs();
			if (this.goalId) {
				void this._fetchInitial();
				this._connectWs();
			}
		}
		if (changed.has("_expanded") || changed.has("_gates") || changed.has("_awaitingSignoffs") || changed.has("_resolved") || changed.has("_submitting") || changed.has("_submitErrors") || changed.has("_contentExpanded") || changed.has("_contentLoading") || changed.has("_contentByKey") || changed.has("_contentErrors") || changed.has("_rejectFor") || changed.has("_rejectText") || changed.has("_rejectSubmitting") || changed.has("_rejectError")) {
			this._syncDropdown();
			this._syncRejectModal();
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

	private _toggleSignoffContent(req: SignoffRequest): void {
		const key = signoffKey(req);
		const expanded = new Set(this._contentExpanded);
		if (expanded.has(key)) {
			expanded.delete(key);
			this._contentExpanded = expanded;
			return;
		}
		expanded.add(key);
		this._contentExpanded = expanded;
		if (!this._contentByKey.has(key) && !this._contentLoading.has(key)) {
			void this._fetchSignoffContent(req);
		}
	}

	private async _fetchSignoffContent(req: SignoffRequest): Promise<void> {
		const key = signoffKey(req);
		const loading = new Set(this._contentLoading); loading.add(key); this._contentLoading = loading;
		const errors = new Map(this._contentErrors); errors.delete(key); this._contentErrors = errors;
		try {
			const resp = await this._fetch(`/api/goals/${this.goalId}/gates/${encodeURIComponent(req.gateId)}/signals`);
			if (!resp?.ok) throw new Error(`Unable to load signal content (${resp?.status ?? "network"})`);
			const data = await resp.json().catch(() => null);
			const signals = Array.isArray(data?.signals) ? data.signals : [];
			const signal = signals.find((s: unknown) => !!s && typeof s === "object" && (s as Record<string, unknown>).id === req.signalId) as Record<string, unknown> | undefined;
			const content = typeof signal?.content === "string" && signal.content.trim()
				? signal.content
				: "No content was attached to this sign-off signal.";
			const next = new Map(this._contentByKey); next.set(key, content); this._contentByKey = next;
		} catch (err) {
			const next = new Map(this._contentErrors);
			next.set(key, err instanceof Error ? err.message : "Unable to load signal content");
			this._contentErrors = next;
		} finally {
			const next = new Set(this._contentLoading); next.delete(key); this._contentLoading = next;
		}
	}

	// ── Sign-off POST ────────────────────────────────────────────────

	private async _submitSignoff(req: SignoffRequest, decision: "pass" | "fail", feedback?: string): Promise<boolean> {
		const key = signoffKey(req);
		const next = new Set(this._submitting); next.add(key); this._submitting = next;
		const errMap = new Map(this._submitErrors); errMap.delete(key); this._submitErrors = errMap;
		try {
			const resp = await this._fetch(
				`/api/goals/${this.goalId}/gates/${encodeURIComponent(req.gateId)}/signoff`,
				{
					method: "POST",
					body: JSON.stringify({ signalId: req.signalId, stepName: req.stepName, decision, ...(feedback ? { feedback } : {}) }),
				},
			);
			if (!resp || !resp.ok) {
				let msg = `Sign-off failed${resp?.status ? ` (${resp.status})` : ""}`;
				try {
					const body = await resp?.json();
					if (body?.error) msg = String(body.error);
				} catch { /* ignore */ }
				const e2 = new Map(this._submitErrors); e2.set(key, msg); this._submitErrors = e2;
				return false;
			}
			// Optimistic resolved state — popover shows ✓/✗ inline. The
			// awaiting entry is removed when the server's step_complete WS
			// event lands and `_refreshActive` drops it from the list. We
			// also fire an explicit refetch here as a belt-and-braces measure
			// so the awaiting state clears even when the WS connection is
			// momentarily down or routed through a mock (E2E tests).
			const resolved = new Map(this._resolved);
			resolved.set(key, { decision, feedback, resolvedAt: Date.now() });
			this._resolved = resolved;
			void this._refreshActive();
			return true;
		} catch (err) {
			const e2 = new Map(this._submitErrors); e2.set(key, String(err)); this._submitErrors = e2;
			return false;
		} finally {
			const submitting = new Set(this._submitting); submitting.delete(key); this._submitting = submitting;
		}
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

	// ── Reject modal ─────────────────────────────────────────────────

	private _openRejectModal(req: SignoffRequest) {
		this._rejectFor = req;
		this._rejectText = "";
		this._rejectError = "";
	}

	private _closeRejectModal() {
		this._rejectFor = null;
		this._rejectText = "";
		this._rejectError = "";
		this._rejectSubmitting = false;
		this._removeRejectModal();
	}

	private _removeRejectModal() {
		if (this._modalEl) {
			this._modalEl.remove();
			this._modalEl = null;
		}
	}

	private _syncRejectModal(): void {
		if (this._rejectFor) {
			if (!this._modalEl) {
				this._modalEl = document.createElement("div");
				this._modalEl.id = "goal-status-reject-modal";
				document.body.appendChild(this._modalEl);
				// Autofocus the textarea after first paint.
				requestAnimationFrame(() => {
					this._modalEl?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
				});
			}
			render(this._renderRejectModalContent(), this._modalEl);
		} else {
			this._removeRejectModal();
		}
	}

	private async _submitReject() {
		if (!this._rejectFor) return;
		const trimmed = this._rejectText.trim();
		if (!trimmed) return;
		this._rejectSubmitting = true;
		this._rejectError = "";
		const ok = await this._submitSignoff(this._rejectFor, "fail", trimmed);
		this._rejectSubmitting = false;
		if (ok) {
			this._closeRejectModal();
		} else {
			const key = signoffKey(this._rejectFor);
			this._rejectError = this._submitErrors.get(key) || "Submission failed";
		}
	}

	// ── Render ───────────────────────────────────────────────────────

	private _renderDropdownContent(): TemplateResult {
		const live = this._awaitingSignoffs;
		const resolvedList: SignoffRequest[] = [];
		// Surface resolved-but-not-yet-cleared entries so the user sees the
		// transition without the card vanishing mid-render. We hold the row
		// for as long as the resolved map has the key (cleared on next
		// `_refreshActive` when the awaiting entry is gone).
		for (const [key, r] of this._resolved) {
			if (!live.some(l => signoffKey(l) === key)) {
				// Reconstruct a minimal record for display by parsing the key.
				// signoffKey format is `${signalId}::${stepName}` — split on the
				// FIRST `::` only so step names containing `::` survive.
				const sepIdx = key.indexOf("::");
				const signalId = sepIdx >= 0 ? key.slice(0, sepIdx) : key;
				const stepName = sepIdx >= 0 ? key.slice(sepIdx + 2) : "";
				resolvedList.push({ signalId, stepName, gateId: "", label: stepName, prompt: r.feedback ?? "" });
			}
		}

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

			${resolvedList.length > 0 ? html`
				<div class="border-t border-border pt-2 mt-2 flex flex-col gap-1" data-testid="goal-widget-signoffs-resolved">
					${resolvedList.map(r => {
						const key = signoffKey(r);
						const res = this._resolved.get(key)!;
						return html`
							<div class="flex items-center gap-2 text-muted-foreground" style="font-size:12px" data-testid="goal-widget-signoff-resolved" data-step-name=${r.stepName}>
								<span class="${res.decision === "pass" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}" style="font-weight:600">
									${res.decision === "pass" ? "Approved \u2713" : "Rejected \u2717"}
								</span>
								<span class="truncate" title=${r.stepName}>${r.stepName}</span>
							</div>
						`;
					})}
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
		const submitting = this._submitting.has(key);
		const resolved = this._resolved.get(key);
		const err = this._submitErrors.get(key);
		const contentExpanded = this._contentExpanded.has(key);
		const contentLoading = this._contentLoading.has(key);
		const content = this._contentByKey.get(key);
		const contentError = this._contentErrors.get(key);
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
				<div class="flex items-center justify-between gap-2 mt-1">
					<button
						class="hover:bg-secondary/80"
						style="font-size:12px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--foreground);cursor:pointer;font-weight:500"
						@click=${(e: MouseEvent) => { e.stopPropagation(); this._toggleSignoffContent(req); }}
						data-testid="goal-widget-signoff-content-toggle"
					>${contentExpanded ? "Hide content" : "View content"}</button>
					${!resolved ? html`
						<div class="flex items-center gap-2">
							<button
								class="hover:bg-green-100 dark:hover:bg-green-900/20"
								style="font-size:12px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.68 0.12 145 / 0.12);color:oklch(0.68 0.12 145);cursor:pointer;font-weight:500"
								?disabled=${submitting}
								@click=${(e: MouseEvent) => { e.stopPropagation(); void this._submitSignoff(req, "pass"); }}
								data-testid="goal-widget-approve"
							>${submitting ? "Approving\u2026" : "Approve"}</button>
							<button
								class="hover:bg-red-100 dark:hover:bg-red-900/20"
								style="font-size:12px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.62 0.14 25 / 0.12);color:oklch(0.62 0.14 25);cursor:pointer;font-weight:500"
								?disabled=${submitting}
								@click=${(e: MouseEvent) => { e.stopPropagation(); this._openRejectModal(req); }}
								data-testid="goal-widget-reject"
							>Reject\u2026</button>
						</div>
					` : nothing}
				</div>
				${contentExpanded ? html`
					<div class="border border-border rounded-md bg-background p-2 text-foreground" style="font-size:12px;max-height:220px;overflow:auto" data-testid="goal-widget-signoff-content">
						${contentLoading ? html`<div class="text-muted-foreground">Loading content\u2026</div>`
							: contentError ? html`<div style="color:var(--destructive)">${contentError}</div>`
							: html`<markdown-block .content=${content || ""}></markdown-block>`}
					</div>
				` : nothing}
				${resolved ? html`
					<div class="${resolved.decision === "pass" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}" style="font-size:12px;font-weight:600">
						${resolved.decision === "pass" ? "Approved \u2713" : "Rejected \u2717"}
						${resolved.feedback ? html`<div class="text-muted-foreground mt-1" style="font-weight:400;white-space:pre-wrap">${resolved.feedback}</div>` : nothing}
					</div>
				` : nothing}
				${err && !resolved ? html`<div style="font-size:11px;color:var(--destructive)">${err}</div>` : nothing}
			</div>
		`;
	}

	private _renderRejectModalContent(): TemplateResult {
		const req = this._rejectFor;
		if (!req) return html``;
		const canSubmit = this._rejectText.trim().length > 0 && !this._rejectSubmitting;
		return html`
			<div style="position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:24px"
				@click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this._closeRejectModal(); }}>
				<div style="position:absolute;inset:0;background:rgba(0,0,0,0.5)" @click=${() => this._closeRejectModal()}></div>
				<div style="position:relative;width:100%;max-width:480px;display:flex;flex-direction:column;background:var(--card);color:var(--foreground);border:1px solid var(--border);border-radius:8px;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25)">
					<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border)">
						<span class="text-sm font-medium">Reject sign-off: ${req.label}</span>
						<button
							style="background:none;border:none;color:var(--muted-foreground);cursor:pointer;padding:4px 8px;font-size:18px;line-height:1;border-radius:4px"
							class="hover:text-foreground"
							@click=${() => this._closeRejectModal()}
							title="Close"
						>&times;</button>
					</div>
					<div style="padding:14px 16px;display:flex;flex-direction:column;gap:8px">
						<label class="text-muted-foreground" style="font-size:12px" for="goal-widget-reject-textarea">Feedback</label>
						<textarea
							id="goal-widget-reject-textarea"
							aria-label="Rejection feedback"
							data-testid="goal-widget-reject-textarea"
							class="w-full"
							style="min-height:120px;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--background);color:var(--foreground);font-size:13px;resize:vertical"
							.value=${this._rejectText}
							@input=${(e: Event) => { this._rejectText = (e.target as HTMLTextAreaElement).value; }}
							?disabled=${this._rejectSubmitting}
						></textarea>
						${this._rejectError ? html`<div style="font-size:12px;color:var(--destructive)">${this._rejectError}</div>` : nothing}
						<div class="flex items-center gap-2 justify-end mt-1">
							<button
								style="font-size:12px;padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--foreground);cursor:pointer"
								@click=${() => this._closeRejectModal()}
								?disabled=${this._rejectSubmitting}
							>Cancel</button>
							<button
								data-testid="goal-widget-reject-submit"
								style="font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid var(--border);background:oklch(0.62 0.14 25 / 0.12);color:oklch(0.62 0.14 25);cursor:pointer;font-weight:500;${canSubmit ? "" : "opacity:0.5;cursor:not-allowed"}"
								?disabled=${!canSubmit}
								@click=${() => void this._submitReject()}
							>${this._rejectSubmitting ? "Submitting\u2026" : "Submit"}</button>
						</div>
					</div>
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
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
				</span>
				${awaiting ? html`<span class="goal-signoff-pulse shrink-0" data-testid="goal-status-widget-awaiting" aria-label="Awaiting human sign-off" title="Awaiting human sign-off">!</span>` : nothing}
				${renderGateProgressBadge(this.goalId)}
			</button>
		`;
	}

	private _ensureWidgetStyles(): void {
		if (typeof document === "undefined") return;
		if (document.getElementById("goal-status-widget-styles")) return;
		const style = document.createElement("style");
		style.id = "goal-status-widget-styles";
		style.textContent = `
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
		document.head.appendChild(style);
	}
}
