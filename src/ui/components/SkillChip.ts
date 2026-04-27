import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ChevronDown, ChevronRight, Sparkles } from "lucide";

/**
 * The data the chip needs to render. Mirrors the server-side SkillExpansion
 * shape (minus `range`, which is consumed by the splice logic in Messages.ts
 * before reaching here).
 */
export interface SkillChipData {
	name: string;
	args?: string;
	source?: string;
	filePath?: string;
	expanded: string;
}

/**
 * Inline pill that represents a resolved slash-skill invocation.
 *
 * Rendered in two places:
 *  - Inside `<user-message>`, spliced at the recorded `range` of a
 *    `/<name>` token in the original user text.
 *  - Inside the `activate_skill` tool renderer, where the agent's
 *    autonomous activation should look pixel-identical to a user
 *    invocation.
 *
 * Click toggles a disclosure that renders the snapshotted `expanded`
 * markdown. The expanded body is captured at invocation time so replay
 * is stable across SKILL.md edits on disk.
 */
@customElement("skill-chip")
export class SkillChip extends LitElement {
	@property({ type: Object }) data!: SkillChipData;
	/** When true, render in a tool-card context (block-level, with footer). */
	@property({ type: Boolean }) block = false;
	@state() private expanded = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this; // light DOM — share global tailwind classes
	}

	override connectedCallback(): void {
		super.connectedCallback();
		if (this.block) {
			this.style.display = "block";
		} else {
			// `display: contents` so our pill + expansion participate directly in
			// the parent's flex-wrap layout. This lets the expansion claim a full
			// row beneath the chip via `basis-full` instead of being squeezed
			// inside the chip's narrow inline box.
			this.style.display = "contents";
		}
	}

	private toggle = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
		this.expanded = !this.expanded;
	};

	private renderPill(): TemplateResult {
		const args = (this.data.args || "").trim();
		const label = args ? `/${this.data.name} ${args}` : `/${this.data.name}`;
		return html`
			<button
				type="button"
				class="skill-chip-pill inline-flex items-center gap-1 align-baseline px-2 py-0.5 rounded-md
					bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium
					border border-primary/20 transition-colors cursor-pointer max-w-full"
				title=${`Skill: /${this.data.name}${this.data.filePath ? ` (${this.data.filePath})` : ""}`}
				@click=${this.toggle}
			>
				${icon(Sparkles, "sm")}
				<span class="truncate">${label}</span>
				${icon(this.expanded ? ChevronDown : ChevronRight, "sm")}
			</button>
		`;
	}

	private renderExpansion(): TemplateResult {
		return html`
			<div class="skill-chip-expansion mt-2 mb-1 border border-border/60 rounded-md bg-muted/40 overflow-hidden">
				<div class="px-3 py-2 max-h-[420px] overflow-y-auto text-sm">
					<markdown-block .content=${this.data.expanded}></markdown-block>
				</div>
				${this.data.filePath
					? html`<div class="px-3 py-1.5 border-t border-border/60 text-[11px] text-muted-foreground font-mono truncate">
							${this.data.source ? html`<span class="opacity-70">${this.data.source}:</span> ` : ""}${this.data.filePath}
						</div>`
					: ""}
			</div>
		`;
	}

	override render(): TemplateResult {
		// In inline (user-message) mode the pill is a span inside flowing text
		// and the expansion sits below the bubble in a block region. We achieve
		// that by rendering both nodes; the parent uses flex-wrap to keep
		// chips inline and CSS makes the expansion break to a new line via
		// the `w-full` class.
		if (!this.block) {
			// With `display: contents` on the host, these two children sit at the
			// same flex-wrap level as the surrounding text spans. `basis-full` on
			// the expansion forces it onto its own row spanning the full bubble
			// width — which is what we want on both desktop and mobile.
			return html`
				${this.renderPill()}
				${this.expanded
					? html`<div class="basis-full w-full">${this.renderExpansion()}</div>`
					: ""}
			`;
		}
		// Block mode (used by ActivateSkillRenderer): pill stacked above body.
		return html`
			<div class="flex flex-col gap-0">
				<div>${this.renderPill()}</div>
				${this.expanded ? this.renderExpansion() : ""}
			</div>
		`;
	}
}
