/**
 * Convert ANSI escape codes to HTML spans with inline styles.
 * Supports SGR codes: reset, bold, dim, italic, underline, inverse,
 * foreground/background colors (standard + bright), and 256-color mode.
 */

// Standard ANSI colors — use CSS custom properties so they adapt to light/dark themes.
// Fallback values are for dark mode; light mode overrides are defined in app.css.
const COLORS_16 = [
	"var(--ansi-black, #555)",    // 0: black
	"var(--ansi-red, #f55)",      // 1: red
	"var(--ansi-green, #5f5)",    // 2: green
	"var(--ansi-yellow, #fc5)",   // 3: yellow
	"var(--ansi-blue, #55f)",     // 4: blue
	"var(--ansi-magenta, #f5f)",  // 5: magenta
	"var(--ansi-cyan, #5dd)",     // 6: cyan
	"var(--ansi-white, #ccc)",    // 7: white
	"var(--ansi-bright-black, #888)",    // 8: bright black
	"var(--ansi-bright-red, #f77)",      // 9: bright red
	"var(--ansi-bright-green, #7f7)",    // 10: bright green
	"var(--ansi-bright-yellow, #ff7)",   // 11: bright yellow
	"var(--ansi-bright-blue, #77f)",     // 12: bright blue
	"var(--ansi-bright-magenta, #f7f)",  // 13: bright magenta
	"var(--ansi-bright-cyan, #7ff)",     // 14: bright cyan
	"var(--ansi-bright-white, #fff)",    // 15: bright white
];

function color256(n: number): string {
	if (n < 16) return COLORS_16[n];
	if (n < 232) {
		// 6×6×6 cube: 16 + 36*r + 6*g + b
		const idx = n - 16;
		const b = (idx % 6) * 51;
		const g = (Math.floor(idx / 6) % 6) * 51;
		const r = Math.floor(idx / 36) * 51;
		return `rgb(${r},${g},${b})`;
	}
	// Grayscale: 232-255 → 8, 18, ..., 238
	const v = (n - 232) * 10 + 8;
	return `rgb(${v},${v},${v})`;
}

interface AnsiState {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	fg: string | null;
	bg: string | null;
}

function stateToStyle(s: AnsiState): string {
	const parts: string[] = [];
	if (s.bold) parts.push("font-weight:bold");
	if (s.dim) parts.push("opacity:0.6");
	if (s.italic) parts.push("font-style:italic");
	if (s.underline) parts.push("text-decoration:underline");
	if (s.inverse) {
		// Swap fg/bg; use defaults if not set
		const fg = s.bg || "var(--console-bg, #1e1e1e)";
		const bg = s.fg || "var(--console-fg, currentColor)";
		parts.push(`color:${fg}`, `background-color:${bg}`);
	} else {
		if (s.fg) parts.push(`color:${s.fg}`);
		if (s.bg) parts.push(`background-color:${s.bg}`);
	}
	return parts.join(";");
}

function resetState(): AnsiState {
	return { bold: false, dim: false, italic: false, underline: false, inverse: false, fg: null, bg: null };
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Parse ANSI escape sequences and return HTML with styled spans.
 */
export function ansiToHtml(input: string): string {
	if (!input) return "";

	// Fast path: no escape sequences at all
	if (!input.includes("\x1b") && !input.includes("\u001b")) {
		return escapeHtml(input);
	}

	const result: string[] = [];
	let state = resetState();
	let spanOpen = false;

	// Match ESC[ ... m sequences (SGR) and everything between them
	const re = /\x1b\[([0-9;]*)m/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = re.exec(input)) !== null) {
		// Emit text before this escape
		if (match.index > lastIndex) {
			const text = input.slice(lastIndex, match.index);
			if (text) {
				const style = stateToStyle(state);
				if (style) {
					if (spanOpen) result.push("</span>");
					result.push(`<span style="${style}">`);
					spanOpen = true;
				} else if (spanOpen) {
					result.push("</span>");
					spanOpen = false;
				}
				result.push(escapeHtml(text));
			}
		}
		lastIndex = re.lastIndex;

		// Parse SGR codes
		const codes = match[1] ? match[1].split(";").map(Number) : [0];
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i];
			if (c === 0) {
				state = resetState();
			} else if (c === 1) {
				state.bold = true;
			} else if (c === 2) {
				state.dim = true;
			} else if (c === 3) {
				state.italic = true;
			} else if (c === 4) {
				state.underline = true;
			} else if (c === 7) {
				state.inverse = true;
			} else if (c === 22) {
				state.bold = false;
				state.dim = false;
			} else if (c === 23) {
				state.italic = false;
			} else if (c === 24) {
				state.underline = false;
			} else if (c === 27) {
				state.inverse = false;
			} else if (c >= 30 && c <= 37) {
				state.fg = COLORS_16[c - 30];
			} else if (c === 38) {
				// Extended foreground: 38;5;n (256-color) or 38;2;r;g;b (truecolor)
				if (codes[i + 1] === 5 && i + 2 < codes.length) {
					state.fg = color256(codes[i + 2]);
					i += 2;
				} else if (codes[i + 1] === 2 && i + 4 < codes.length) {
					state.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
					i += 4;
				}
			} else if (c === 39) {
				state.fg = null;
			} else if (c >= 40 && c <= 47) {
				state.bg = COLORS_16[c - 40];
			} else if (c === 48) {
				// Extended background
				if (codes[i + 1] === 5 && i + 2 < codes.length) {
					state.bg = color256(codes[i + 2]);
					i += 2;
				} else if (codes[i + 1] === 2 && i + 4 < codes.length) {
					state.bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
					i += 4;
				}
			} else if (c === 49) {
				state.bg = null;
			} else if (c >= 90 && c <= 97) {
				state.fg = COLORS_16[c - 90 + 8];
			} else if (c >= 100 && c <= 107) {
				state.bg = COLORS_16[c - 100 + 8];
			}
		}
	}

	// Emit remaining text
	if (lastIndex < input.length) {
		const text = input.slice(lastIndex);
		if (text) {
			const style = stateToStyle(state);
			if (style) {
				if (spanOpen) result.push("</span>");
				result.push(`<span style="${style}">`);
				spanOpen = true;
			} else if (spanOpen) {
				result.push("</span>");
				spanOpen = false;
			}
			result.push(escapeHtml(text));
		}
	}

	if (spanOpen) result.push("</span>");

	// Strip any remaining non-SGR escape sequences (cursor moves, etc.)
	return result.join("").replace(/\x1b\[[0-9;]*[A-HJKSTfhilmnsu]/g, "");
}

/** Check if a string contains any ANSI escape sequences */
export function hasAnsi(input: string): boolean {
	return /\x1b\[/.test(input);
}
