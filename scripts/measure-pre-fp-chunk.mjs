#!/usr/bin/env node
// Walk the entry chunk's static-import closure and report total gzipped size.
// Used by the pre-first-paint chunk-size unit test (and runnable manually
// to observe §G's win).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const distDir = join(process.cwd(), "dist", "ui");
const manifestPath = join(distDir, ".vite", "manifest.json");
if (!existsSync(manifestPath)) {
	console.error(`vite manifest missing at ${manifestPath} — run npm run build:ui first`);
	process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

// Find the unique entry. There must be exactly one.
const entries = Object.entries(manifest).filter(([, e]) => e.isEntry);
if (entries.length !== 1) {
	console.error(`expected exactly one entry, found ${entries.length}`);
	process.exit(1);
}
const [entryKey] = entries[0];

// Walk static `imports` only — `dynamicImports` are deferred and don't
// block first paint.
const visited = new Set();
const queue = [entryKey];
while (queue.length) {
	const k = queue.shift();
	if (visited.has(k)) continue;
	visited.add(k);
	const e = manifest[k];
	if (!e) continue;
	for (const i of e.imports ?? []) queue.push(i);
}

let total = 0;
const rows = [];
for (const k of visited) {
	const e = manifest[k];
	if (!e?.file) continue;
	const file = join(distDir, e.file);
	if (!existsSync(file)) continue;
	const sz = gzipSync(readFileSync(file)).length;
	total += sz;
	rows.push({ key: k, file: e.file, gz: sz });
}
rows.sort((a, b) => b.gz - a.gz);
const fmt = (b) => `${(b / 1024).toFixed(2)} KB`;
console.log(`pre-first-paint chunk closure (entry = ${entryKey}):`);
for (const r of rows) console.log(`  ${fmt(r.gz).padStart(10)}  ${r.file}  (${r.key})`);
console.log(`  ${"-".repeat(10)}`);
console.log(`  ${fmt(total).padStart(10)}  TOTAL`);
