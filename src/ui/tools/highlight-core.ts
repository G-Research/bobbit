// Bundle-friendly highlight.js wrapper.
//
// We import `highlight.js/lib/core` (no grammars) and explicitly register a
// small eager set covering the ~95% of file types our agents actually write.
// Anything outside that set is lazily fetched on first render via
// `ensureLanguage()` — Vite emits one tiny chunk per grammar.
//
// NEVER `import hljs from "highlight.js"` anywhere in this codebase — that
// pulls in all ~195 grammars (~900 kB raw) and re-inflates the artifacts
// chunk. Import from this module instead.

import type { LanguageFn } from "highlight.js";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);

// `html` is just an alias for `xml` in highlight.js. Register it so consumers
// can pass either name and stay on the eager path.
hljs.registerAliases(["html"], { languageName: "xml" });

export { hljs };

// Pre-declare the full grammar candidate set so Vite emits one tiny chunk per
// language. The eager set above is already loaded — the rest are loaded on
// demand by `ensureLanguage()`. We use `import.meta.glob` so the bundler can
// statically discover every candidate; a bare-specifier template literal in
// `import()` won't be analysed.
// The package ships both `<lang>.js` (the real grammar) and `<lang>.js.js`
// (a deprecation shim that emits `console.warn`). Match only the real ones.
const grammarLoaders = import.meta.glob<{ default: LanguageFn }>([
	"/node_modules/highlight.js/lib/languages/*.js",
	"!/node_modules/highlight.js/lib/languages/*.js.js",
]);

/** Map grammar names (`"rust"`) to their loader. Built from the glob keys. */
const grammarByName = new Map<string, () => Promise<{ default: LanguageFn }>>();
for (const [path, loader] of Object.entries(grammarLoaders)) {
	const name = path.split("/").pop()?.replace(/\.js$/, "");
	if (name) grammarByName.set(name, loader);
}

/** Pending dynamic-import promises so concurrent ensureLanguage() calls coalesce. */
const pending = new Map<string, Promise<boolean>>();
/** Names we've already tried and failed to load — avoid hammering 404s. */
const failed = new Set<string>();

/**
 * Ensure a grammar is registered. No-op if already loaded (eager set or
 * previously fetched). Otherwise dynamic-imports the grammar from
 * `highlight.js/lib/languages/<lang>.js` and registers it.
 *
 * @returns `true` if the language is available after this call, `false`
 *          otherwise (unknown grammar, fetch failed). Callers should fall back
 *          to escaped plain text on `false`.
 */
export async function ensureLanguage(lang: string): Promise<boolean> {
	if (!lang) return false;
	if (hljs.getLanguage(lang)) return true;
	if (failed.has(lang)) return false;
	const loader = grammarByName.get(lang);
	if (!loader) {
		failed.add(lang);
		return false;
	}
	let p = pending.get(lang);
	if (!p) {
		p = (async () => {
			try {
				const mod = await loader();
				hljs.registerLanguage(lang, mod.default ?? (mod as unknown as LanguageFn));
				return true;
			} catch {
				failed.add(lang);
				return false;
			} finally {
				pending.delete(lang);
			}
		})();
		pending.set(lang, p);
	}
	return p;
}

/** Escape HTML for the unhighlighted plain-text fallback. */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
