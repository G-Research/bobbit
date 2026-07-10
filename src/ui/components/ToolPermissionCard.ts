import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icon } from "@mariozechner/mini-lit";
import { AlertTriangle, ShieldCheck } from "lucide";

export type PermissionCardStatus = "active" | "granting" | "granted" | "denied" | "expired" | "superseded" | "cancelled" | "error";

/**
 * Inline/pinned card shown when the agent tries to use a tool it doesn't have permission for.
 * Interaction state is controllable so inline and pinned copies stay in sync.
 */
@customElement("tool-permission-card")
export class ToolPermissionCard extends LitElement {
	@property() permissionId = "";
	@property() toolName = "";
	@property() group = "";
	@property() roleName = "";
	@property() roleLabel = "";
	@property() status: PermissionCardStatus | string = "active";
	@property() mode: string = "session-only";
	@property() error = "";
	@property({ type: Boolean }) actionable = true;
	@property({ attribute: false }) onModeChange?: (mode: string) => void;
	@property({ attribute: false }) onGrant?: (scope: "tool" | "group", mode?: string) => void | boolean;
	@property({ attribute: false }) onDeny?: () => void;
	@state() private _clicked = false;

	protected override createRenderRoot() {
		return this;
	}

	protected override updated(changed: Map<string, unknown>) {
		if (changed.has("status") || changed.has("permissionId")) this._clicked = false;
	}

	private get _effectiveMode(): string {
		return this.mode || "session-only";
	}

	private _setMode(mode: string) {
		this.mode = mode;
		this.onModeChange?.(mode);
	}

	private _handleGrant(scope: "tool" | "group") {
		if (!this._canAct || this._clicked) return;
		this._clicked = true;
		const accepted = this.onGrant?.(scope, this._effectiveMode);
		if (accepted === false) this._clicked = false;
	}

	private _handleDeny() {
		if (!this._canAct || this._clicked) return;
		this._clicked = true;
		this.onDeny?.();
	}

	private get _canAct(): boolean {
		return this.actionable !== false && this.status === "active";
	}

	// Extract a short display name from the full tool name
	private get _shortToolName(): string {
		// mcp__server__tool_name → tool_name
		const parts = this.toolName.split("__");
		return parts.length >= 3 ? parts.slice(2).join("__") : this.toolName;
	}

	// Extract a short group label
	private get _shortGroup(): string {
		// "MCP: server" → "server"
		return this.group.replace(/^MCP:\s*/, "");
	}

	private _renderSettled(label: unknown, tone: "success" | "muted" | "warning" | "error" = "muted") {
		const classes = tone === "success"
			? "bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400"
			: tone === "warning"
				? "bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400"
				: tone === "error"
					? "bg-destructive/10 border-destructive/30 text-destructive"
					: "bg-muted border-border text-muted-foreground";
		const statusIcon = tone === "error" ? AlertTriangle : ShieldCheck;
		return html`
			<div class="flex items-center gap-2 px-3 py-2 rounded-md border text-sm ${classes}">
				${icon(statusIcon, "sm")}
				<span>${label}</span>
			</div>
		`;
	}

	protected override render() {
		if (this.status === "granted") {
			return this._renderSettled("Permission granted — re-executing with new tools…", "success");
		}

		if (this.status === "denied") {
			return this._renderSettled(html`Permission denied for <code class="px-1 py-0.5 rounded bg-muted text-xs">${this._shortToolName}</code>`, "muted");
		}

		if (this.status === "expired" || this.status === "cancelled" || this.status === "superseded") {
			const label = this.status === "superseded" ? "Permission request superseded by a newer request." : "Permission request expired or was cancelled.";
			return this._renderSettled(label, "warning");
		}

		if (this.status === "error") {
			return this._renderSettled(this.error || `Permission request failed or became stale for ${this._shortToolName}.`, "error");
		}

		if (this.status === "granting") {
			return html`
				<div class="flex items-center gap-2 px-3 py-2 rounded-md bg-muted border border-border text-sm text-muted-foreground">
					<span class="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></span>
					<span>Granting permission…</span>
				</div>
			`;
		}

		return html`
			<div class="px-3 py-2.5 rounded-md bg-amber-500/10 border border-amber-500/30 space-y-2">
				<div class="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
					${icon(ShieldCheck, "sm")}
					<span>Role "${this.roleLabel}" doesn't have access to <code class="px-1 py-0.5 rounded bg-amber-500/10 text-xs">${this._shortToolName}</code></span>
				</div>
				<div class="flex items-center gap-2 flex-wrap">
					<label class="text-xs text-muted-foreground">Duration:</label>
					<select
						class="text-xs rounded-md border border-border bg-background px-2 py-1 cursor-pointer"
						.value=${this._effectiveMode}
						@change=${(e: Event) => this._setMode((e.target as HTMLSelectElement).value)}
					>
						<option value="session-only">This session</option>
						<option value="one-time">Just this once</option>
						<option value="persistent">For all future sessions</option>
					</select>
				</div>
				<div class="flex gap-2 flex-wrap">
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
						?disabled=${!this._canAct || this._clicked}
						@click=${() => this._handleGrant("group")}
					>Allow all tools in ${this._shortGroup}</button>
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
						?disabled=${!this._canAct || this._clicked}
						@click=${() => this._handleGrant("tool")}
					>Allow just ${this._shortToolName}</button>
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
						?disabled=${!this._canAct || this._clicked}
						@click=${() => this._handleDeny()}
					>Deny</button>
				</div>
			</div>
		`;
	}
}
