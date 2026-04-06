import { html, LitElement, nothing, render as litRender } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { customElement, property, state } from "lit/decorators.js";
import { ansiToHtml, hasAnsi } from "../utils/ansi.js";

export interface BgProcessInfo {
	id: string;
	/** Short human-readable name (max 3 words, agent-generated) */
	name: string;
	command: string;
	pid: number;
	status: "running" | "exited";
	exitCode: number | null;
	startTime: number;
}

/**
 * Renders a small pill for each background process. Clicking opens a log popup.
 * Provides a kill button for running processes.
 */
@customElement("bg-process-pill")
export class BgProcessPill extends LitElement {
	@property({ attribute: false }) process!: BgProcessInfo;
	@property() sessionId = "";
	@property({ attribute: false }) onKill?: (id: string) => void;
	@property({ attribute: false }) onDismiss?: (id: string) => void;

	@state() private expanded = false;
	@state() private logs: { ts: number; text: string }[] = [];
	@state() private loadingLogs = false;
	/** Timestamp of the latest log entry from the initial fetch — used to dedupe WS events */
	private _fetchedUpTo = 0;

	createRenderRoot() {
		return this;
	}

	/** When true, the dropdown plays the close animation before being removed */
	@state() private _closing = false;

	/** Portal element appended to document.body for the dropdown */
	private _portalEl: HTMLDivElement | null = null;

	private _onDocumentClick = (e: MouseEvent) => {
		if (this.expanded && !this._closing && !this.contains(e.target as Node) && !this._portalEl?.contains(e.target as Node)) {
			this._closeDropdown();
		}
	};

