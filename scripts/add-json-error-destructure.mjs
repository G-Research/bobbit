#!/usr/bin/env node
/**
 * For each routes/*.ts file: find handler arrow-fn signatures that destructure
 * `json` but not `jsonError`, and add `jsonError` to the destructure.
 *
 * Pattern: `handler: (async )?(\{[^}]*\}) =>`
 * Also: standalone `({ ... }) =>` inside handler arrays.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "src/server/routes";
const SKIP = new Set(["route-helpers.ts", "dispatcher.ts"]);

const files = fs.readdirSync(ROOT).filter(f => f.endsWith(".ts") && !SKIP.has(f));

for (const f of files) {
	const fp = path.join(ROOT, f);
	const orig = fs.readFileSync(fp, "utf8");
	let out = orig;
	// Match destructure objects in arrow-fn params: `({ ... }) =>`
	// Use a regex that captures the inside.
	out = out.replace(/\(\{([^{}]*)\}\)\s*=>/g, (whole, inside) => {
		// Skip if not a route handler signature: must contain `deps` or `json` or `params`.
		if (!/\b(deps|json|params|readBody|res|req|url|sandboxScope)\b/.test(inside)) return whole;
		// Collect identifiers (top-level, comma-separated).
		const names = inside.split(",").map(s => s.trim()).filter(Boolean);
		const has = (n) => names.some(x => x === n || x.startsWith(`${n}:`));
		if (!has("jsonError")) {
			names.push("jsonError");
		}
		return `({ ${names.join(", ")} }) =>`;
	});
	if (out !== orig) {
		fs.writeFileSync(fp, out);
		console.log(`updated ${f}`);
	}
}
