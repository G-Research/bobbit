import { icon } from "@mariozechner/mini-lit";
import { property, state } from "lit/decorators.js";
import { html, type TemplateResult } from "lit/html.js";
import { Check, Copy, Columns2, Rows2 } from "lucide";
import { BobbitElement } from "./base/BobbitElement.js";
import { LifecycleTimers } from "./base/lifecycle-timers.js";
import { i18n } from "../utils/i18n.js";

// ── Types ──────────────────────────────────────────────────────────────

interface DiffFile {
	header: string; // e.g. "a/src/app/main.ts → b/src/app/main.ts"
	hunks: DiffHunk[];
}

interface DiffHunk {
	header: string; // e.g. "@@ -94,10 +94,18 @@ let creatingSession = false;"
	lines: DiffLine[];
}

interface DiffLine {
	type: "context" | "add" | "remove";
	content: string;
	oldLineNo: number | null;
	newLineNo: number | null;
}

// ── Parser ─────────────────────────────────────────────────────────────

function parseDiff(raw: string): DiffFile[] {
	const files: DiffFile[] = [];
	const lines = raw.split("\n");
	let i = 0;

	while (i < lines.length) {
		// Find next "diff --git" line
		if (!lines[i].startsWith("diff --git ")) {
			i++;
			continue;
		}

		const diffLine = lines[i];
		const match = diffLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
		const header = match ? (match[1] === match[2] ? match[1] : `${match[1]} → ${match[2]}`) : diffLine;
		i++;

		// Skip index, ---, +++ lines
		while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
			i++;
		}

		const hunks: DiffHunk[] = [];

		// Parse hunks
		while (i < lines.length && !lines[i].startsWith("diff --git ")) {
			if (!lines[i].startsWith("@@")) {
				i++;
				continue;
			}

			const hunkHeader = lines[i];
			const hunkMatch = hunkHeader.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			let oldLine = hunkMatch ? parseInt(hunkMatch[1]) : 1;
			let newLine = hunkMatch ? parseInt(hunkMatch[2]) : 1;
			i++;

			const hunkLines: DiffLine[] = [];

			while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
				const line = lines[i];
				if (line.startsWith("+")) {
					hunkLines.push({ type: "add", content: line.slice(1), oldLineNo: null, newLineNo: newLine++ });
				} else if (line.startsWith("-")) {
					hunkLines.push({ type: "remove", content: line.slice(1), oldLineNo: oldLine++, newLineNo: null });
				} else if (line.startsWith(" ") || line === "") {
					hunkLines.push({ type: "context", content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
				} else if (line.startsWith("\\")) {
					// "\ No newline at end of file" — skip
				} else {
					break;
				}
				i++;
			}

			hunks.push({ header: hunkHeader, lines: hunkLines });
		}

		files.push({ header, hunks });
	}

	return files;
}

/** Build side-by-side line pairs from a hunk's lines. */
interface SidePair {
	left: DiffLine | null;
	right: DiffLine | null;
}

function buildSidePairs(lines: DiffLine[]): SidePair[] {
	const pairs: SidePair[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (line.type === "context") {
			pairs.push({ left: line, right: line });
			i++;
		} else if (line.type === "remove") {
			// Collect consecutive removes then pair with following adds
			const removes: DiffLine[] = [];
			while (i < lines.length && lines[i].type === "remove") {
				removes.push(lines[i]);
				i++;
			}
			const adds: DiffLine[] = [];
			while (i < lines.length && lines[i].type === "add") {
				adds.push(lines[i]);
				i++;
			}
			const max = Math.max(removes.length, adds.length);
			for (let j = 0; j < max; j++) {
				pairs.push({
					left: j < removes.length ? removes[j] : null,
					right: j < adds.length ? adds[j] : null,
				});
			}
		} else if (line.type === "add") {
			pairs.push({ left: null, right: line });
			i++;
		}
	}

	return pairs;
}

// ── Detect ─────────────────────────────────────────────────────────────

/** Returns true if the text looks like a unified git diff. */
export function isGitDiff(text: string): boolean {
	return /^diff --git /m.test(text) && /^@@ /m.test(text);
}

// ── Component ──────────────────────────────────────────────────────────

const MOBILE_BREAKPOINT = 768;

export class DiffBlock extends BobbitElement {
	@property() content: string = "";
	@state() private copied = false;
	/** null = auto (side-by-side on desktop, inline on mobile) */
	@state() private viewMode: "side-by-side" | "inline" | null = null;
	@state() private windowWidth = typeof window !== "undefined" ? window.innerWidth : 1024;

	private _timers = new LifecycleTimers(this.signal);

