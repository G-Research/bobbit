import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { ChevronDown } from "lucide";
import { state } from "./state.js";

/** Collect unique working directories from sessions and goals, most recent first. */
export function getRecentCwds(): Array<{ path: string; source: string }> {
	const seen = new Set<string>();
	const results: Array<{ path: string; source: string }> = [];

	// Sessions (sorted by lastActivity descending)
	const sessions = [...state.gatewaySessions]
		.filter((s) => s.cwd && s.assistantType !== "goal" && !s.delegateOf)
		.sort((a, b) => b.lastActivity - a.lastActivity);
	for (const s of sessions) {
		const p = s.cwd;
		if (!seen.has(p)) {
			seen.add(p);
			results.push({ path: p, source: "session" });
		}
	}

	// Goals
	const goals = [...state.goals].sort((a, b) => b.updatedAt - a.updatedAt);
	for (const g of goals) {
		const p = g.repoPath || g.cwd;
		if (p && !seen.has(p)) {
			seen.add(p);
			results.push({ path: p, source: "goal" });
		}
	}
	return results;
}

export interface CwdComboboxProps {
	value: string;
	placeholder?: string;
	onInput: (value: string) => void;
	onSelect: (value: string) => void;
	dropdownOpen: boolean;
	onToggle: (open: boolean) => void;
	highlightedIndex?: number;
	onHighlight?: (index: number) => void;
}

/**
 * Render a cwd combobox: text input with a dropdown of recent working directories.
 */
export function cwdCombobox(opts: CwdComboboxProps) {
	const allCwds = getRecentCwds();
	const query = opts.value.toLowerCase();
	const filtered = query
		? allCwds.filter((c) => c.path.toLowerCase().includes(query))
		: allCwds;

	const selectItem = (path: string) => {
		opts.onSelect(path);
		opts.onToggle(false);
	};

	// Close dropdown on blur. Dropdown items and the chevron use mousedown+preventDefault,
	// so blur only fires for outside clicks or tab — safe to close on next frame.
	const handleBlur = () => {
		requestAnimationFrame(() => {
			opts.onToggle(false);
			opts.onHighlight?.(-1);
		});
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (!opts.dropdownOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			e.preventDefault();
			opts.onToggle(true);
			return;
		}
		if (!opts.dropdownOpen) return;

		const items = filtered;
		const idx = opts.highlightedIndex ?? -1;

		if (e.key === "ArrowDown") {
			e.preventDefault();
			opts.onHighlight?.(Math.min(idx + 1, items.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			opts.onHighlight?.(Math.max(idx - 1, 0));
		} else if (e.key === "Enter" && idx >= 0 && idx < items.length) {
			e.preventDefault();
			selectItem(items[idx].path);
			opts.onHighlight?.(-1);
		} else if (e.key === "Escape") {
			e.preventDefault();
			opts.onToggle(false);
			opts.onHighlight?.(-1);
		}
	};

	const highlightedIdx = opts.highlightedIndex ?? -1;

	return html`
		<div class="cwd-combobox">
			<div class="relative flex items-center">
				<input
					type="text"
					role="combobox"
					aria-expanded=${opts.dropdownOpen}
					aria-autocomplete="list"
					aria-controls="cwd-listbox"
					class="flex w-full min-w-0 rounded-md border border-input bg-transparent text-foreground shadow-xs h-9 px-3 py-1 text-sm pr-8 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none dark:bg-input/30"
					.value=${opts.value}
					placeholder=${opts.placeholder || "(server default)"}
					@input=${(e: Event) => {
						opts.onInput((e.target as HTMLInputElement).value);
						if (!opts.dropdownOpen) opts.onToggle(true);
						opts.onHighlight?.(-1);
					}}
					@focus=${() => { if (allCwds.length > 0) opts.onToggle(true); }}
					@blur=${handleBlur}
					@keydown=${handleKeyDown}
				/>
				${allCwds.length > 0 ? html`
					<button
						type="button"
						class="absolute right-0 top-0 bottom-0 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
						title="Show recent directories"
						@mousedown=${(e: Event) => { e.preventDefault(); opts.onToggle(!opts.dropdownOpen); }}
						tabindex="-1"
					>
						${icon(ChevronDown, "xs")}
					</button>
				` : ""}
			</div>
			${opts.dropdownOpen && allCwds.length > 0 ? html`
				<div class="cwd-combobox-dropdown" role="listbox" id="cwd-listbox">
					${filtered.length > 0 ? filtered.map((c, i) => html`
						<div class="cwd-combobox-item"
							role="option"
							aria-selected=${i === highlightedIdx}
							?data-highlighted=${i === highlightedIdx}
							@mousedown=${(e: Event) => { e.preventDefault(); selectItem(c.path); }}>
							<span class="cwd-path" title=${c.path}>${c.path}</span>
							<span class="cwd-source">${c.source}</span>
						</div>
					`) : html`
						<div class="cwd-combobox-empty">No matching directories</div>
					`}
				</div>
			` : ""}
		</div>
	`;
}


