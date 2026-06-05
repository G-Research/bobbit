import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ChevronDown, ChevronRight, File, FileText, Image as ImageIcon } from "lucide";

/**
 * Kind of a resolved `@path` file reference. Mirrors the server-side
 * `MentionKind` (see `src/server/skills/resolve-file-mentions.ts`).
 */
export type FileMentionKind = "text" | "image" | "binary" | "unresolved";

/**
 * The data the chip needs to render. Mirrors the server-side `FileMention`
 * shape (minus `range`, which is consumed by the splice logic in Messages.ts
 * before reaching here, and minus `absPath`, which is host-only). The UI
 * re-declares this structurally-identical interface so the JSON crosses the
 * wire unchanged — it deliberately does NOT import the server module.
 */
export interface FileMentionChipData {
	/** Relative path exactly as typed (after the `@`). */
	path: string;
	kind: FileMentionKind;
	/** text kind: snapshotted file content (verbatim). */
	content?: string;
	/** image/binary kind: base64 (no data-URL prefix) snapshot. */
	data?: string;
	mimeType?: string;
	/** resolved file size in bytes. */
	bytes?: number;
	/** unresolved kind: human-readable reason. */
	reason?: string;
}

/** Human-readable byte size, e.g. "1.2 KB". */
function formatBytes(bytes: number | undefined): string {
	if (bytes == null || !Number.isFinite(bytes)) return "";
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
	const mb = kb / 1024;
	return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * Inline pill that represents a resolved `@path` file reference.
 *
 * Rendered inside `<user-message>`, spliced at the recorded `range` of an
 * `@<path>` token in the original user text. Mirrors `SkillChip` layer-for-layer.
 *
 * Click toggles a disclosure that renders the snapshotted content. The body is
 * captured at send time so replay is stable even if the file changes on disk
 * (same guarantee as skill expansions).
 */
@customElement("file-mention-chip")
export class FileMentionChip extends LitElement {
	@property({ type: Object }) data!: FileMentionChipData;
	/** When true, render in a block context (with footer stacked). */
	@property({ type: Boolean }) block = false;
	@state() private expanded = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this; // light DOM — share global tailwind classes
	}

	override connectedCallback(): void {
		super.connectedCallback();
		// `display: contents` so the pill + expansion participate directly in the
		// parent's flex-wrap layout (matches SkillChip inline behaviour).
		this.style.display = this.block ? "block" : "contents";
	}

	private toggle = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
		this.expanded = !this.expanded;
	};

	private get iconForKind() {
		switch (this.data.kind) {
			case "image":
				return ImageIcon;
			case "text":
				return FileText;
			default:
				return File;
		}
	}

	private renderPill(): TemplateResult {
		const unresolved = this.data.kind === "unresolved";
		const pillClass = unresolved
			? "bg-destructive/10 hover:bg-destructive/20 text-destructive border-destructive/20"
			: "bg-primary/10 hover:bg-primary/20 text-primary border-primary/20";
		return html`
			<button
				type="button"
				class="file-mention-chip-pill inline-flex items-center gap-1 align-baseline px-2 py-0.5 rounded-md
					${pillClass} text-xs font-medium border transition-colors cursor-pointer max-w-full"
				title=${`File: @${this.data.path}${this.data.reason ? ` (${this.data.reason})` : ""}`}
				@click=${this.toggle}
			>
				${icon(this.iconForKind, "sm")}
				<span class="truncate">@${this.data.path}</span>
				${icon(this.expanded ? ChevronDown : ChevronRight, "sm")}
			</button>
		`;
	}

	private renderDisclosureBody(): TemplateResult {
		const { kind, content, data, mimeType, reason } = this.data;
		if (kind === "text") {
			return html`<pre
				class="px-3 py-2 max-h-[420px] overflow-auto text-xs font-mono whitespace-pre-wrap break-words"
			>${content ?? ""}</pre>`;
		}
		if (kind === "image" && data) {
			const src = `data:${mimeType || "image/png"};base64,${data}`;
			return html`<div class="px-3 py-2 max-h-[420px] overflow-auto">
				<img src=${src} alt=${this.data.path} class="max-w-full h-auto rounded" />
			</div>`;
		}
		if (kind === "unresolved") {
			return html`<div class="px-3 py-2 text-xs text-muted-foreground">
				Could not resolve <span class="font-mono">@${this.data.path}</span>${reason ? html` — ${reason}` : ""}
			</div>`;
		}
		// binary
		return html`<div class="px-3 py-2 text-xs text-muted-foreground">
			Binary file <span class="font-mono">${this.data.path}</span>${this.data.bytes != null
				? html` (${formatBytes(this.data.bytes)})`
				: ""} — attached, not inlined.
		</div>`;
	}

	private renderExpansion(): TemplateResult {
		const size = formatBytes(this.data.bytes);
		return html`
			<div class="file-mention-chip-expansion mt-2 mb-1 border border-border/60 rounded-md bg-muted/40 overflow-hidden">
				${this.renderDisclosureBody()}
				<div class="px-3 py-1.5 border-t border-border/60 text-[11px] text-muted-foreground font-mono truncate">
					${this.data.path}${size ? html` · ${size}` : ""}
				</div>
			</div>
		`;
	}

	override render(): TemplateResult {
		if (!this.block) {
			return html`
				${this.renderPill()}
				${this.expanded
					? html`<div class="basis-full w-full">${this.renderExpansion()}</div>`
					: ""}
			`;
		}
		return html`
			<div class="flex flex-col gap-0">
				<div>${this.renderPill()}</div>
				${this.expanded ? this.renderExpansion() : ""}
			</div>
		`;
	}
}
