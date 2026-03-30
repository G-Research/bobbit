import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icon } from "@mariozechner/mini-lit";
import { ShieldCheck } from "lucide";

/**
 * Inline card shown when the agent tries to use a tool it doesn't have permission for.
 * Offers one-click permission grant with "just this tool" or "all tools in group" options.
 */
@customElement("tool-permission-card")
export class ToolPermissionCard extends LitElement {
	@property() toolName = "";
	@property() group = "";
	@property() roleName = "";
	@property() roleLabel = "";
	@property() grantPolicy = "";  // "always-ask" | "ask-once" | "" (null/default/persistent)
	@property({ attribute: false }) onGrant?: (scope: "tool" | "group") => void;
	@property({ attribute: false }) onDeny?: () => void;
	@state() private _granting = false;
	@state() private _granted = false;
	@state() private _denied = false;

	protected override createRenderRoot() {
		return this;
	}

	private _handleGrant(scope: "tool" | "group") {
		if (this._granting || this._granted || this._denied) return;
		this._granting = true;
		this.onGrant?.(scope);
		// Show success after a short delay (server will restart the session)
		setTimeout(() => {
			this._granting = false;
			this._granted = true;
		}, 1500);
	}

	private _handleDeny() {
		if (this._granting || this._granted || this._denied) return;
		this._denied = true;
		this.onDeny?.();
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

	protected override render() {
		if (this._granted) {
			return html`
				<div class="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/30 text-sm text-green-600 dark:text-green-400">
					${icon(ShieldCheck, "sm")}
					<span>Permission granted — re-executing with new tools…</span>
				</div>
			`;
		}

		if (this._denied) {
			return html`
				<div class="flex items-center gap-2 px-3 py-2 rounded-md bg-muted border border-border text-sm text-muted-foreground">
					${icon(ShieldCheck, "sm")}
					<span>Permission denied for <code class="px-1 py-0.5 rounded bg-muted text-xs">${this._shortToolName}</code></span>
				</div>
			`;
		}

		if (this._granting) {
			const msg = this.grantPolicy === "always-ask"
				? "Allowing tool for this call…"
				: this.grantPolicy === "ask-once"
					? "Allowing tool for this session…"
					: "Granting permission and restarting session…";
			return html`
				<div class="flex items-center gap-2 px-3 py-2 rounded-md bg-muted border border-border text-sm text-muted-foreground">
					<span class="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></span>
					<span>${msg}</span>
				</div>
			`;
		}

		if (this.grantPolicy === "always-ask") {
			return html`
				<div class="px-3 py-2.5 rounded-md bg-amber-500/10 border border-amber-500/30 space-y-2">
					<div class="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
						${icon(ShieldCheck, "sm")}
						<span>Role "${this.roleLabel}" doesn't have access to <code class="px-1 py-0.5 rounded bg-amber-500/10 text-xs">${this._shortToolName}</code></span>
					</div>
					<div class="flex gap-2 flex-wrap">
						<button
							class="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
							@click=${() => this._handleGrant("tool")}
						>Allow once</button>
						<button
							class="px-3 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
							@click=${() => this._handleDeny()}
						>Deny</button>
					</div>
				</div>
			`;
		}

		if (this.grantPolicy === "ask-once") {
			return html`
				<div class="px-3 py-2.5 rounded-md bg-amber-500/10 border border-amber-500/30 space-y-2">
					<div class="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
						${icon(ShieldCheck, "sm")}
						<span>Role "${this.roleLabel}" doesn't have access to <code class="px-1 py-0.5 rounded bg-amber-500/10 text-xs">${this._shortToolName}</code></span>
					</div>
					<div class="flex gap-2 flex-wrap">
						<button
							class="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
							@click=${() => this._handleGrant("group")}
						>Allow all ${this._shortGroup} tools for this session</button>
						<button
							class="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
							@click=${() => this._handleGrant("tool")}
						>Allow ${this._shortToolName} for this session</button>
						<button
							class="px-3 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
							@click=${() => this._handleDeny()}
						>Deny</button>
					</div>
				</div>
			`;
		}

		// Default (no policy / persistent): existing behavior unchanged
		return html`
			<div class="px-3 py-2.5 rounded-md bg-amber-500/10 border border-amber-500/30 space-y-2">
				<div class="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
					${icon(ShieldCheck, "sm")}
					<span>Role "${this.roleLabel}" doesn't have access to <code class="px-1 py-0.5 rounded bg-amber-500/10 text-xs">${this._shortToolName}</code></span>
				</div>
				<div class="flex gap-2 flex-wrap">
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
						@click=${() => this._handleGrant("group")}
					>Allow all tools in ${this._shortGroup}</button>
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
						@click=${() => this._handleGrant("tool")}
					>Allow just ${this._shortToolName}</button>
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
						@click=${() => this._handleDeny()}
					>Deny</button>
				</div>
			</div>
		`;
	}
}