	private _onEscapeKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" && this.expanded && !this._closing) {
			e.stopPropagation();
			this._closeDropdown();
		}
	};

	connectedCallback() {
		super.connectedCallback();
		this.style.display = 'inline-flex';
		this.style.alignItems = 'center';
		this.style.position = 'relative';
		this.style.top = '1px';
		document.addEventListener("click", this._onDocumentClick, true);
		document.addEventListener("keydown", this._onEscapeKey, true);
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("click", this._onDocumentClick, true);
		document.removeEventListener("keydown", this._onEscapeKey, true);
		this._removePortal();
	}

	private _removePortal() {
		if (this._portalEl) {
			this._portalEl.remove();
			this._portalEl = null;
		}
	}

	private _closeDropdown() {
		this._closing = true;
		this._renderPortal();
		const dropdown = this._portalEl?.querySelector("#bg-process-dropdown") as HTMLElement;
		if (dropdown) {
			dropdown.addEventListener("animationend", () => {
				this._closing = false;
				this.expanded = false;
				this._removePortal();
			}, { once: true });
		} else {
			this._closing = false;
			this.expanded = false;
			this._removePortal();
		}
	}

	private async _toggle(e: MouseEvent) {
		e.stopPropagation();
		if (this.expanded && !this._closing) {
			this._closeDropdown();
		} else if (!this.expanded) {
			this.expanded = true;
			await this._fetchLogs();
		}
	}

	/** Called externally when a bg_process_output WS event arrives. */
	appendOutput(text: string, ts?: number) {
		if (this._fetchedUpTo > 0) {
			// Skip lines already covered by the initial fetch
			const timestamp = ts || Date.now();
			if (timestamp <= this._fetchedUpTo) return;
		}
		const timestamp = ts || Date.now();
		const lines = text.split("\n").filter((l) => l.length > 0);
		if (lines.length === 0) return;
		this.logs = [...this.logs, ...lines.map((l) => ({ ts: timestamp, text: l }))];
		if (this.expanded && this._portalEl) {
			this._renderPortal();
		}
		this.updateComplete.then(() => this._scrollToBottom());
	}

	private async _fetchLogs() {
		if (!this.sessionId || !this.process) return;
		this.loadingLogs = true;
		try {
			const url = localStorage.getItem("gateway.url") || window.location.origin;
			const token = localStorage.getItem("gateway.token") || "";
			const res = await fetch(`${url}/api/sessions/${this.sessionId}/bg-processes/${this.process.id}/logs?tail=100`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (res.ok) {
				const data = await res.json();
				this.logs = (data.log || []).map((e: any) =>
					typeof e === "string" ? { ts: 0, text: e } : e
				);
				if (this.logs.length > 0) {
					this._fetchedUpTo = this.logs[this.logs.length - 1].ts;
				}
			}
		} catch { /* ignore */ } finally {
			this.loadingLogs = false;
			await this.updateComplete;
			this._scrollToBottom();
		}
	}

	private _kill = (e: MouseEvent) => {
		e.stopPropagation();
		if (this.onKill) this.onKill(this.process.id);
	};

	private _dismiss = (e: MouseEvent) => {
		e.stopPropagation();
		if (this.onDismiss) this.onDismiss(this.process.id);
	};

	private _fmtTime(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	}

	private _scrollToBottom() {
		const el = this._portalEl?.querySelector("#bg-log-output");
		if (el) el.scrollTop = el.scrollHeight;
	}

	private _displayName(): string {
		return this.process.name || this.process.id;
	}

	private _statusIndicator() {
		const p = this.process;
		const isRunning = p.status === "running";
		return isRunning
			? html`<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-600 dark:bg-blue-400 animate-pulse shrink-0"></span>`
			: p.exitCode === 0
				? html`<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-600 dark:bg-green-400 shrink-0"></span>`
				: p.exitCode !== null
					? html`<span class="shrink-0 text-red-600 dark:text-red-400" style="font-size:10px;line-height:1;font-weight:700">!</span>`
					: html`<span class="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground shrink-0"></span>`;
	}

	private _dropdownTemplate() {
		const p = this.process;
		const isRunning = p.status === "running";
		const statusIndicator = this._statusIndicator();
		return html`
			<style>
				@keyframes bg-dropdown-in {
					0%   { opacity: 0; transform: translateY(8px) scale(0.92); filter: blur(3px); }
					70%  { opacity: 1; transform: translateY(-1px) scale(1.005); filter: blur(0); }
					100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
				}
				@keyframes bg-dropdown-out {
					0%   { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
					100% { opacity: 0; transform: translateY(6px) scale(0.95); filter: blur(2px); }
				}
				#bg-process-dropdown {
					animation: bg-dropdown-in 300ms cubic-bezier(0.175, 0.885, 0.32, 1.275);
				}
				#bg-process-dropdown.closing {
					animation: bg-dropdown-out 200ms cubic-bezier(0.4, 0, 1, 1) forwards;
				}
			</style>
			<div
				class="fixed z-50 bg-card border border-border rounded-lg shadow-lg p-2 text-xs ${this._closing ? 'closing' : ''}"
				style="max-width:calc(100vw - 1rem); width: min(900px, calc(100vw - 1rem));"
				id="bg-process-dropdown"
			>
				<div class="flex items-center justify-between mb-1.5">
					<div class="flex items-center gap-1.5 text-foreground font-medium text-sm min-w-0">
						${statusIndicator}
						<span class="truncate font-mono">${this._displayName()}</span>
						<span class="text-[10px] text-muted-foreground font-normal">${p.id} · pid ${p.pid}</span>
					</div>
					<div class="flex items-center gap-2">
						${!isRunning && p.exitCode !== null
							? html`<span class="font-mono text-sm font-semibold ${p.exitCode === 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}">exit ${p.exitCode}</span>`
							: nothing}
						${isRunning
							? html`<button
								class="px-2 py-0.5 rounded text-[11px] bg-red-500/20 text-red-700 dark:text-red-400 hover:bg-red-500/30 transition-colors"
								@click=${this._kill}
							>Kill</button>`
							: html`<button
								class="px-2 py-0.5 rounded text-[11px] bg-muted text-muted-foreground hover:text-foreground transition-colors"
								@click=${this._dismiss}
							>Remove</button>`}
					</div>
				</div>

				<div class="text-muted-foreground mb-1.5 font-mono text-[11px] break-all leading-tight">${p.command}</div>

				${this.loadingLogs
					? html`<div class="text-muted-foreground animate-pulse">Loading...</div>`
					: html`<div class="h-[180px] overflow-y-auto bg-background text-foreground rounded px-2 py-1.5 font-mono text-[11px] leading-snug break-all" id="bg-log-output">${this.logs.length > 0
								? this.logs.map((entry) => html`<div class="whitespace-pre-wrap">${entry.ts
									? html`<span class="text-muted-foreground select-none">${this._fmtTime(entry.ts)} </span>`
									: nothing}${hasAnsi(entry.text) ? unsafeHTML(ansiToHtml(entry.text)) : entry.text}</div>`)
								: html`<div class="text-muted-foreground text-center py-1">(no output yet)</div>`}</div>
				`}
			</div>
		`;
	}

	private _renderPortal() {
		if (!this._portalEl) {
			this._portalEl = document.createElement('div');
			document.body.appendChild(this._portalEl);
		}
		litRender(this._dropdownTemplate(), this._portalEl);
	}

	render() {
		if (!this.process) return nothing;
		const p = this.process;
		const isRunning = p.status === "running";
		const statusIndicator = this._statusIndicator();

		return html`
			<span class="inline-flex items-center rounded-full bg-card border border-border text-[11px] leading-tight" style="max-width:200px; height:var(--pill-h, auto)">
				<button
					class="inline-flex items-center gap-1 px-1.5 py-0.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded-l-full"
					@click=${this._toggle}
					title="${p.command}"
				>
					${statusIndicator}
					<span class="truncate font-mono">${this._displayName()}</span>
				</button>
				<button
					class="inline-flex items-center justify-center px-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer rounded-r-full border-l border-border"
					style="font-size:10px; line-height:1; min-width:16px; align-self:stretch"
					@click=${isRunning ? this._kill : this._dismiss}
					title=${isRunning ? "Kill process" : "Remove"}
				>✕</button>
			</span>
		`;
	}

	override updated(changed: Map<string, unknown>) {
		super.updated(changed);
		if (changed.has("expanded")) {
			if (this.expanded) {
				this._renderPortal();
				this._positionDropdown();
			} else if (!this._closing) {
				this._removePortal();
			}
		} else if (this.expanded && this._portalEl && (changed.has("loadingLogs") || changed.has("logs"))) {
			// Re-render portal when log state changes — portal content is outside
			// Lit's render tree so @state() changes don't automatically propagate.
			this._renderPortal();
		}
	}

	private _positionDropdown() {
		const btn = this.querySelector("button");
		const dropdown = this._portalEl?.querySelector("#bg-process-dropdown") as HTMLElement;
		if (!btn || !dropdown) return;
		const rect = btn.getBoundingClientRect();
		const pad = 8;
		const vw = window.innerWidth;

		// Let the dropdown render to get its actual width
		const dropWidth = dropdown.offsetWidth;

		// Horizontal: try to align left edge with button, but clamp to viewport
		let left = rect.left;
		if (left + dropWidth > vw - pad) {
			left = vw - dropWidth - pad;
		}
		if (left < pad) left = pad;

		// Vertical: prefer above the button, fall back to below if not enough space
		const bottom = window.innerHeight - rect.top + 4;
		if (rect.top < dropdown.offsetHeight + 12) {
			// Not enough room above — show below
			dropdown.style.bottom = "auto";
			dropdown.style.top = `${rect.bottom + 4}px`;
		} else {
			dropdown.style.top = "auto";
			dropdown.style.bottom = `${bottom}px`;
		}

		dropdown.style.left = `${left}px`;
	}
}
