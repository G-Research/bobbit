// ============================================================================
// MARKET SOURCE DIALOG — add a marketplace source (git repo or local dir)
//
// Models the add-source modal described in docs/design/marketplace-mvp.md
// §3.3 / §10.3. The dialog POSTs to /api/marketplace/sources itself so it can
// surface server-side validation errors (400) inline and stay open; it
// resolves `true` only after a source was successfully added.
// ============================================================================

import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { html, render } from "lit";
import { addMarketSource } from "./api.js";

type SourceKind = "git" | "local";

/**
 * Open the add-source modal. Resolves `true` when a source was added (the
 * caller should reload), `false` if the user cancelled.
 */
export function openAddSourceDialog(): Promise<boolean> {
	return new Promise((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		let kind: SourceKind = "git";
		let url = "";
		let ref = "";
		let path = "";
		let label = "";
		let submitting = false;
		let errorMsg: string | null = null;

		const cleanup = (result: boolean) => {
			render(html``, container);
			container.remove();
			resolve(result);
		};

		const canSubmit = (): boolean => {
			if (submitting) return false;
			if (kind === "git") return url.trim().length > 0;
			return path.trim().length > 0;
		};

		const submit = async () => {
			if (!canSubmit()) return;
			submitting = true;
			errorMsg = null;
			rerender();
			const input = kind === "git"
				? { kind, url: url.trim(), ref: ref.trim() || undefined, label: label.trim() || undefined }
				: { kind, path: path.trim(), label: label.trim() || undefined };
			const result = await addMarketSource(input);
			submitting = false;
			if (result.ok) {
				cleanup(true);
				return;
			}
			errorMsg = result.error || "Failed to add source.";
			rerender();
		};

		const rerender = () => {
			render(
				Dialog({
					isOpen: true,
					onClose: () => cleanup(false),
					width: "min(480px, 92vw)",
					height: "auto",
					backdropClassName: "bg-black/50 backdrop-blur-sm",
					children: html`
						${DialogContent({
							children: html`
								${DialogHeader({ title: "Add marketplace source" })}
								<div class="market-dialog-body" data-testid="market-source-dialog">
									<div class="market-kind-toggle">
										<button
											class="market-kind-btn ${kind === "git" ? "is-active" : ""}"
											data-testid="market-kind-git"
											@click=${() => { kind = "git"; errorMsg = null; rerender(); }}
										>Git repo</button>
										<button
											class="market-kind-btn ${kind === "local" ? "is-active" : ""}"
											data-testid="market-kind-local"
											@click=${() => { kind = "local"; errorMsg = null; rerender(); }}
										>Local directory</button>
									</div>

									${kind === "git" ? html`
										<label class="market-field">
											<span class="market-field-label">Repository URL</span>
											<input class="market-input" data-testid="market-source-url"
												.value=${url}
												placeholder="https://github.com/acme/bobbit-packs.git"
												@input=${(e: Event) => { url = (e.target as HTMLInputElement).value; rerender(); }} />
										</label>
										<label class="market-field">
											<span class="market-field-label">Branch / ref <span class="market-field-opt">(optional)</span></span>
											<input class="market-input" data-testid="market-source-ref"
												.value=${ref}
												placeholder="main"
												@input=${(e: Event) => { ref = (e.target as HTMLInputElement).value; }} />
										</label>
									` : html`
										<label class="market-field">
											<span class="market-field-label">Absolute directory path</span>
											<input class="market-input" data-testid="market-source-path"
												.value=${path}
												placeholder="/Users/you/bobbit-packs"
												@input=${(e: Event) => { path = (e.target as HTMLInputElement).value; rerender(); }} />
											<span class="market-field-hint">Must be an existing absolute path. Local sources are read in place.</span>
										</label>
									`}

									<label class="market-field">
										<span class="market-field-label">Label <span class="market-field-opt">(optional)</span></span>
										<input class="market-input" data-testid="market-source-label"
											.value=${label}
											placeholder="Acme Packs"
											@input=${(e: Event) => { label = (e.target as HTMLInputElement).value; }} />
									</label>

									${errorMsg ? html`<div class="market-dialog-error" data-testid="market-source-error" role="alert">${errorMsg}</div>` : ""}
								</div>
							`,
						})}
						${DialogFooter({
							className: "px-6 pb-4",
							children: html`
								<div class="flex gap-2 justify-end">
									${Button({ variant: "ghost", onClick: () => cleanup(false), children: "Cancel" })}
									${Button({
										variant: "default",
										onClick: submit,
										disabled: !canSubmit(),
										children: submitting ? "Adding\u2026" : "Add source",
									})}
								</div>
							`,
						})}
					`,
				}),
				container,
			);
		};

		rerender();
	});
}
