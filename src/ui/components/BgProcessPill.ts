import { html, LitElement, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { customElement, property, state } from "lit/decorators.js";
import { ansiToHtml, hasAnsi } from "../utils/ansi.js";

export interface BgProcessInfo {
	id: string;
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

	private _onDocumentClick = (e: MouseEvent) => {
		if (this.expanded && !this.contains(e.target as Node)) {
			this.expanded = false;
		}
	};

	connectedCallback() {
		super.connectedCallback();
		document.addEventListener("click", this._onDocumentClick, true);
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("click", this._onDocumentClick, true);
	}

	private async _toggle(e: MouseEvent) {
		e.stopPropagation();
		this.expanded = !this.expanded;
		if (this.expanded) {
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

	private _kill(e: MouseEvent) {
		e.stopPropagation();
		if (this.onKill) this.onKill(this.process.id);
	}

	private _dismiss(e: MouseEvent) {
		e.stopPropagation();
		if (this.onDismiss) this.onDismiss(this.process.id);
	}

	private _fmtTime(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	}

	private _scrollToBottom() {
		const el = this.querySelector("#bg-log-output");
		if (el) el.scrollTop = el.scrollHeight;
	}

	private _shortCommand(): string {
		const cmd = this.process.command;
		// Show first 30 chars
		return cmd.length > 30 ? cmd.slice(0, 27) + "..." : cmd;
	}

	render() {
		if (!this.process) return nothing;
		const p = this.process;
		const isRunning = p.status === "running";
		const dotClass = isRunning
			? "bg-blue-400 animate-pulse"
			: p.exitCode === 0
				? "bg-green-400"
				: p.exitCode !== null
					? "bg-red-400"
					: "bg-muted-foreground"; // scheduled / unknown
		const statusDot = html`<span class="inline-block w-1.5 h-1.5 rounded-full ${dotClass} shrink-0"></span>`;

		return html`
			<button
				class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-[11px] leading-tight"
				style="max-width:200px"
				@click=${this._toggle}
				title="${p.command}"
			>
				${statusDot}
				<span class="truncate font-mono">${this._shortCommand()}</span>
				${!isRunning && p.exitCode !== null
					? html`<span class="${p.exitCode === 0 ? "text-muted-foreground" : "text-red-400"} shrink-0">${p.exitCode}</span>`
					: nothing}
			</button>

			${this.expanded
				? html`
					<div
						class="fixed z-50 bg-card border border-border rounded-lg shadow-lg p-2 text-xs"
						style="max-width:calc(100vw - 2rem); width: 900px;"
						id="bg-process-dropdown"
					>
						<div class="flex items-center justify-between mb-1.5">
							<div class="flex items-center gap-1.5 text-foreground font-medium text-sm min-w-0">
								${statusDot}
								<span class="truncate font-mono">${p.id}</span>
								<span class="text-[10px] text-muted-foreground font-normal">pid ${p.pid}</span>
							</div>
							<div class="flex items-center gap-1.5">
								${isRunning
									? html`<button
										class="px-2 py-0.5 rounded text-[11px] bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
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
							: html`<div class="h-[180px] overflow-y-auto bg-background rounded px-2 py-1.5 font-mono text-[11px] leading-snug break-all" id="bg-log-output">${this.logs.length > 0
										? this.logs.map((entry) => html`<div class="whitespace-pre-wrap">${entry.ts
											? html`<span class="text-muted-foreground select-none">${this._fmtTime(entry.ts)} </span>`
											: nothing}${hasAnsi(entry.text) ? unsafeHTML(ansiToHtml(entry.text)) : entry.text}</div>`)
										: html`<div class="text-muted-foreground text-center py-1">(no output yet)</div>`}</div>
							`}
					</div>
				`
				: nothing}
		`;
	}

	override updated(changed: Map<string, unknown>) {
		super.updated(changed);
		if (changed.has("expanded") && this.expanded) {
			this._positionDropdown();
		}
	}

	private _positionDropdown() {
		const btn = this.querySelector("button");
		const dropdown = this.querySelector("#bg-process-dropdown") as HTMLElement;
		if (!btn || !dropdown) return;
		const rect = btn.getBoundingClientRect();
		const dropRect = dropdown.getBoundingClientRect();

		// Horizontal: align to button left, but clamp to viewport
		let left = rect.left;
		if (left + dropRect.width > window.innerWidth - 8) {
			left = window.innerWidth - dropRect.width - 8;
		}
		if (left < 8) left = 8;

		// Vertical: prefer above the button, fall back to below if not enough space
		let bottom = window.innerHeight - rect.top + 4;
		if (rect.top < dropRect.height + 12) {
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
