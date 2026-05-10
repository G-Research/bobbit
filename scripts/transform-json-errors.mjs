#!/usr/bin/env node
/**
 * Transform `json({ error: ... }, NNN)` calls in src/server/routes/*.ts
 * into `jsonError(NNN, ...)` calls. Preserves `ctx.json` prefix.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "src/server/routes";
const SKIP_FILES = new Set(["route-helpers.ts", "dispatcher.ts"]);

/**
 * Scan from index `i` skipping over a balanced unit. Handles strings, template
 * literals (with ${...}), comments, and nested brackets.
 *
 * Returns the index just past the unit, or i unchanged if `s[i]` isn't an
 * opening token. Use repeatedly inside parsers.
 */
function skipToken(s, i) {
	const c = s[i], n = s[i + 1];
	if (c === "/" && n === "/") {
		i += 2;
		while (i < s.length && s[i] !== "\n") i++;
		return i;
	}
	if (c === "/" && n === "*") {
		i += 2;
		while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
		return Math.min(s.length, i + 2);
	}
	if (c === '"' || c === "'") {
		const q = c; i++;
		while (i < s.length && s[i] !== q) {
			if (s[i] === "\\") i++;
			i++;
		}
		return i + 1;
	}
	if (c === "`") {
		i++;
		while (i < s.length && s[i] !== "`") {
			if (s[i] === "\\") { i += 2; continue; }
			if (s[i] === "$" && s[i + 1] === "{") {
				i += 2;
				// recursively skip code until matching `}`
				let depth = 1;
				while (i < s.length && depth > 0) {
					const j = skipToken(s, i);
					if (j !== i) { i = j; continue; }
					if (s[i] === "{") depth++;
					else if (s[i] === "}") depth--;
					if (depth === 0) { i++; break; }
					i++;
				}
				continue;
			}
			i++;
		}
		return i + 1;
	}
	if (c === "(" || c === "[" || c === "{") {
		const open = c;
		const close = c === "(" ? ")" : c === "[" ? "]" : "}";
		i++;
		let depth = 1;
		while (i < s.length && depth > 0) {
			const j = skipToken(s, i);
			if (j !== i) { i = j; continue; }
			if (s[i] === open) depth++;
			else if (s[i] === close) depth--;
			if (depth === 0) { i++; break; }
			i++;
		}
		return i;
	}
	return i;
}

function findMatchingBrace(s, openIdx) {
	if (s[openIdx] !== "{") return -1;
	const end = skipToken(s, openIdx);
	if (end <= openIdx) return -1;
	return end - 1; // position of closing '}'
}

// Parse a top-level object body (no surrounding braces) into properties.
function parseObjectProps(objBody) {
	const props = [];
	const s = objBody;
	let i = 0;
	while (i < s.length) {
		while (i < s.length && /[\s,]/.test(s[i])) i++;
		if (i >= s.length) break;
		if (s[i] === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) {
			i = skipToken(s, i); continue;
		}
		// parse key
		let key;
		if (s[i] === '"' || s[i] === "'") {
			const q = s[i]; i++;
			const start = i;
			while (i < s.length && s[i] !== q) {
				if (s[i] === "\\") i++;
				i++;
			}
			key = s.slice(start, i);
			i++;
		} else if (/[A-Za-z_$]/.test(s[i])) {
			const start = i;
			while (i < s.length && /[A-Za-z0-9_$]/.test(s[i])) i++;
			key = s.slice(start, i);
		} else {
			return null;
		}
		while (i < s.length && /\s/.test(s[i])) i++;
		if (s[i] !== ":") return null;
		i++;
		while (i < s.length && /\s/.test(s[i])) i++;
		// value: scan until top-level comma
		const valStart = i;
		while (i < s.length) {
			const j = skipToken(s, i);
			if (j !== i) { i = j; continue; }
			if (s[i] === ",") break;
			i++;
		}
		const value = s.slice(valStart, i).trim();
		props.push({ key, value });
	}
	return props;
}

