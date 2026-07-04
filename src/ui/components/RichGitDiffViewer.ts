import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	buildSplitPairs,
	parseUnifiedDiff,
	type SplitDiffPair,
	type UnifiedDiffFile,
	type UnifiedDiffHunk,
	type UnifiedDiffLine,
	type UnifiedDiffParseResult,
} from "../../shared/git-diff/unified.js";

const MOBILE_BREAKPOINT = 768;
const DEFAULT_CONTEXT_LINES = 3;
const CONTEXT_EXPAND_LINES = 10;

type DiffMode = "split" | "inline";
type DefaultDiffMode = "auto" | DiffMode;
type ContextDirection = "above" | "below";

type HunkRenderPart =
	| { kind: "lines"; start: number; end: number; lines: readonly UnifiedDiffLine[] }
	| {
		kind: "context";
		key: string;
		start: number;
		end: number;
		gapStart: number;
		gapEnd: number;
		hiddenCount: number;
		canExpandAbove: boolean;
		canExpandBelow: boolean;
	};

interface ContextExpansion {
	above?: number;
	below?: number;
}

@customElement("rich-git-diff-viewer")
export class RichGitDiffViewer extends LitElement {
	@property() content = "";
	@property() title = "Diff";
	@property({ attribute: "file-path" }) filePath = "";
	@property({ type: Boolean, attribute: "show-copy" }) showCopy = true;
	@property({ attribute: "default-mode" }) defaultMode: DefaultDiffMode = "auto";

	@state() private modeOverride: DiffMode | null = null;
	@state() private viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
	@state() private collapsedFiles = new Set<string>();
	@state() private contextExpansions: Record<string, ContextExpansion> = {};
	@state() private copied = false;

	private parsedContent: string | null = null;
	private parsed: UnifiedDiffParseResult | null = null;
	private copyResetTimer: number | null = null;

	private readonly resizeHandler = () => {
		this.viewportWidth = window.innerWidth;
	};

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		if (typeof window !== "undefined") {
			window.addEventListener("resize", this.resizeHandler);
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		if (typeof window !== "undefined") {
			window.removeEventListener("resize", this.resizeHandler);
		}
		if (this.copyResetTimer !== null) {
			window.clearTimeout(this.copyResetTimer);
			this.copyResetTimer = null;
		}
	}

	protected override updated(changedProperties: PropertyValues<this>): void {
		if (changedProperties.has("content")) {
			this.parsedContent = null;
			this.parsed = null;
			this.collapsedFiles = new Set();
			this.contextExpansions = {};
			this.modeOverride = null;
			this.copied = false;
		}
	}

	private get effectiveMode(): DiffMode {
		if (this.modeOverride) return this.modeOverride;
		if (this.defaultMode === "split" || this.defaultMode === "inline") return this.defaultMode;
		return this.viewportWidth >= MOBILE_BREAKPOINT ? "split" : "inline";
	}

	private getParsed(): UnifiedDiffParseResult {
		if (this.parsedContent !== this.content || !this.parsed) {
			this.parsedContent = this.content;
			this.parsed = parseUnifiedDiff(this.content || "");
		}
		return this.parsed;
	}

	private setMode(mode: DiffMode): void {
		this.modeOverride = mode;
	}

	private toggleFile(fileId: string): void {
		const next = new Set(this.collapsedFiles);
		if (next.has(fileId)) {
			next.delete(fileId);
		} else {
			next.add(fileId);
		}
		this.collapsedFiles = next;
	}

	private expandContext(key: string, direction: ContextDirection, hiddenCount: number): void {
		const current = this.contextExpansions[key] ?? {};
		const currentAmount = current[direction] ?? 0;
		const nextAmount = Math.min(hiddenCount, currentAmount + CONTEXT_EXPAND_LINES);
		this.contextExpansions = {
			...this.contextExpansions,
			[key]: {
				...current,
				[direction]: nextAmount,
			},
		};
	}

