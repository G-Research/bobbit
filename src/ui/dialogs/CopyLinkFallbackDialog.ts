/**
 * CopyLinkFallbackDialog — shown when `navigator.clipboard.writeText` fails
 * (e.g. insecure context, permissions denied). Renders a readonly <input>
 * pre-selected with the session URL so the user can manually copy it with
 * Ctrl/Cmd+C.
 *
 * Pattern lifted from SystemPromptDialog (mini-lit DialogBase).
 */
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";

@customElement("copy-link-fallback-dialog")
export class CopyLinkFallbackDialog extends DialogBase {
	@state() private url = "";
	@state() private dialogTitle = "Copy session link";

	protected modalWidth = "min(520px, 92vw)";
	protected modalHeight = "auto";

	createRenderRoot() {
		return this;
	}

	static show(url: string, opts?: { title?: string }) {
		const dialog = new CopyLinkFallbackDialog();
		dialog.url = url;
		dialog.dialogTitle = opts?.title || "Copy session link";
		document.body.appendChild(dialog);
		dialog.open();
		// After the input renders, select its contents so Ctrl/Cmd+C works.
		queueMicrotask(() => {
			const input = dialog.querySelector<HTMLInputElement>("input[data-copy-link-input]");
			if (input) {
				input.focus();
				input.select();
			}
		});
	}

	private async copy() {
		try {
			await navigator.clipboard.writeText(this.url);
		} catch {
			// Last-resort fallback: legacy execCommand path.
			const input = this.querySelector<HTMLInputElement>("input[data-copy-link-input]");
			if (input) {
				input.focus();
				input.select();
				try { document.execCommand("copy"); } catch { /* swallow */ }
			}
		}
	}

	protected override renderContent() {
		return html`
			${DialogContent({
				className: "flex flex-col",
				children: html`
					${DialogHeader({
						title: this.dialogTitle,
						description: "Press Ctrl/Cmd+C to copy, or use the button below.",
					})}
					<div class="mt-4">
						<input
							type="text"
							readonly
							data-copy-link-input
							data-testid="copy-link-fallback-input"
							class="w-full px-3 py-2 text-sm font-mono border border-border rounded bg-muted text-foreground"
							.value=${this.url}
							@click=${(e: Event) => (e.target as HTMLInputElement).select()}
						/>
					</div>
					<div class="mt-4 flex justify-end gap-2 border-t border-border pt-3">
						${Button({
							variant: "outline",
							size: "sm",
							onClick: () => this.close(),
							children: "Close",
						})}
						${Button({
							variant: "default",
							size: "sm",
							onClick: () => this.copy(),
							children: "Copy",
						})}
					</div>
				`,
			})}
		`;
	}
}