function transformErrorValue(v) {
	v = v.trim();
	let m;
	if ((m = v.match(/^(\w+)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\(\s*\1\s*\)$/))) {
		return { mode: "raw", expr: m[1] };
	}
	if ((m = v.match(/^String\(\s*\((\w+)\s+as\s+Error\)\??\.message\s*\?\?\s*\1\s*\)$/))) {
		return { mode: "raw", expr: m[1] };
	}
	if ((m = v.match(/^\(\s*(\w+)\s+as\s+Error\s*\)\.message$/))) {
		return { mode: "raw", expr: m[1] };
	}
	if ((m = v.match(/^\((\w+)\s+as\s+Error\)\??\.message\s*\?\?\s*\1$/))) {
		return { mode: "raw", expr: m[1] };
	}
	return { mode: "wrap", expr: v };
}

function transformFile(filepath) {
	const orig = fs.readFileSync(filepath, "utf8");
	let out = orig;
	let changed = 0;
	let i = 0;
	while (i < out.length) {
		const idx = out.indexOf("json(", i);
		if (idx === -1) break;
		// must be a `json(` token, not `jsonError(` or part of other ident
		const before = out[idx - 1];
		if (before && /[A-Za-z0-9_$]/.test(before)) {
			// part of larger identifier
			i = idx + 1;
			continue;
		}
		// Skip if "json" is preceded by something that makes it an unexpected callee
		// Ensure following chars: `son(` already matched. Now check for `Error` after `json` — there isn't one; idx+5 is `(`.
		let p = idx + 5;
		while (p < out.length && /\s/.test(out[p])) p++;
		if (out[p] !== "{") { i = idx + 5; continue; }
		const closeBrace = findMatchingBrace(out, p);
		if (closeBrace === -1) { i = idx + 5; continue; }
		const objBody = out.slice(p + 1, closeBrace);
		if (!/\berror\s*:/.test(objBody)) { i = closeBrace + 1; continue; }
		let q = closeBrace + 1;
		while (q < out.length && /\s/.test(out[q])) q++;
		let status = null, endParen = -1;
		if (out[q] === ",") {
			q++;
			while (q < out.length && /\s/.test(out[q])) q++;
			const sStart = q;
			while (q < out.length && /[0-9]/.test(out[q])) q++;
			if (q === sStart) { i = closeBrace + 1; continue; }
			status = parseInt(out.slice(sStart, q), 10);
			while (q < out.length && /\s/.test(out[q])) q++;
			if (out[q] !== ")") { i = closeBrace + 1; continue; }
			endParen = q;
		} else if (out[q] === ")") {
			i = q + 1; continue; // no status, default 200
		} else {
			i = closeBrace + 1; continue;
		}
		if (status === null || status < 400) { i = endParen + 1; continue; }
		const props = parseObjectProps(objBody);
		if (!props) { i = endParen + 1; continue; }
		const errorProp = props.find(pp => pp.key === "error");
		if (!errorProp) { i = endParen + 1; continue; }
		const extras = props.filter(pp => pp.key !== "error");
		const t = transformErrorValue(errorProp.value);
		const errArg = t.mode === "raw" ? t.expr : `new Error(${t.expr})`;

		let prefixStart = idx;
		if (out.slice(idx - 4, idx) === "ctx.") prefixStart = idx - 4;
		const prefix = out.slice(prefixStart, idx);
		const calleeName = `${prefix}jsonError`;
		let extraStr = "";
		if (extras.length > 0) {
			const inner = extras.map(pp => {
				const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(pp.key) ? pp.key : JSON.stringify(pp.key);
				return `${safe}: ${pp.value}`;
			}).join(", ");
			extraStr = `, { ${inner} }`;
		}
		const replacement = `${calleeName}(${status}, ${errArg}${extraStr})`;
		out = out.slice(0, prefixStart) + replacement + out.slice(endParen + 1);
		changed++;
		i = prefixStart + replacement.length;
	}
	if (changed > 0) fs.writeFileSync(filepath, out);
	return changed;
}

const files = fs.readdirSync(ROOT).filter(f => f.endsWith(".ts") && !SKIP_FILES.has(f));
let total = 0;
for (const f of files) {
	const fp = path.join(ROOT, f);
	const n = transformFile(fp);
	if (n > 0) console.log(`${f}: ${n}`);
	total += n;
}
console.log(`Total: ${total}`);
