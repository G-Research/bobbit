#!/usr/bin/env node
// Profile real session JSONL files for size + content shape.
//
// Read-only investigation. Scans a directory of agent-CLI session
// transcripts and emits aggregate stats as JSON on stdout. Intended
// to feed `docs/perf/real-session-profile.md` and nothing else.
//
// Usage:
//   node scripts/perf-profile-real-sessions.mjs [root]
//   node scripts/perf-profile-real-sessions.mjs C:/Users/jsubr/.bobbit/agent/sessions
//
// Defaults to scanning ~/.bobbit/agent/sessions if no arg given.
// Skips e2e / manual-integration fixture dirs (they aren't real usage).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root =
	process.argv[2] || path.join(os.homedir(), ".bobbit/agent/sessions");

const SKIP_SUBSTR = ["bobbit-e2e", "bobbit-manual-", "bobbit-observe-", "bobbit-restart-"];

function isRealSessionDir(name) {
	for (const s of SKIP_SUBSTR) if (name.includes(s)) return false;
	return true;
}

function pct(arr, p) {
	if (!arr.length) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

function fmtBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const dirs = fs
	.readdirSync(root, { withFileTypes: true })
	.filter((d) => d.isDirectory() && isRealSessionDir(d.name))
	.map((d) => path.join(root, d.name));

const files = [];
for (const d of dirs) {
	for (const f of fs.readdirSync(d)) {
		if (!f.endsWith(".jsonl")) continue;
		const full = path.join(d, f);
		const st = fs.statSync(full);
		if (st.size === 0) continue;
		files.push({ path: full, size: st.size });
	}
}

// Sort biggest first; we'll dive into largest files for content shape.
files.sort((a, b) => b.size - a.size);

const corpus = {
	root,
	fileCount: files.length,
	totalBytes: files.reduce((s, f) => s + f.size, 0),
	sizeP50: pct(files.map((f) => f.size), 50),
	sizeP95: pct(files.map((f) => f.size), 95),
	sizeMax: files[0]?.size ?? 0,
};

// Sampling: take a stratified sample for line-level analysis.
// Skip 0-byte / tiny files (< 4KB) — they're aborted sessions.
// Files are sorted biggest first. Take 20 largest + 10 mid-range to get
// representation of real heavy sessions (which dominate perceived load)
// without missing the medium-session shape.
const sampleCandidates = files.filter((f) => f.size > 4096);
function sampleStratified(arr, k) {
	if (arr.length <= k) return arr;
	const step = arr.length / k;
	const out = [];
	for (let i = 0; i < k; i++) out.push(arr[Math.floor(i * step)]);
	return out;
}
const top20 = sampleCandidates.slice(0, 20);
const minTop = top20.at(-1)?.size ?? Infinity;
const midRange = sampleCandidates.filter((f) => f.size >= 16_384 && f.size < minTop);
const sample = [...top20, ...sampleStratified(midRange, 10)];

const typeCounts = {};            // line.type -> count
const roleCounts = {};            // message.role -> count
const blockTypeCounts = {};       // block.type -> count
const toolUseCount = {};          // tool name -> count
const toolResultBytesByTool = {}; // tool name -> [bytes]
const toolResultBytesAll = [];
const lineBytesByType = {};       // type -> [bytes]
const fileStats = [];             // {file,lines,bytes,types}
const largeBlobs = [];            // {bytes, sample, file}

function bucket(map, key) {
	if (!map[key]) map[key] = [];
	return map[key];
}

for (const f of sample) {
	const data = fs.readFileSync(f.path, "utf8");
	const lines = data.split("\n").filter(Boolean);
	const types = {};
	for (const line of lines) {
		const bytes = Buffer.byteLength(line, "utf8");
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			typeCounts.__parse_error__ = (typeCounts.__parse_error__ || 0) + 1;
			continue;
		}
		const t = o.type || "unknown";
		typeCounts[t] = (typeCounts[t] || 0) + 1;
		types[t] = (types[t] || 0) + 1;
		bucket(lineBytesByType, t).push(bytes);

		if (t === "message" && o.message) {
			const role = o.message.role || "unknown";
			roleCounts[role] = (roleCounts[role] || 0) + 1;
			const content = o.message.content;
			if (Array.isArray(content)) {
				for (const b of content) {
					if (!b || typeof b !== "object") continue;
					const bt = b.type || "unknown";
					blockTypeCounts[bt] = (blockTypeCounts[bt] || 0) + 1;
					if ((bt === "toolCall" || bt === "tool_use") && b.name) {
						toolUseCount[b.name] = (toolUseCount[b.name] || 0) + 1;
					}
				}
				// toolResult-role lines carry `message.toolName` directly.
				if (role === "toolResult") {
					toolResultBytesAll.push(bytes);
					const name = o.message.toolName || "_unknown_";
					bucket(toolResultBytesByTool, name).push(bytes);
				}
				if (role === "toolResult" && bytes > 50_000) {
					// Capture shape hint without raw content.
					let textLen = 0,
						firstChars = "",
						blockCount = content.length;
					for (const b of content) {
						if (b && typeof b === "object" && typeof b.text === "string") {
							textLen += b.text.length;
							if (!firstChars) firstChars = b.text.slice(0, 80);
						}
					}
					largeBlobs.push({
						bytes,
						textLen,
						blockCount,
						toolName: o.message.toolName || "_unknown_",
						leadShape: shapeHint(firstChars),
						file: path.basename(f.path),
					});
				}
			}
		}
	}
	fileStats.push({ file: path.basename(f.path), bytes: f.size, lines: lines.length, types });
}

