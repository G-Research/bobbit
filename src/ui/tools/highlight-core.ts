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

// Lazy-load long-tail languages via an explicit static map. Each entry is a
// fixed-specifier `import()` so Vite emits one tiny chunk per grammar (~1–4 kB
// gzipped) and esbuild iife test-fixture bundles can statically resolve each
// call. The list covers the common languages Bobbit users open as artifacts
// beyond the eager set; anything outside this list falls back to escaped
// plain text (callers handle the boolean return value).
const LAZY_GRAMMARS: Record<string, () => Promise<{ default: LanguageFn }>> = {
	c: () => import("highlight.js/lib/languages/c"),
	cpp: () => import("highlight.js/lib/languages/cpp"),
	csharp: () => import("highlight.js/lib/languages/csharp"),
	diff: () => import("highlight.js/lib/languages/diff"),
	django: () => import("highlight.js/lib/languages/django"),
	dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
	elixir: () => import("highlight.js/lib/languages/elixir"),
	elm: () => import("highlight.js/lib/languages/elm"),
	erlang: () => import("highlight.js/lib/languages/erlang"),
	fsharp: () => import("highlight.js/lib/languages/fsharp"),
	go: () => import("highlight.js/lib/languages/go"),
	gradle: () => import("highlight.js/lib/languages/gradle"),
	graphql: () => import("highlight.js/lib/languages/graphql"),
	groovy: () => import("highlight.js/lib/languages/groovy"),
	haskell: () => import("highlight.js/lib/languages/haskell"),
	ini: () => import("highlight.js/lib/languages/ini"),
	java: () => import("highlight.js/lib/languages/java"),
	kotlin: () => import("highlight.js/lib/languages/kotlin"),
	latex: () => import("highlight.js/lib/languages/latex"),
	less: () => import("highlight.js/lib/languages/less"),
	lua: () => import("highlight.js/lib/languages/lua"),
	makefile: () => import("highlight.js/lib/languages/makefile"),
	nginx: () => import("highlight.js/lib/languages/nginx"),
	objectivec: () => import("highlight.js/lib/languages/objectivec"),
	ocaml: () => import("highlight.js/lib/languages/ocaml"),
	perl: () => import("highlight.js/lib/languages/perl"),
	php: () => import("highlight.js/lib/languages/php"),
	plaintext: () => import("highlight.js/lib/languages/plaintext"),
	powershell: () => import("highlight.js/lib/languages/powershell"),
	prolog: () => import("highlight.js/lib/languages/prolog"),
	properties: () => import("highlight.js/lib/languages/properties"),
	protobuf: () => import("highlight.js/lib/languages/protobuf"),
	puppet: () => import("highlight.js/lib/languages/puppet"),
	r: () => import("highlight.js/lib/languages/r"),
	ruby: () => import("highlight.js/lib/languages/ruby"),
	rust: () => import("highlight.js/lib/languages/rust"),
	scala: () => import("highlight.js/lib/languages/scala"),
	scheme: () => import("highlight.js/lib/languages/scheme"),
	scss: () => import("highlight.js/lib/languages/scss"),
	smalltalk: () => import("highlight.js/lib/languages/smalltalk"),
	swift: () => import("highlight.js/lib/languages/swift"),
	tcl: () => import("highlight.js/lib/languages/tcl"),
	toml: () => import("highlight.js/lib/languages/ini"), // toml ~ ini grammar
	twig: () => import("highlight.js/lib/languages/twig"),
	vala: () => import("highlight.js/lib/languages/vala"),
	verilog: () => import("highlight.js/lib/languages/verilog"),
	vbnet: () => import("highlight.js/lib/languages/vbnet"),
	vbscript: () => import("highlight.js/lib/languages/vbscript"),
};

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
	const loader = LAZY_GRAMMARS[lang.toLowerCase()];
	if (!loader) {
		failed.add(lang);
		return false;
	}
	let p = pending.get(lang);
	if (!p) {
		p = (async () => {
			try {
				const mod = await loader();
				hljs.registerLanguage(lang, mod.default);
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