	private async copyRawDiff(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.content || "");
			this.copied = true;
			if (this.copyResetTimer !== null) window.clearTimeout(this.copyResetTimer);
			this.copyResetTimer = window.setTimeout(() => {
				this.copied = false;
				this.copyResetTimer = null;
			}, 1500);
		} catch (error) {
			console.error("Failed to copy git diff", error);
		}
	}

	private buildHunkParts(file: UnifiedDiffFile, hunkIndex: number, hunk: UnifiedDiffHunk): HunkRenderPart[] {
		const lines = hunk.lines;
		if (lines.length === 0) return [];

		const importantIndexes = lines
			.map((line, index) => (line.kind === "add" || line.kind === "remove" ? index : -1))
			.filter(index => index >= 0);
		if (importantIndexes.length === 0) {
			return [{ kind: "lines", start: 0, end: lines.length - 1, lines }];
		}

		const visible = new Set<number>();
		for (const index of importantIndexes) {
			const start = Math.max(0, index - DEFAULT_CONTEXT_LINES);
			const end = Math.min(lines.length - 1, index + DEFAULT_CONTEXT_LINES);
			for (let i = start; i <= end; i++) visible.add(i);
		}

		const hiddenRanges: Array<{ start: number; end: number }> = [];
		let i = 0;
		while (i < lines.length) {
			if (visible.has(i)) {
				i++;
				continue;
			}
			const start = i;
			while (i < lines.length && !visible.has(i)) i++;
			hiddenRanges.push({ start, end: i - 1 });
		}

		if (hiddenRanges.length === 0) {
			return [{ kind: "lines", start: 0, end: lines.length - 1, lines }];
		}

		const parts: HunkRenderPart[] = [];
		let cursor = 0;
		const pushLines = (start: number, end: number) => {
			if (start > end) return;
			parts.push({ kind: "lines", start, end, lines: lines.slice(start, end + 1) });
		};

		for (const range of hiddenRanges) {
			pushLines(cursor, range.start - 1);

			const key = this.contextKey(file.id, hunkIndex, range.start, range.end);
			const expansion = this.contextExpansions[key] ?? {};
			const rangeLength = range.end - range.start + 1;
			const below = Math.min(expansion.below ?? 0, rangeLength);
			const above = Math.min(expansion.above ?? 0, Math.max(0, rangeLength - below));

			pushLines(range.start, range.start + below - 1);

			const remainingStart = range.start + below;
			const remainingEnd = range.end - above;
			if (remainingStart <= remainingEnd) {
				parts.push({
					kind: "context",
					key,
					start: remainingStart,
					end: remainingEnd,
					gapStart: range.start,
					gapEnd: range.end,
					hiddenCount: remainingEnd - remainingStart + 1,
					canExpandAbove: true,
					canExpandBelow: true,
				});
			}

			pushLines(range.end - above + 1, range.end);
			cursor = range.end + 1;
		}
		pushLines(cursor, lines.length - 1);

		return parts;
	}

	private contextKey(fileId: string, hunkIndex: number, gapStart: number, gapEnd: number): string {
		return `${fileId}::${hunkIndex}::${gapStart}-${gapEnd}`;
	}

	private safeId(value: string, index: number): string {
		return `rich-git-diff-${index}-${value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "file"}`;
	}

	private fileSummary(files: readonly UnifiedDiffFile[]): { additions: number; deletions: number } {
		return files.reduce(
			(total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }),
			{ additions: 0, deletions: 0 },
		);
	}

	private lineKindClass(line: UnifiedDiffLine | null): string {
		if (!line) return "empty";
		if (line.kind === "add") return "add";
		if (line.kind === "remove") return "del";
		if (line.kind === "meta") return "meta";
		return "ctx";
	}

	private linePrefix(line: UnifiedDiffLine | null): string {
		if (!line) return "";
		if (line.kind === "add") return "+";
		if (line.kind === "remove") return "−";
		return " ";
	}

	private lineText(line: UnifiedDiffLine | null): string {
		if (!line) return "";
		return line.text || (line.kind === "meta" ? line.raw : "");
	}

	private statusLabel(file: UnifiedDiffFile): string {
		if (file.isBinary) return "binary";
		return file.status === "unknown" ? "modified" : file.status;
	}

	private renderModeIcon(mode: DiffMode): TemplateResult {
		if (mode === "split") {
			return html`<svg class="rich-git-diff-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="5" height="10" rx="1"></rect><rect x="9" y="3" width="5" height="10" rx="1"></rect></svg>`;
		}
		return html`<svg class="rich-git-diff-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h4"></path><path d="M13 6h8"></path><path d="M5 12h4"></path><path d="M13 12h8"></path><path d="M5 18h4M7 16v4"></path><path d="M13 18h8"></path></svg>`;
	}

	private renderCopyIcon(): TemplateResult {
		if (this.copied) {
			return html`<svg class="rich-git-diff-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;
		}
		return html`<svg class="rich-git-diff-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
	}

	private renderToolbar(parsed: UnifiedDiffParseResult, mode: DiffMode): TemplateResult {
		const summary = this.fileSummary(parsed.files);
		const fileCount = parsed.files.length;
		return html`
			<div class="rich-git-diff-toolbar" data-testid="rich-git-diff-toolbar" aria-label="Diff toolbar">
				<div class="rich-git-diff-summary">
					${this.title ? html`<span class="rich-git-diff-title" title=${this.title}>${this.title}</span>` : nothing}
					<span class="rich-git-diff-pill">${fileCount} ${fileCount === 1 ? "file" : "files"}</span>
					<span class="rich-git-diff-pill rich-git-diff-add-count">+${summary.additions}</span>
					<span class="rich-git-diff-pill rich-git-diff-del-count">-${summary.deletions}</span>
				</div>
				<div class="rich-git-diff-controls">
					<span class="rich-git-diff-mode-toggle" data-testid="rich-git-diff-mode" role="radiogroup" aria-label="Diff display mode">
						<button
							type="button"
							role="radio"
							class="rich-git-diff-mode-button"
							data-testid="rich-git-diff-mode-split"
							aria-label="Split diff"
							title="Split diff"
							aria-checked=${String(mode === "split")}
							@click=${() => this.setMode("split")}
						>${this.renderModeIcon("split")}</button>
						<button
							type="button"
							role="radio"
							class="rich-git-diff-mode-button"
							data-testid="rich-git-diff-mode-inline"
							aria-label="Inline diff"
							title="Inline diff"
							aria-checked=${String(mode === "inline")}
							@click=${() => this.setMode("inline")}
						>${this.renderModeIcon("inline")}</button>
					</span>
					${this.showCopy ? html`
						<button
							type="button"
							class="rich-git-diff-icon-button"
							aria-label=${this.copied ? "Raw unified diff copied" : "Copy raw unified diff"}
							title=${this.copied ? "Copied" : "Copy raw unified diff"}
							@click=${() => void this.copyRawDiff()}
						>${this.renderCopyIcon()}</button>
					` : nothing}
				</div>
			</div>
		`;
	}

	private renderTruncation(parsed: UnifiedDiffParseResult): TemplateResult | typeof nothing {
		if (!parsed.isTruncated) return nothing;
		return html`
			<div class="rich-git-diff-truncated" data-testid="rich-git-diff-truncated" role="status">
				<svg class="rich-git-diff-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"></path></svg>
				<span><strong>Diff truncated.</strong> Showing the available portion of the raw unified diff.</span>
			</div>
		`;
	}

	private renderFile(file: UnifiedDiffFile, fileIndex: number, mode: DiffMode): TemplateResult {
		const collapsed = this.collapsedFiles.has(file.id);
		const bodyId = this.safeId(file.id || file.path, fileIndex);
		const status = this.statusLabel(file);
		return html`
			<section
				class=${`rich-git-diff-file${collapsed ? " closed" : ""}`}
				data-testid="rich-git-diff-file"
				data-file-path=${file.path}
				data-expanded=${String(!collapsed)}
			>
				<div class="rich-git-diff-file-header-row">
					<button
						type="button"
						class="rich-git-diff-file-toggle"
						data-testid="rich-git-diff-file-toggle"
						aria-expanded=${String(!collapsed)}
						aria-controls=${bodyId}
						@click=${() => this.toggleFile(file.id)}
					>
						<span class="rich-git-diff-caret" aria-hidden="true">▸</span>
						<span class="rich-git-diff-file-main">
							<span class="rich-git-diff-path">${file.displayPath || file.path || file.header}</span>
							${file.oldPath && file.oldPath !== file.path ? html`<span class="rich-git-diff-rename-path">${file.oldPath} → ${file.path}</span>` : nothing}
						</span>
						<span class="rich-git-diff-status">${status}</span>
						<span class="rich-git-diff-counts" data-testid="rich-git-diff-counts" aria-label=${`${file.additions} additions, ${file.deletions} deletions`}>
							<span class="rich-git-diff-add-count">+${file.additions}</span>
							<span class="rich-git-diff-del-count">-${file.deletions}</span>
						</span>
					</button>
				</div>
				<div id=${bodyId} class="rich-git-diff-file-body" ?hidden=${collapsed}>
					${this.renderFileBody(file, mode)}
				</div>
			</section>
		`;
	}

	private renderFileBody(file: UnifiedDiffFile, mode: DiffMode): TemplateResult {
		if (file.hunks.length === 0) {
			return html`
				<div class="rich-git-diff-meta-only">
					${file.isBinary ? html`<p>Binary file changed.</p>` : html`<p>No text hunks available for this file.</p>`}
					${file.meta.length > 0 ? html`<pre>${file.meta.join("\n")}</pre>` : nothing}
				</div>
			`;
		}

		return html`
			<div class="rich-git-diff-overflow">
				<div class=${mode === "split" ? "rich-git-diff-split-grid" : "rich-git-diff-inline-lines"} data-layout=${mode}>
					${file.meta.length > 0 ? html`<div class="rich-git-diff-file-meta">${file.meta.join(" · ")}</div>` : nothing}
					${file.hunks.map((hunk, hunkIndex) => this.renderHunk(file, hunk, hunkIndex, mode))}
				</div>
			</div>
		`;
	}

	private renderHunk(file: UnifiedDiffFile, hunk: UnifiedDiffHunk, hunkIndex: number, mode: DiffMode): TemplateResult {
		const parts = this.buildHunkParts(file, hunkIndex, hunk);
		return html`
			<div class="rich-git-diff-hunk">
				${this.renderHunkHeader(hunk.header, nothing)}
				${parts.map(part => part.kind === "lines"
					? (mode === "split" ? this.renderSplitLines(part.lines) : this.renderInlineLines(part.lines))
					: this.renderContextPart(file, part))}
			</div>
		`;
	}

	private renderHunkHeader(header: string, control: TemplateResult | typeof nothing): TemplateResult {
		return html`
			<div class="rich-git-diff-hunk-header">
				<div class="rich-git-diff-hunk-context-cell">${control}</div>
				<div class="rich-git-diff-hunk-signature">${header}</div>
			</div>
		`;
	}

	private renderContextPart(file: UnifiedDiffFile, part: Extract<HunkRenderPart, { kind: "context" }>): TemplateResult {
		const aboveCount = Math.min(CONTEXT_EXPAND_LINES, part.hiddenCount);
		const belowCount = Math.min(CONTEXT_EXPAND_LINES, part.hiddenCount);
		const controls = html`
			<div class="rich-git-diff-context-controls">
				${part.canExpandAbove ? html`
					<button
						type="button"
						class="rich-git-diff-context-toggle"
						data-testid="rich-git-diff-context-toggle"
						data-context-direction="above"
						aria-label=${`Show ${aboveCount} more ${aboveCount === 1 ? "line" : "lines"} above in ${file.displayPath || file.path}`}
						title=${`Show ${aboveCount} more ${aboveCount === 1 ? "line" : "lines"} above`}
						@click=${() => this.expandContext(part.key, "above", part.gapEnd - part.gapStart + 1)}
					>
						${this.renderArrowIcon("above")}
					</button>
				` : nothing}
				${part.canExpandBelow ? html`
					<button
						type="button"
						class="rich-git-diff-context-toggle"
						data-testid="rich-git-diff-context-toggle"
						data-context-direction="below"
						aria-label=${`Show ${belowCount} more ${belowCount === 1 ? "line" : "lines"} below in ${file.displayPath || file.path}`}
						title=${`Show ${belowCount} more ${belowCount === 1 ? "line" : "lines"} below`}
						@click=${() => this.expandContext(part.key, "below", part.gapEnd - part.gapStart + 1)}
					>
						${this.renderArrowIcon("below")}
					</button>
				` : nothing}
			</div>
		`;
		return this.renderHunkHeader(`${part.hiddenCount} hidden context ${part.hiddenCount === 1 ? "line" : "lines"}`, controls);
	}

	private renderArrowIcon(direction: ContextDirection): TemplateResult {
		if (direction === "above") {
			return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9"></path><path d="M4.5 6.5 8 3l3.5 3.5"></path><path d="M4.5 13h7"></path></svg>`;
		}
		return html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v9"></path><path d="M4.5 9.5 8 13l3.5-3.5"></path><path d="M4.5 3h7"></path></svg>`;
	}

	private renderInlineLines(lines: readonly UnifiedDiffLine[]): TemplateResult {
		return html`${lines.map(line => this.renderInlineLine(line))}`;
	}

	private renderInlineLine(line: UnifiedDiffLine): TemplateResult {
		return html`
			<div class=${`rich-git-diff-line ${this.lineKindClass(line)}`} data-testid="rich-git-diff-line" data-line-kind=${line.kind}>
				<span class="rich-git-diff-line-no old">${line.oldLine ?? ""}</span>
				<span class="rich-git-diff-line-no new">${line.newLine ?? ""}</span>
				<span class="rich-git-diff-prefix">${this.linePrefix(line)}</span>
				<span class="rich-git-diff-line-text">${this.lineText(line)}${line.noNewline ? html`<span class="rich-git-diff-no-newline"> No newline at end of file</span>` : nothing}</span>
			</div>
		`;
	}

	private renderSplitLines(lines: readonly UnifiedDiffLine[]): TemplateResult {
		const pairs = buildSplitPairs(lines);
		return html`${pairs.map(pair => this.renderSplitPair(pair))}`;
	}

	private renderSplitPair(pair: SplitDiffPair): TemplateResult {
		return html`
			<div class="rich-git-diff-split-row">
				${this.renderSplitCell(pair.left, "left")}
				${this.renderSplitCell(pair.right, "right")}
			</div>
		`;
	}

	private renderSplitCell(line: UnifiedDiffLine | null, side: "left" | "right"): TemplateResult {
		const lineNumber = side === "left" ? line?.oldLine : line?.newLine;
		return html`
			<div class=${`rich-git-diff-line ${this.lineKindClass(line)}`} data-testid=${line ? "rich-git-diff-line" : "rich-git-diff-empty-line"} data-line-kind=${line?.kind ?? "empty"} aria-hidden=${line ? nothing : "true"}>
				<span class="rich-git-diff-line-no">${lineNumber ?? ""}</span>
				<span class="rich-git-diff-prefix">${this.linePrefix(line)}</span>
				<span class="rich-git-diff-line-text">${this.lineText(line)}${line?.noNewline ? html`<span class="rich-git-diff-no-newline"> No newline at end of file</span>` : nothing}</span>
			</div>
		`;
	}

	override render(): TemplateResult {
		const parsed = this.getParsed();
		const mode = this.effectiveMode;

		return html`
			${this.renderStyles()}
			<div class="rich-git-diff" data-testid="rich-git-diff-viewer" data-mode=${mode} data-file-path=${this.filePath || ""}>
				${this.renderToolbar(parsed, mode)}
				<div class="rich-git-diff-content">
					${this.renderTruncation(parsed)}
					${parsed.files.length > 0
						? html`<div class="rich-git-diff-list">${parsed.files.map((file, index) => this.renderFile(file, index, mode))}</div>`
						: html`<pre class="rich-git-diff-raw" data-testid="rich-git-diff-raw">${this.content}</pre>`}
				</div>
			</div>
		`;
	}

	private renderStyles(): TemplateResult {
		return html`<style>
			.rich-git-diff, .rich-git-diff * { box-sizing: border-box; }
			.rich-git-diff {
				border: 1px solid var(--border);
				border-radius: 12px;
				overflow: hidden;
				background: var(--card);
				color: var(--foreground);
			}
			.rich-git-diff button { font: inherit; }
			.rich-git-diff button:focus-visible {
				outline: 2px solid var(--ring);
				outline-offset: 2px;
			}
			.rich-git-diff-toolbar {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 12px;
				padding: 10px 12px;
				border-bottom: 1px solid var(--border);
				background: color-mix(in oklch, var(--background) 54%, transparent);
			}
			.rich-git-diff-summary {
				min-width: 0;
				display: flex;
				align-items: center;
				gap: 8px;
				flex-wrap: wrap;
				color: var(--muted-foreground);
			}
			.rich-git-diff-title {
				max-width: min(52vw, 520px);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				color: var(--foreground);
				font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
			}
			.rich-git-diff-pill {
				display: inline-flex;
				align-items: center;
				min-height: 24px;
				padding: 3px 8px;
				border: 1px solid var(--border);
				border-radius: 999px;
				background: color-mix(in oklch, var(--card) 80%, transparent);
				color: var(--foreground);
				font-size: 12px;
				white-space: nowrap;
			}
			.rich-git-diff-controls { display: flex; align-items: center; gap: 8px; }
			.rich-git-diff-mode-toggle {
				display: inline-flex;
				gap: 2px;
				padding: 2px;
				border: 1px solid var(--border);
				border-radius: 8px;
				background: color-mix(in oklch, var(--background) 62%, transparent);
			}
			.rich-git-diff-mode-button,
			.rich-git-diff-icon-button {
				width: 30px;
				height: 28px;
				padding: 0;
				display: inline-grid;
				place-items: center;
				border: 0;
				border-radius: 6px;
				background: transparent;
				color: var(--muted-foreground);
				cursor: pointer;
			}
			.rich-git-diff-icon-button {
				border: 1px solid var(--border);
				border-radius: 8px;
				background: color-mix(in oklch, var(--card) 92%, var(--background));
			}
			.rich-git-diff-mode-button:hover,
			.rich-git-diff-icon-button:hover {
				color: var(--foreground);
				background: color-mix(in oklch, var(--primary) 9%, transparent);
			}
			.rich-git-diff-mode-button[aria-checked="true"] {
				background: color-mix(in oklch, var(--primary) 20%, transparent);
				color: var(--primary);
				box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary) 42%, var(--border));
			}
			.rich-git-diff-icon {
				width: 16px;
				height: 16px;
				fill: none;
				stroke: currentColor;
				stroke-width: 1.8;
				stroke-linecap: round;
				stroke-linejoin: round;
			}
			.rich-git-diff-content { padding: 12px; background: var(--card); }
			.rich-git-diff-truncated {
				display: flex;
				align-items: flex-start;
				gap: 10px;
				margin-bottom: 12px;
				padding: 10px 12px;
				border: 1px solid color-mix(in oklch, var(--warning) 38%, var(--border));
				border-radius: 12px;
				background: color-mix(in oklch, var(--warning) 10%, transparent);
				color: var(--foreground);
			}
			.rich-git-diff-list { display: grid; gap: 12px; }
			.rich-git-diff-file {
				overflow: hidden;
				border: 1px solid var(--border);
				border-radius: 12px;
				background: color-mix(in oklch, var(--card) 98%, var(--background));
				box-shadow: 0 10px 28px color-mix(in oklch, var(--foreground) 5%, transparent);
			}
			.rich-git-diff-file-header-row {
				display: flex;
				align-items: stretch;
				border-bottom: 1px solid var(--border);
				background: color-mix(in oklch, var(--muted-foreground) 8%, transparent);
			}
			.rich-git-diff-file.closed .rich-git-diff-file-header-row { border-bottom: 0; }
			.rich-git-diff-file-toggle {
				flex: 1 1 auto;
				min-width: 0;
				display: flex;
				align-items: center;
				gap: 10px;
				width: 100%;
				padding: 10px 12px;
				border: 0;
				background: transparent;
				color: inherit;
				text-align: left;
				cursor: pointer;
			}
			.rich-git-diff-file-toggle:hover { background: color-mix(in oklch, var(--primary) 7%, transparent); }
			.rich-git-diff-caret {
				width: 14px;
				color: var(--muted-foreground);
				font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
				transition: transform 140ms ease;
			}
			.rich-git-diff-file:not(.closed) .rich-git-diff-caret { transform: rotate(90deg); }
			.rich-git-diff-file-main { min-width: 0; display: grid; gap: 2px; }
			.rich-git-diff-path,
			.rich-git-diff-rename-path {
				min-width: 0;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
			}
			.rich-git-diff-path { color: var(--foreground); font-size: 12px; }
			.rich-git-diff-rename-path { color: var(--muted-foreground); font-size: 11px; }
			.rich-git-diff-status {
				display: inline-flex;
				align-items: center;
				min-height: 22px;
				padding: 2px 7px;
				border: 1px solid var(--border);
				border-radius: 999px;
				color: var(--muted-foreground);
				background: color-mix(in oklch, var(--card) 80%, transparent);
				font-size: 11px;
				white-space: nowrap;
			}
			.rich-git-diff-counts {
				margin-left: auto;
				display: inline-flex;
				align-items: center;
				gap: 8px;
				flex: 0 0 auto;
				font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
				font-weight: 800;
			}
			.rich-git-diff-add-count { color: var(--positive); }
			.rich-git-diff-del-count { color: var(--negative); }
			.rich-git-diff-overflow {
				overflow-x: auto;
				overflow-y: hidden;
				max-width: 100%;
				overscroll-behavior-x: contain;
				scrollbar-gutter: stable;
			}
			.rich-git-diff-split-grid { min-width: 980px; }
			.rich-git-diff-inline-lines { min-width: 660px; }
			.rich-git-diff-file-meta {
				padding: 6px 10px;
				border-bottom: 1px solid var(--border);
				color: var(--muted-foreground);
				background: color-mix(in oklch, var(--background) 54%, transparent);
				font: 11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
			}
			.rich-git-diff-hunk-header {
				display: grid;
				grid-template-columns: 74px minmax(0, 1fr);
				min-width: max-content;
				color: var(--muted-foreground);
				background: color-mix(in oklch, var(--info) 10%, transparent);
				font: 11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
			}
			.rich-git-diff-hunk-context-cell {
				min-height: 25px;
				padding: 3px;
				display: inline-flex;
				align-items: stretch;
				justify-content: center;
			}
			.rich-git-diff-hunk-signature {
				min-width: 0;
				padding: 3px 8px;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.rich-git-diff-context-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; width: 100%; }
			.rich-git-diff-context-toggle {
				width: 100%;
				height: 19px;
				padding: 0;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				border: 0;
				border-radius: 5px;
				background: color-mix(in oklch, var(--info) 12%, transparent);
				color: var(--muted-foreground);
				cursor: pointer;
			}
			.rich-git-diff-context-toggle:hover {
				background: color-mix(in oklch, var(--primary) 18%, transparent);
				color: var(--foreground);
			}
			.rich-git-diff-context-toggle svg {
				width: 16px;
				height: 16px;
				fill: none;
				stroke: currentColor;
				stroke-width: 2;
				stroke-linecap: round;
				stroke-linejoin: round;
			}
			.rich-git-diff-split-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); width: 100%; }
			.rich-git-diff-split-row .rich-git-diff-line:first-child { border-right: 1px solid var(--border); }
			.rich-git-diff-line {
				position: relative;
				width: 100%;
				min-height: 24px;
				display: grid;
				grid-template-columns: 44px 18px minmax(280px, 1fr);
				align-items: stretch;
				overflow: hidden;
				color: var(--foreground);
				font: 11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
				background: transparent;
			}
			.rich-git-diff-inline-lines .rich-git-diff-line { grid-template-columns: 44px 44px 18px minmax(280px, 1fr); }
			.rich-git-diff-line.add { background: color-mix(in oklch, var(--positive) 15%, transparent); }
			.rich-git-diff-line.del { background: color-mix(in oklch, var(--negative) 13%, transparent); }
			.rich-git-diff-line.meta { color: var(--muted-foreground); background: color-mix(in oklch, var(--muted-foreground) 7%, transparent); }
			.rich-git-diff-line.empty { color: transparent; pointer-events: none; }
			.rich-git-diff-line:not(.empty):hover {
				background: color-mix(in oklch, var(--primary) 6%, transparent);
				box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary) 32%, transparent);
			}
			.rich-git-diff-line-no,
			.rich-git-diff-prefix {
				padding: 3px 6px;
				color: var(--muted-foreground);
				user-select: none;
			}
			.rich-git-diff-line-no { text-align: right; }
			.rich-git-diff-prefix { text-align: center; }
			.rich-git-diff-line-text {
				min-width: 0;
				padding: 3px 8px;
				white-space: pre-wrap;
				overflow-wrap: anywhere;
			}
			.rich-git-diff-no-newline { color: var(--muted-foreground); font-style: italic; }
			.rich-git-diff-meta-only {
				display: grid;
				gap: 8px;
				padding: 14px;
				color: var(--muted-foreground);
			}
			.rich-git-diff-meta-only p { margin: 0; }
			.rich-git-diff-meta-only pre,
			.rich-git-diff-raw {
				margin: 0;
				padding: 12px;
				overflow: auto;
				border: 1px solid var(--border);
				border-radius: 10px;
				background: color-mix(in oklch, var(--background) 70%, transparent);
				color: var(--foreground);
				font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
				white-space: pre-wrap;
			}
			@media (max-width: 760px) {
				.rich-git-diff-toolbar { align-items: stretch; flex-direction: column; }
				.rich-git-diff-controls { justify-content: space-between; }
				.rich-git-diff-content { padding: 10px; }
				.rich-git-diff-title { max-width: 100%; }
				.rich-git-diff-path,
				.rich-git-diff-rename-path { white-space: normal; }
				.rich-git-diff-counts { gap: 6px; }
				.rich-git-diff-split-grid,
				.rich-git-diff-inline-lines { min-width: 0; }
				.rich-git-diff-split-row { display: contents; }
				.rich-git-diff-split-row .rich-git-diff-line:first-child { border-right: 0; }
				.rich-git-diff-split-row .rich-git-diff-line.empty { display: none; }
				.rich-git-diff-line { grid-template-columns: 42px 42px 18px minmax(180px, 1fr); }
			}
		</style>`;
	}
}
