#!/usr/bin/env node
/**
 * For each `({ a, b, c }) => { ... }` arrow-fn in routes/*.ts:
 * remove any destructured names from a known set that are not referenced in the body.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "src/server/routes";
const SKIP = new Set(["route-helpers.ts", "dispatcher.ts"]);
const PRUNABLE = new Set(["json", "jsonError", "readBody", "params", "url", "req", "res", "deps", "sandboxScope", "pathname"]);

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

function findArrowBodyEnd(s, arrowEnd) {
	// arrowEnd is the index just past `=>`
	let i = arrowEnd;
	while (i < s.length && /\s/.test(s[i])) i++;
	if (s[i] === "{") {
		const end = skipToken(s, i);
		return { bodyStart: i + 1, bodyEnd: end - 1 };
	}
	// expression body: read until comma or close paren at top level (good enough)
	const start = i;
	let depth = 0;
	while (i < s.length) {
		const j = skipToken(s, i);
		if (j !== i) { i = j; continue; }
		const c = s[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) break;
			depth--;
		} else if (c === "," && depth === 0) break;
		i++;
	}
	return { bodyStart: start, bodyEnd: i };
}

function isReferenced(body, name) {
	const re = new RegExp(`\\b${name}\\b`);
	return re.test(body);
}

const files = fs.readdirSync(ROOT).filter(f => f.endsWith(".ts") && !SKIP.has(f));

for (const f of files) {
	const fp = path.join(ROOT, f);
	let src = fs.readFileSync(fp, "utf8");
	let out = "";
	let i = 0;
	let changed = false;
	while (i < src.length) {
		// Find next `({`
		const idx = src.indexOf("({", i);
		if (idx === -1) { out += src.slice(i); break; }
		// Output up to idx
		out += src.slice(i, idx);
		// Match destructure: `({ ... })` then optional whitespace then `=>`
		const closeBrace = src.indexOf("}", idx + 2);
		if (closeBrace === -1) { out += src.slice(idx); break; }
		// Restrict to top-level — simple heuristic: no `{` between `({` and `}`.
		const inside = src.slice(idx + 2, closeBrace);
		if (/[{}]/.test(inside)) {
			// nested object — skip
			out += src[idx];
			i = idx + 1;
			continue;
		}
		// Expect `})` then `=>`
		let p = closeBrace + 1;
		if (src[p] !== ")") {
			out += src[idx];
			i = idx + 1;
			continue;
		}
		p++;
		while (p < src.length && /\s/.test(src[p])) p++;
		if (src[p] !== "=" || src[p + 1] !== ">") {
			out += src[idx];
			i = idx + 1;
			continue;
		}
		const arrowEnd = p + 2;
		const { bodyStart, bodyEnd } = findArrowBodyEnd(src, arrowEnd);
		const body = src.slice(bodyStart, bodyEnd);
		// Parse names
		const names = inside.split(",").map(s => s.trim()).filter(Boolean);
		const kept = names.filter(n => {
			const baseName = n.split(":")[0].trim();
			if (!PRUNABLE.has(baseName)) return true;
			return isReferenced(body, baseName);
		});
		let newDestructure;
		if (kept.length === 0) {
			newDestructure = "()";
		} else {
			newDestructure = `({ ${kept.join(", ")} })`;
		}
		const oldDestructure = src.slice(idx, closeBrace + 2);
		if (newDestructure !== oldDestructure) changed = true;
		out += newDestructure;
		i = closeBrace + 2;
	}
	if (changed) {
		fs.writeFileSync(fp, out);
		console.log(`pruned ${f}`);
	}
}