function shapeHint(s) {
	if (!s) return "empty";
	const trimmed = s.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "JSON";
	if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) return "path-list";
	if (/^\d+:/.test(trimmed)) return "line-numbered (rg/grep or Read)";
	if (/^Exit code:/.test(trimmed)) return "bash output";
	if (/^Error:|^error:/.test(trimmed)) return "error";
	if (/^---/.test(trimmed) || /^# /.test(trimmed)) return "markdown/diff";
	if (/<[a-z]+/i.test(trimmed)) return "HTML/XML";
	return "free text";
}

largeBlobs.sort((a, b) => b.bytes - a.bytes);

// Compose result
const lineCountStats = fileStats.map((f) => f.lines);
const toolResultBytes = toolResultBytesAll;
const result = {
	corpus,
	sample: {
		count: sample.length,
		linesP50: pct(lineCountStats, 50),
		linesP95: pct(lineCountStats, 95),
		linesMax: Math.max(...lineCountStats, 0),
	},
	lineTypes: typeCounts,
	roles: roleCounts,
	blocks: blockTypeCounts,
	tools: Object.entries(toolUseCount)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20)
		.map(([name, count]) => ({ name, count })),
	toolResultLineBytes: {
		count: toolResultBytes.length,
		p50: pct(toolResultBytes, 50),
		p95: pct(toolResultBytes, 95),
		p99: pct(toolResultBytes, 99),
		max: Math.max(...toolResultBytes, 0),
		fracOver4k: toolResultBytes.filter((b) => b > 4_096).length / (toolResultBytes.length || 1),
		fracOver50k: toolResultBytes.filter((b) => b > 50_000).length / (toolResultBytes.length || 1),
		fracOver500k: toolResultBytes.filter((b) => b > 500_000).length / (toolResultBytes.length || 1),
	},
	toolResultBytesByTool: Object.entries(toolResultBytesByTool)
		.map(([name, arr]) => ({
			name,
			count: arr.length,
			p50: pct(arr, 50),
			p95: pct(arr, 95),
			max: Math.max(...arr, 0),
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, 15),
	largeBlobs: largeBlobs.slice(0, 10).map((b) => ({
		bytes: b.bytes,
		textLen: b.textLen,
		blocks: b.blockCount,
		tool: b.toolName,
		shape: b.leadShape,
		file: b.file,
	})),
	lineBytesByType: Object.fromEntries(
		Object.entries(lineBytesByType).map(([t, arr]) => [
			t,
			{ count: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), max: Math.max(...arr, 0) },
		]),
	),
	fileStatsTop: fileStats.slice(0, 10).map((f) => ({
		file: f.file,
		bytes: f.bytes,
		bytesFmt: fmtBytes(f.bytes),
		lines: f.lines,
	})),
};

process.stdout.write(JSON.stringify(result, null, 2));