	private _resizeHandler = () => {
		this.windowWidth = window.innerWidth;
	};

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		// Re-attach: refresh the timers helper to bind to the new lifecycle signal.
		this._timers = new LifecycleTimers(this.signal);
		this.style.display = "block";
		window.addEventListener("resize", this._resizeHandler, { signal: this.signal });
	}

	private get effectiveMode(): "side-by-side" | "inline" {
		if (this.viewMode) return this.viewMode;
		return this.windowWidth >= MOBILE_BREAKPOINT ? "side-by-side" : "inline";
	}

	private async copy() {
		try {
			await navigator.clipboard.writeText(this.content || "");
			this.copied = true;
			this._timers.setTimeout(() => { this.copied = false; }, 1500);
		} catch (e) {
			console.error("Copy failed", e);
		}
	}

	private toggleMode() {
		this.viewMode = this.effectiveMode === "side-by-side" ? "inline" : "side-by-side";
	}

	// ── Rendering helpers ────────────────────────────────────────────

	private renderLineNo(n: number | null): TemplateResult {
		return html`<span class="diff-lineno select-none text-muted-foreground/50 text-right pr-2 shrink-0" style="min-width:3ch;display:inline-block">${n ?? ""}</span>`;
	}

	private lineClass(type: "context" | "add" | "remove"): string {
		switch (type) {
			case "add": return "bg-green-500/15 text-green-700 dark:text-green-400";
			case "remove": return "bg-red-500/15 text-red-700 dark:text-red-400";
			default: return "";
		}
	}

	private linePrefix(type: "context" | "add" | "remove"): string {
		switch (type) {
			case "add": return "+";
			case "remove": return "-";
			default: return " ";
		}
	}

	private renderInline(files: DiffFile[]): TemplateResult {
		return html`${files.map(file => html`
			<div class="diff-file">
				<div class="px-3 py-1 bg-muted/50 text-xs font-mono text-muted-foreground border-b border-border font-medium">${file.header}</div>
				${file.hunks.map(hunk => html`
					<div class="diff-hunk">
						<div class="px-3 py-0.5 bg-blue-500/10 text-xs font-mono text-blue-600 dark:text-blue-400 border-b border-border/50">${hunk.header}</div>
						${hunk.lines.map(line => html`
							<div class="flex font-mono text-xs leading-5 ${this.lineClass(line.type)} hover:brightness-95 dark:hover:brightness-110">
								${this.renderLineNo(line.oldLineNo)}
								${this.renderLineNo(line.newLineNo)}
								<span class="select-none shrink-0 w-4 text-center ${line.type === "add" ? "text-green-600 dark:text-green-500" : line.type === "remove" ? "text-red-600 dark:text-red-500" : "text-muted-foreground/30"}">${this.linePrefix(line.type)}</span>
								<span class="flex-1 whitespace-pre overflow-x-auto pr-3">${line.content}</span>
							</div>
						`)}
					</div>
				`)}
			</div>
		`)}`;
	}

	private renderSideBySide(files: DiffFile[]): TemplateResult {
		return html`${files.map(file => html`
			<div class="diff-file">
				<div class="px-3 py-1 bg-muted/50 text-xs font-mono text-muted-foreground border-b border-border font-medium">${file.header}</div>
				${file.hunks.map(hunk => {
					const pairs = buildSidePairs(hunk.lines);
					return html`
						<div class="diff-hunk">
							<div class="px-3 py-0.5 bg-blue-500/10 text-xs font-mono text-blue-600 dark:text-blue-400 border-b border-border/50">${hunk.header}</div>
							${pairs.map(pair => html`
								<div class="flex font-mono text-xs leading-5">
									<div class="flex flex-1 min-w-0 ${pair.left ? this.lineClass(pair.left.type) : ""} border-r border-border/30 hover:brightness-95 dark:hover:brightness-110">
										${this.renderLineNo(pair.left?.oldLineNo ?? null)}
										<span class="select-none shrink-0 w-4 text-center ${pair.left?.type === "remove" ? "text-red-600 dark:text-red-500" : "text-muted-foreground/30"}">${pair.left ? this.linePrefix(pair.left.type) : " "}</span>
										<span class="flex-1 whitespace-pre overflow-x-auto pr-2">${pair.left?.content ?? ""}</span>
									</div>
									<div class="flex flex-1 min-w-0 ${pair.right ? this.lineClass(pair.right.type) : ""} hover:brightness-95 dark:hover:brightness-110">
										${this.renderLineNo(pair.right?.newLineNo ?? null)}
										<span class="select-none shrink-0 w-4 text-center ${pair.right?.type === "add" ? "text-green-600 dark:text-green-500" : "text-muted-foreground/30"}">${pair.right ? this.linePrefix(pair.right.type) : " "}</span>
										<span class="flex-1 whitespace-pre overflow-x-auto pr-2">${pair.right?.content ?? ""}</span>
									</div>
								</div>
							`)}
						</div>
					`;
				})}
			</div>
		`)}`;
	}

	override render() {
		const files = parseDiff(this.content);
		if (files.length === 0) {
			// Fallback: not a parseable diff, show raw
			return html`<console-block .content=${this.content}></console-block>`;
		}

		const mode = this.effectiveMode;
		const isSideBySide = mode === "side-by-side";

		return html`
			<div class="border border-border rounded-lg overflow-hidden">
				<div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
					<span class="text-xs text-muted-foreground font-mono">${i18n("diff")} · ${files.length} file${files.length !== 1 ? "s" : ""}</span>
					<div class="flex items-center gap-1">
						<button
							@click=${() => this.toggleMode()}
							class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
							title="${isSideBySide ? "Switch to inline view" : "Switch to side-by-side view"}"
						>
							${isSideBySide ? icon(Rows2, "sm") : icon(Columns2, "sm")}
						</button>
						<button
							@click=${() => this.copy()}
							class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
							title="${i18n("Copy output")}"
						>
							${this.copied ? icon(Check, "sm") : icon(Copy, "sm")}
							${this.copied ? html`<span>${i18n("Copied!")}</span>` : ""}
						</button>
					</div>
				</div>
				<div class="overflow-auto max-h-[600px]">
					${isSideBySide ? this.renderSideBySide(files) : this.renderInline(files)}
				</div>
			</div>
		`;
	}
}

if (!customElements.get("diff-block")) {
	customElements.define("diff-block", DiffBlock);
}
