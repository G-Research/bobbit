/**
 * Sidebar-nav perf harness (Phase 1 + Phase 2A).
 *
 * Boots a real gateway, pre-seeds N=10 sessions with REALISTIC transcript
 * fixtures (Phase 2A: spec task 3b056b96), then drives the browser through
 * three passes — warm, goal, cold — dumping `window.__bobbitPerf.entries()`
 * after each pass plus a tail of the server's `[timing]` lines.
 *
 * NOT in CI. Run with:
 *   BOBBIT_TIMING_LOG=1 npx playwright test \
 *     --config playwright-manual.config.ts \
 *     --grep "perf-sidebar-nav"
 *
 * Outputs land under `tests/manual-integration/.perf-out/`:
 *   sidebar-nav-<ts>.json     raw client entries + server timing tail
 *   sidebar-nav-<ts>.html     sortable per-span table (p50/p95/p99/max/n)
 *
 * Fail-loud invariant (§2.4 of the design): if any of the five canonical
 * spans below has zero samples, the harness calls `process.exit(1)` after
 * dumping diagnostics. A silently-broken instrumentation must NOT pass with
 * empty data.
 *
 * Phase 2A — realistic transcript fixture
 * ---------------------------------------
 * The Phase 1 baseline measured against EMPTY sessions, so `reducer.rehydrate`
 * and `api.session.fetch` payload sizes were artificially zero. Phase 2A
 * pre-seeds each of the 10 sessions with N synthetic transcript messages
 * (mixing user text, assistant text, tool_use / tool_result blocks, and at
 * least one ≥50 KB tool-result blob).
 *
 * Mechanism (no `src/` changes): we stop the gateway after project
 * registration, write a real `sessions.json` with N **archived** session
 * rows pointing at synthetic JSONL files on disk, then restart the gateway.
 * The per-project `SessionStore` reads our seeded rows on boot; the WS
 * archived-attach path (`getArchivedMessages`) parses our JSONL and emits a
 * real `messages` frame to the client, which makes the message-reducer
 * actually rehydrate non-trivial state. The cold + warm passes navigate to
 * these archived sessions via `window.__bobbitOpenForNavItem` so the
 * `nav.click` / `nav.session.ready` instrumentation fires the same way it
 * does for live rows. The (separate) goal pass is unchanged.
 *
 * Env vars:
 *   BOBBIT_PERF_FIXTURE_SIZE = small | medium | large
 *     Selects 10 / 50 / 200 messages per session. Default `medium`.
 *   SCREENSHOTS=1 dumps full-page PNGs at each nav step under
 *     .perf-out/screens/.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, openSync, writeSync, closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { buildDefaultWorkflows } from "../../src/server/state-migration/seed-default-workflows.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");
const OUT_DIR = join(PROJECT_ROOT, "tests", "manual-integration", ".perf-out");
const WANT_SCREENSHOTS = !!process.env.SCREENSHOTS;

// Phase 2A fixture sizing. Order: small < medium < large.
const FIXTURE_SIZES = { small: 10, medium: 50, large: 200 } as const;
type FixtureSize = keyof typeof FIXTURE_SIZES;
function resolveFixtureSize(): { name: FixtureSize; msgsPerSession: number } {
	const raw = String(process.env.BOBBIT_PERF_FIXTURE_SIZE ?? "medium").toLowerCase();
	const name = (raw in FIXTURE_SIZES ? raw : "medium") as FixtureSize;
	return { name, msgsPerSession: FIXTURE_SIZES[name] };
}

const CANONICAL_GATE_SPANS = [
	"nav.session.ready",
	"nav.goal.ready",
	"api.session.fetch",
	"api.goal.fetch",
	"reducer.rehydrate",
] as const;

const ALL_SPANS = [
	"nav.click",
	"nav.session.ready",
	"nav.goal.ready",
	"nav.session.cold",
	"nav.goal.cold",
	"api.session.fetch",
	"api.goal.fetch",
	"api.goal.gates.fetch",
	"api.goal.agents.fetch",
	"ws.attach",
	"reducer.rehydrate",
	"paint.first",
	"paint.tool-content.lazy",
] as const;

// ---------------------------------------------------------------------------
// Gateway boot (cloned from restart-minimal.spec.ts)
// ---------------------------------------------------------------------------
interface GW {
	proc: ChildProcess;
	port: number;
	dir: string;
	token: string;
	base: string;
	defaultProjectId?: string;
	timingLines: string[];
	stdoutTap: number | null;
}

async function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); });
		s.on("error", rej);
	});
}

async function startGW(dir: string, port: number): Promise<GW> {
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	const proc = spawn(process.execPath, [
		SERVER_CLI, "--host", "127.0.0.1", "--port", String(port),
		"--no-tls", "--auth", "--cwd", dir,
	], {
		env: {
			...process.env,
			BOBBIT_DIR: join(dir, ".bobbit"),
			NODE_ENV: "test",
			BOBBIT_TIMING_LOG: process.env.BOBBIT_TIMING_LOG ?? "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	const timingLines: string[] = [];
	const stdoutLogPath = join(OUT_DIR, "gateway-stdout.log");
	mkdirSync(OUT_DIR, { recursive: true });
	const stdoutTap = openSync(stdoutLogPath, "w");
	proc.stderr!.on("data", (c: Buffer) => { stderr += c.toString(); });
	proc.stdout!.on("data", (c: Buffer) => {
		try { writeSync(stdoutTap, c); } catch { /* swallow */ }
		const s = c.toString();
		for (const line of s.split(/\r?\n/)) {
			if (line.startsWith("[timing]")) timingLines.push(line);
		}
	});
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error(`Gateway exited (${proc.exitCode}):\n${stderr}`);
		try {
			const tp = join(dir, ".bobbit", "state", "token");
			if (existsSync(tp)) {
				const t = readFileSync(tp, "utf-8").trim();
				const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${t}` } });
				if (r.ok) break;
			}
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 200));
	}
	if (Date.now() >= deadline) { proc.kill(); throw new Error(`Not healthy:\n${stderr}`); }
	const token = readFileSync(join(dir, ".bobbit", "state", "token"), "utf-8").trim();
	return { proc, port, dir, token, base: `http://127.0.0.1:${port}`, timingLines, stdoutTap };
}

async function stopGW(gw: GW): Promise<void> {
	try { if (gw.stdoutTap !== null) closeSync(gw.stdoutTap); } catch { /* swallow */ }
	if (gw.proc.exitCode === null) {
		if (process.platform === "win32") {
			try { execFileSync("taskkill", ["/PID", String(gw.proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 }); } catch { /* swallow */ }
		} else { gw.proc.kill(); }
	}
	await new Promise<void>((r) => {
		if (gw.proc.exitCode !== null) return r();
		gw.proc.on("exit", () => r());
		setTimeout(() => { try { gw.proc.kill("SIGKILL"); } catch { /* swallow */ } r(); }, 5_000);
	});
}

function api(gw: GW, path: string, opts: RequestInit = {}) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${gw.token}`,
		...((opts.headers as Record<string, string>) || {}),
	};
	return fetch(`${gw.base}${path}`, { ...opts, headers });
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
	return sorted[idx];
}

function summarise(entries: Array<{ name: string; dur: number }>) {
	const byName = new Map<string, number[]>();
	for (const e of entries) {
		if (!byName.has(e.name)) byName.set(e.name, []);
		byName.get(e.name)!.push(e.dur);
	}
	const rows: Array<{ name: string; n: number; p50: number; p95: number; p99: number; max: number; mean: number }> = [];
	for (const [name, durs] of byName) {
		const sorted = durs.slice().sort((a, b) => a - b);
		const sum = durs.reduce((s, v) => s + v, 0);
		rows.push({
			name,
			n: sorted.length,
			p50: percentile(sorted, 50),
			p95: percentile(sorted, 95),
			p99: percentile(sorted, 99),
			max: sorted[sorted.length - 1],
			mean: sum / durs.length,
		});
	}
	rows.sort((a, b) => b.p50 - a.p50);
	return rows;
}

function renderHtmlReport(opts: {
	timestamp: string;
	clientEntries: Array<{ name: string; dur: number; detail?: any }>;
	timingLines: string[];
}): string {
	const rows = summarise(opts.clientEntries);
	const fmt = (n: number) => n.toFixed(1);
	const rowsHtml = rows.map((r) => `
		<tr>
			<td class="name">${escapeHtml(r.name)}</td>
			<td class="n">${r.n}</td>
			<td>${fmt(r.p50)}</td>
			<td>${fmt(r.p95)}</td>
			<td>${fmt(r.p99)}</td>
			<td>${fmt(r.max)}</td>
			<td>${fmt(r.mean)}</td>
		</tr>
	`).join("");
	const timingHtml = opts.timingLines.slice(-100).map(escapeHtml).join("<br>");
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Sidebar Nav Perf — ${escapeHtml(opts.timestamp)}</title>
<style>
	:root {
		color-scheme: light dark;
		--bg: var(--background, #fff);
		--fg: var(--foreground, #111);
		--muted: var(--muted-foreground, #666);
		--border: var(--border, #ddd);
		--chart-1: var(--chart-1, #4f46e5);
	}
	body { font-family: system-ui, sans-serif; margin: 2rem; background: var(--bg); color: var(--fg); }
	h1 { font-size: 1.4rem; }
	table { border-collapse: collapse; margin-top: 1rem; width: 100%; }
	th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: right; font-variant-numeric: tabular-nums; }
	th { background: color-mix(in oklch, var(--chart-1) 10%, transparent); cursor: pointer; user-select: none; }
	td.name, th.name { text-align: left; font-family: ui-monospace, monospace; }
	td.n { text-align: right; color: var(--muted); }
	.bar-row { display: flex; align-items: center; gap: 0.5rem; margin: 4px 0; }
	.bar { background: var(--chart-1); height: 14px; border-radius: 2px; }
	.timing { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); margin-top: 2rem; max-height: 30vh; overflow: auto; padding: 1rem; border: 1px solid var(--border); border-radius: 4px; }
</style>
</head>
<body>
<h1>Sidebar Nav Perf — ${escapeHtml(opts.timestamp)}</h1>
<p>${opts.clientEntries.length} client entries · ${opts.timingLines.length} server [timing] lines</p>
<table id="t">
<thead><tr>
	<th class="name" data-sort="name">span</th>
	<th data-sort="n">n</th>
	<th data-sort="p50">p50 ms</th>
	<th data-sort="p95">p95 ms</th>
	<th data-sort="p99">p99 ms</th>
	<th data-sort="max">max ms</th>
	<th data-sort="mean">mean ms</th>
</tr></thead>
<tbody>${rowsHtml}</tbody>
</table>
<h2>Per-span p50 (client wall time)</h2>
${rows.map((r) => `
	<div class="bar-row">
		<span style="display:inline-block;width:200px;font-family:ui-monospace,monospace;font-size:12px;">${escapeHtml(r.name)}</span>
		<span class="bar" style="width: ${Math.min(600, r.p50 * 2)}px"></span>
		<span style="color:var(--muted);font-size:12px;">${fmt(r.p50)} ms</span>
	</div>`).join("")}
<h2>Server [timing] tail (last 100)</h2>
<div class="timing">${timingHtml}</div>
<script>
	// Tiny sortable behaviour
	const table = document.getElementById("t");
	for (const th of table.tHead.rows[0].cells) {
		th.addEventListener("click", () => {
			const key = th.dataset.sort;
			const colIdx = Array.from(th.parentElement.children).indexOf(th);
			const rows = Array.from(table.tBodies[0].rows);
			const numeric = key !== "name";
			rows.sort((a, b) => {
				const av = a.cells[colIdx].textContent.trim();
				const bv = b.cells[colIdx].textContent.trim();
				return numeric ? parseFloat(bv) - parseFloat(av) : av.localeCompare(bv);
			});
			for (const r of rows) table.tBodies[0].appendChild(r);
		});
	}
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
	return String(s).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]!);
}

// ---------------------------------------------------------------------------
// Phase 2A — realistic transcript fixture
// ---------------------------------------------------------------------------
// Deterministic-by-seed JSONL builder. Each line is a pi-coding-agent
// session-entry of `type:"message"`, matching the shape parsed by
// `src/server/agent/transcript-reader.ts::parseJsonl` and consumed by
// `getArchivedMessages` (which is what the WS archived-attach path reads to
// emit the snapshot frame).
//
// Mix (rough proportions per session):
//   ~50% interleaved user + assistant text messages
//   ~30% assistant tool_use + matching user tool_result pairs (5–10 pairs)
//   ~20% padding / chatter — short lines so total size scales gently
//
// At least one assistant tool_use is paired with a large (>=50 KB) tool_result
// blob to exercise the lazy-tool-content code path the Phase 2B optimisation
// targets. The blob is deterministic ASCII so JSONL gzip ratios match what we
// would see for real `bash` / `read_file` outputs (not random noise).

function _msgEntry(ts: string, id: string, role: string, content: unknown): string {
	return JSON.stringify({ type: "message", ts, id, message: { role, content } });
}

function _largeBlob(approxBytes: number, sessionIndex: number): string {
	// Build a deterministic, line-oriented blob (mimics a `ls -lR` / log dump).
	// 80-char lines so it looks like real tool output and compresses similarly.
	const lines: string[] = [];
	let bytes = 0;
	let i = 0;
	while (bytes < approxBytes) {
		const line = `2026-05-13T${String(10 + (i % 14)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}.${String((i * 31) % 1000).padStart(3, "0")}Z  s${sessionIndex} line ${i.toString().padStart(6, "0")}  ${"x".repeat(24)}`;
		lines.push(line);
		bytes += line.length + 1; // + newline
		i++;
	}
	return lines.join("\n");
}

function buildRealisticJsonl(sessionIndex: number, totalMsgs: number): string {
	// Aim for 5–10 tool-call/tool-result pairs (deterministic from sessionIndex).
	const toolPairs = Math.min(10, Math.max(5, 5 + (sessionIndex % 6)));
	const lines: string[] = [];
	const baseTs = Date.parse("2026-05-01T00:00:00.000Z");
	const stamp = (i: number) => new Date(baseTs + sessionIndex * 3_600_000 + i * 15_000).toISOString();
	const toolNames = ["bash", "read", "edit", "grep", "find", "write", "web_fetch"];

	// Spread tool pairs roughly evenly across the transcript.
	const toolPositions = new Set<number>();
	if (toolPairs > 0 && totalMsgs > 4) {
		const stride = Math.max(2, Math.floor((totalMsgs - 2) / toolPairs));
		for (let k = 0; k < toolPairs; k++) toolPositions.add(2 + k * stride);
	}
	// Designate one tool pair to carry the >=50 KB blob.
	const bigBlobPos = toolPositions.size > 0 ? [...toolPositions][Math.floor(toolPositions.size / 2)] : -1;

	let i = 0;
	let toolIdCounter = 0;
	while (lines.length < totalMsgs) {
		const ts = stamp(i);
		const entryId = `e-${sessionIndex}-${i}`;
		if (toolPositions.has(i) && lines.length + 1 < totalMsgs) {
			// Emit assistant tool_use + user tool_result pair (counts as 2 messages).
			const tname = toolNames[toolIdCounter % toolNames.length];
			const toolUseId = `toolu_${sessionIndex}_${toolIdCounter}`;
			toolIdCounter++;
			const inputs: Record<string, unknown> = tname === "bash"
				? { command: `ls -lR /workspace/sess-${sessionIndex} | head -n 40` }
				: tname === "read"
				? { path: `src/module-${i % 12}.ts`, offset: 1, limit: 80 }
				: tname === "edit"
				? { path: `src/module-${i % 12}.ts`, oldText: `// TODO ${i}`, newText: `// done ${i}` }
				: tname === "grep"
				? { pattern: `function\\s+name${i}`, path: "src/", glob: "*.ts" }
				: tname === "find"
				? { pattern: `**/*-${i % 7}.spec.ts`, path: "tests/" }
				: tname === "write"
				? { path: `out/result-${i}.txt`, content: `pass ${i}\n` }
				: { url: `https://example.test/api/${i}.json` };
			lines.push(_msgEntry(ts, entryId, "assistant", [
				{ type: "text", text: `Running ${tname} for step ${i} (session ${sessionIndex}).` },
				{ type: "tool_use", id: toolUseId, name: tname, input: inputs },
			]));
			const body = i === bigBlobPos
				? _largeBlob(60_000, sessionIndex) // >=50 KB blob
				: `ok\n${tname} completed in ${(i % 90) + 10}ms\n${"line " + i + "\n".repeat(1)}`.repeat(3);
			lines.push(_msgEntry(stamp(i + 1), `e-${sessionIndex}-${i}-r`, "user", [
				{ type: "tool_result", tool_use_id: toolUseId, content: body },
			]));
			i += 2;
			continue;
		}
		// Plain alternating user / assistant text.
		const isUser = i % 2 === 0;
		const role = isUser ? "user" : "assistant";
		const text = isUser
			? `Step ${i}: please look at module-${i % 12}.ts and confirm the edge case from issue #${1000 + sessionIndex * 17 + i}.`
			: `Looking at module-${i % 12}.ts now. The edge case at line ${30 + (i % 90)} reproduces with input ${i * 7 + sessionIndex}. Suggested fix: clamp the index before dispatching.`;
		const content = isUser ? text : [{ type: "text", text }];
		lines.push(_msgEntry(ts, entryId, role, content));
		i++;
	}
	return lines.join("\n") + "\n";
}

/**
 * Pre-seed N **archived** session rows in the project's `sessions.json` and
 * write a matching JSONL transcript for each. Must run while the gateway is
 * stopped — `SessionStore` reads `sessions.json` once at construction time
 * (in `ProjectContext.open()` / `initAll()` at gateway boot), and writes
 * back its in-memory view on mutation. Writing while the gateway is up
 * would either be clobbered by the next save or trip the stale-snapshot
 * guard.
 */
function seedArchivedFixtures(opts: {
	projectStateDir: string;
	projectId: string;
	count: number;
	msgsPerSession: number;
}): { ids: string[]; bytesByteSum: number } {
	const { projectStateDir, projectId, count, msgsPerSession } = opts;
	const jsonlDir = join(projectStateDir, "perf-fixture-sessions");
	mkdirSync(jsonlDir, { recursive: true });
	const ids: string[] = [];
	let bytesByteSum = 0;
	const now = Date.now();
	const rows: Record<string, unknown>[] = [];
	for (let i = 0; i < count; i++) {
		// Deterministic ID so multiple runs in the same dir are idempotent.
		const id = `00000000-perf-${String(i).padStart(4, "0")}-0000-000000000000`;
		const jsonlPath = join(jsonlDir, `${id}.jsonl`);
		const body = buildRealisticJsonl(i, msgsPerSession);
		writeFileSync(jsonlPath, body, "utf-8");
		bytesByteSum += Buffer.byteLength(body, "utf-8");
		ids.push(id);
		rows.push({
			id,
			title: `perf-fixture-${i} (${msgsPerSession} msgs)`,
			cwd: projectStateDir,
			agentSessionFile: jsonlPath,
			createdAt: now - (count - i) * 60_000,
			lastActivity: now - (count - i) * 30_000,
			projectId,
			archived: true,
			archivedAt: now - (count - i) * 10_000,
		});
	}
	// Read any existing sessions.json so we don't trample concurrent fixtures
	// (e.g. the goal pass's bare goal session, though it doesn't go through
	// this dir). Preserve unknown fields by re-emitting them.
	const storeFile = join(projectStateDir, "sessions.json");
	let existing: { version: number; epoch: number; sessions: any[] } = { version: 2, epoch: 0, sessions: [] };
	try {
		const raw = readFileSync(storeFile, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && parsed.version === 2 && Array.isArray(parsed.sessions)) {
			existing = parsed;
		}
	} catch { /* missing or unparseable — start fresh */ }
	// Drop any of our previous fixture rows (idempotent re-runs) so we don't
	// duplicate them; identified by the `perf-fixture-` title prefix.
	const keep = existing.sessions.filter((s) => !(typeof s?.title === "string" && s.title.startsWith("perf-fixture-")));
	const nextEpoch = (existing.epoch || 0) + 1;
	const payload = { version: 2 as const, epoch: nextEpoch, sessions: [...keep, ...rows] };
	writeFileSync(storeFile, JSON.stringify(payload, null, 2), "utf-8");
	return { ids, bytesByteSum };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
let gw: GW | null = null;

test.afterAll(async () => {
	if (gw) await stopGW(gw);
});

test("perf-sidebar-nav: warm + goal + cold passes", async ({ page }) => {
	test.setTimeout(8 * 60_000);

	// Force a desktop viewport so the sidebar renders (mobile collapses it).
	await page.setViewportSize({ width: 1280, height: 800 });

	mkdirSync(OUT_DIR, { recursive: true });
	const HISTORY_DIR = resolve(PROJECT_ROOT, "docs", "perf", "history");
	mkdirSync(HISTORY_DIR, { recursive: true });
	if (WANT_SCREENSHOTS) mkdirSync(join(OUT_DIR, "screens"), { recursive: true });

	// ── Boot gateway in an isolated dir ────────────────────────────
	const port = await freePort();
	const dir = join(PROJECT_ROOT, "test-results", "perf-sidebar-nav-gw");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	gw = await startGW(dir, port);

	// Register a default project so session creation is allowed.
	{
		const projectName = "perf-bench";
		const reg = await api(gw, "/api/projects", {
			method: "POST",
			body: JSON.stringify({
				name: projectName, rootPath: dir,
				components: [{ name: projectName, repo: ".", commands: { build: "echo ok", check: "echo ok", unit: "echo ok", e2e: "echo ok" } }],
				workflows: buildDefaultWorkflows(projectName),
			}),
		});
		if (reg.ok) {
			const body = await reg.json();
			gw.defaultProjectId = body.id ?? body.projectId ?? body.project?.id;
		}
		// Some builds auto-pick the first project — fetch the list as a fallback.
		if (!gw.defaultProjectId) {
			const r = await api(gw, "/api/projects");
			if (r.ok) {
				const list = await r.json();
				gw.defaultProjectId = Array.isArray(list) ? list[0]?.id : list.projects?.[0]?.id;
			}
		}
	}
	expect(gw.defaultProjectId, "project registration failed — cannot seed sessions").toBeTruthy();

	// ── Phase 2A: pre-seed N=10 sessions with REALISTIC transcripts ─
	// Stop the gateway, seed sessions.json + JSONL files on disk, then
	// restart. See header comment + `seedArchivedFixtures` for the mechanism.
	const { name: fixtureSizeName, msgsPerSession } = resolveFixtureSize();
	const FIXTURE_COUNT = 10;
	const projectStateDir = join(dir, ".bobbit", "state");
	const capturedProjectId = gw.defaultProjectId!;
	console.log(`[harness] fixture size = ${fixtureSizeName} (${msgsPerSession} msgs/session × ${FIXTURE_COUNT} sessions)`);

	await stopGW(gw);
	const seeded = seedArchivedFixtures({
		projectStateDir,
		projectId: capturedProjectId,
		count: FIXTURE_COUNT,
		msgsPerSession,
	});
	console.log(`[harness] wrote ${seeded.ids.length} JSONL fixtures (${(seeded.bytesByteSum / 1024).toFixed(1)} KB total)`);
	gw = await startGW(dir, port);
	gw.defaultProjectId = capturedProjectId;

	const sessionIds = seeded.ids;
	expect(sessionIds.length, "fixture seeding produced fewer than 5 sessions").toBeGreaterThanOrEqual(5);

	// Sanity-check the gateway actually loaded our archived rows.
	try {
		const r = await api(gw, "/api/sessions?include=archived&limit=200");
		if (r.ok) {
			const j: any = await r.json();
			const arr = Array.isArray(j) ? j : (j.sessions || j.archived || j.data || []);
			const fixtureRows = arr.filter((s: any) => typeof s.title === "string" && s.title.startsWith("perf-fixture-"));
			console.log(`[harness] GET /api/sessions?include=archived: ${arr.length} total, ${fixtureRows.length} fixture row(s)`);
		} else {
			console.warn(`[harness] GET /api/sessions?include=archived failed: ${r.status}`);
		}
	} catch (err) {
		console.warn(`[harness] GET /api/sessions?include=archived threw:`, err);
	}

	// ── Browser context: enable perf + console log ──────────────────
	page.on("console", (msg) => {
		if (msg.text().startsWith("[perf]")) {
			// surface to stdout for capture
			// eslint-disable-next-line no-console
			console.log("  ", msg.text());
		}
	});
	const appUrl = `${gw.base}/?token=${gw.token}`;
	await page.addInitScript(() => {
		try { localStorage.setItem("bobbitPerf", "1"); } catch { /* swallow */ }
		try { localStorage.setItem("BOBBIT_PERF_LOG", "1"); } catch { /* swallow */ }
		// Phase 2A: surface archived sessions in the sidebar so we can drive
		// nav from the keyboard / programmatic openForNavItem path the same
		// way we would for live rows.
		try { localStorage.setItem("bobbit-show-archived", "true"); } catch { /* swallow */ }
	});

	const clientEntries: Array<{ name: string; dur: number; detail?: any; pass: string }> = [];

	async function dumpClientEntries(pass: string): Promise<void> {
		const entries = await page.evaluate(() => (window as any).__bobbitPerf?.entries?.() ?? []);
		for (const e of entries) clientEntries.push({ ...e, pass });
		await page.evaluate(() => (window as any).__bobbitPerf?.clear?.());
	}

	async function snap(name: string): Promise<void> {
		if (!WANT_SCREENSHOTS) return;
		await page.screenshot({ path: join(OUT_DIR, "screens", `${name}.png`), fullPage: true });
	}

	// ── Cold pass first (so app.boot mark survives) ────────────────
	if (sessionIds.length > 0) {
		const coldTargets = sessionIds.slice(0, Math.min(3, sessionIds.length));
		for (const sid of coldTargets) {
			await page.goto(`${appUrl}#/session/${sid}`);
			try {
				await page.waitForSelector('[data-perf-ready="session"]', { timeout: 15_000 });
			} catch {
				// Best-effort — still record what's there.
			}
			await snap(`cold-session-${sid.slice(0, 6)}`);
		}
		await dumpClientEntries("cold");
	}

	// ── Phase 2A: pre-seeded archived fixtures persist across the cold
	// pass (archived rows are not auto-swept on disconnect), so the warm
	// pass reuses the same `sessionIds` instead of re-seeding.
	const warmSessionIds: string[] = sessionIds;

	// ── Warm pass: navigate to landing, then nav through sessions ────
	await page.goto(appUrl);
	await page.waitForLoadState("domcontentloaded");
	// Initial landing on a tokenised URL does not fire a hashchange, and the
	// landing-branch boot path in main.ts doesn't call `refreshSessions()` —
	// so without a refresh kick the sidebar renders 0 sessions. Wait for the
	// `__bobbitRefreshSessions` window surface (set by main.ts) and call it.
	try {
		await page.waitForFunction(() => !!(window as any).__bobbitRefreshSessions, undefined, { timeout: 10_000 });
		const diag = await page.evaluate(async () => {
			try {
				const tok = localStorage.getItem("gateway.token") || "";
				const rurl = (localStorage.getItem("gateway.url") || location.origin) + "/api/sessions";
				const r = await fetch(rurl, { headers: { Authorization: `Bearer ${tok}` } });
				const body = await r.text();
				let n = -1;
				try { const j = JSON.parse(body); n = (j.sessions ?? j).length; } catch {}
				await (window as any).__bobbitRefreshSessions();
				const st = (window as any).__bobbitState;
				return {
					ok: true,
					directFetchStatus: r.status,
					directFetchCount: n,
					directBodyHead: body.slice(0, 300),
					stateCount: st?.gatewaySessions?.length ?? -1,
					sessionsGen: st?.sessionsGeneration ?? null,
					err: st?.sessionsError ?? null,
				};
			} catch (err) {
				return { ok: false, err: String(err) };
			}
		});
		console.log("[harness] post-refresh state:", JSON.stringify(diag));
	} catch {
		console.warn("[harness] __bobbitRefreshSessions not available");
	}
	// The ungrouped-header is EXPANDED by default — the persisted state is
	// the *collapsed* set in localStorage (`bobbit-collapsed-ungrouped`).
	// Clear that set so all ungrouped sections are visible, then trigger a
	// re-render. (Clicking the header would TOGGLE — i.e. collapse it.)
	await page.evaluate(() => {
		try { localStorage.setItem("bobbit-collapsed-ungrouped", "[]"); } catch { /* swallow */ }
	});
	try {
		await page.waitForSelector('[data-nav-id^="ungrouped-header:"]', { timeout: 15_000 });
	} catch {
		console.warn("[harness] no ungrouped header in sidebar after 15s");
	}
	// Confirm at least one session row is now visible before we start clicking.
	try {
		await page.waitForSelector('[data-nav-id^="session:"]', { timeout: 15_000 });
	} catch {
		const diag = await page.evaluate(() => {
			const w = window as any;
			const st = w.state || w.__bobbitState;
			const nav = Array.from(document.querySelectorAll("[data-nav-id]")).map((el) => el.getAttribute("data-nav-id")).filter(Boolean);
			return {
				nav,
				hasState: !!st,
				sessionsCount: st?.gatewaySessions?.length ?? null,
				sessionsLoading: st?.sessionsLoading ?? null,
				sessionsError: st?.sessionsError ?? null,
				appView: st?.appView ?? null,
				projectsCount: st?.projects?.length ?? null,
				firstSession: st?.gatewaySessions?.[0] ? { id: st.gatewaySessions[0].id, projectId: st.gatewaySessions[0].projectId, goalId: st.gatewaySessions[0].goalId, status: st.gatewaySessions[0].status, archived: st.gatewaySessions[0].archived } : null,
			};
		});
		console.warn("[harness] sidebar probe:", JSON.stringify(diag));
	}

	// Drive nav programmatically via `window.__bobbitOpenForNavItem` (set up
	// by main.ts). This is the same entry point keyboard navigation uses, and
	// it fires the canonical `nav.click` + `nav.session.ready` spans whether
	// the row is live or archived. The original row-click path bypasses
	// `openForNavItem` for archived rows (see render-helpers.ts:501 — calls
	// connectToSession directly), so a literal click on a fixture row would
	// produce zero `nav.session.ready` samples and trip the canonical-span
	// invariant.
	await page.waitForFunction(() => !!(window as any).__bobbitOpenForNavItem, undefined, { timeout: 10_000 });
	const clickIds = warmSessionIds.length > 0 ? warmSessionIds : sessionIds;
	for (let lap = 0; lap < 2; lap++) {
		for (const sid of clickIds) {
			await page.evaluate((id) => {
				(window as any).__bobbitOpenForNavItem({ kind: "session", id });
			}, sid);
			try {
				await page.waitForSelector(`#app[data-perf-ready="session"]`, { timeout: 10_000 });
			} catch { /* keep going */ }
			await page.waitForTimeout(50);
			// Clear the sentinel so the *next* nav can re-set it (avoids a stale
			// `data-perf-ready` immediately satisfying the wait).
			await page.evaluate(() => {
				const el = document.getElementById("app");
				if (el) el.removeAttribute("data-perf-ready");
			});
		}
	}
	await dumpClientEntries("warm");

	// ── Goal pass: create one goal, click it twice + reload ────────
	let goalId: string | null = null;
	{
		const r = await api(gw, "/api/goals", {
			method: "POST",
			body: JSON.stringify({
				projectId: gw.defaultProjectId,
				title: "Perf bench goal",
				spec: "Just a placeholder goal so we can navigate to its dashboard.",
			}),
		});
		if (r.ok) {
			const j = await r.json();
			goalId = j?.id ?? j?.goal?.id ?? null;
		}
	}
	if (goalId) {
		await page.goto(appUrl);
		await page.waitForTimeout(1500);
		// Kick a refresh so state.goals + state.gatewaySessions populate.
		try {
			await page.waitForFunction(() => !!(window as any).__bobbitRefreshSessions, undefined, { timeout: 10_000 });
			await page.evaluate(async () => { await (window as any).__bobbitRefreshSessions(); });
		} catch { /* swallow */ }
		try {
			await page.waitForFunction((id: string) => {
				const st = (window as any).__bobbitState;
				return st && (st.goals?.some((g: any) => g.id === id) ?? false);
			}, goalId, { timeout: 10_000 });
		} catch {
			console.warn("[harness] goal never appeared in state.goals");
		}
		for (let lap = 0; lap < 2; lap++) {
			// The goal-row click only expands the goal group; navigation to the
			// dashboard happens via the per-goal dashboard button which carries
			// `data-nav-action="goal-dashboard"`. Hover the row first to reveal
			// the sidebar-actions overlay.
			const row = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
			if (await row.count() === 0) {
				console.warn(`[harness] sidebar row for goal ${goalId} not found on lap ${lap}`);
				break;
			}
			await row.hover();
			const dashBtn = page.locator(`[data-nav-action="goal-dashboard"][data-goal-id="${goalId}"]`).first();
			if (await dashBtn.count() === 0) {
				console.warn(`[harness] goal dashboard button not found on lap ${lap}`);
				break;
			}
			await dashBtn.click({ force: true });
			try {
				await page.waitForSelector(`#app[data-perf-ready="goal"]`, { timeout: 10_000 });
			} catch { /* keep going */ }
			await page.waitForTimeout(150);
			await page.evaluate(() => {
				const el = document.getElementById("app");
				if (el) el.removeAttribute("data-perf-ready");
				location.hash = "#/";
			});
			await page.waitForTimeout(150);
		}
		// Dump warm-goal entries BEFORE the cold reload — page.goto clears the
		// per-page ring buffer, and we want the click-driven nav.click /
		// nav.goal.ready samples preserved.
		await dumpClientEntries("goal-warm");
		// One cold reload
		await page.goto(`${appUrl}#/goal/${goalId}`);
		try { await page.waitForSelector(`#app[data-perf-ready="goal"]`, { timeout: 10_000 }); } catch { /* swallow */ }
		await dumpClientEntries("goal-cold");
	} else {
		console.warn("[harness] goal creation failed \u2014 goal pass skipped");
	}

	// ── Emit raw JSON + HTML report ────────────────────────────────
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const jsonPath = join(OUT_DIR, `sidebar-nav-${ts}.json`);
	const htmlPath = join(OUT_DIR, `sidebar-nav-${ts}.html`);
	const timingTail = gw.timingLines.slice();
	writeFileSync(jsonPath, JSON.stringify({
		timestamp: ts,
		seededSessions: sessionIds.length,
		fixtureSize: fixtureSizeName,
		msgsPerSession,
		goalId,
		clientEntries,
		serverTimingLines: timingTail,
	}, null, 2));
	writeFileSync(htmlPath, renderHtmlReport({
		timestamp: ts,
		clientEntries,
		timingLines: timingTail,
	}));
	console.log(`[harness] wrote ${jsonPath}`);
	console.log(`[harness] wrote ${htmlPath}`);

	// ── Cross-commit history: write docs/perf/history/<sha>.json ─────
	try {
		const rows = summarise(clientEntries);
		const spans: Record<string, { p50: number; p95: number; p99: number; n: number; mean: number; max: number }> = {};
		for (const r of rows) spans[r.name] = { p50: r.p50, p95: r.p95, p99: r.p99, n: r.n, mean: r.mean, max: r.max };
		let commit = "unknown", parentCommit = "unknown", branch = "unknown";
		try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT }).toString().trim(); } catch { /* swallow */ }
		try { parentCommit = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: PROJECT_ROOT }).toString().trim(); } catch { /* swallow */ }
		try { branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: PROJECT_ROOT }).toString().trim(); } catch { /* swallow */ }
		const short = commit.slice(0, 12);
		// Suffix the history file with the fixture size so medium / large runs
		// on the same commit don't overwrite each other. The cross-commit
		// report (scripts/perf-report.mjs) groups by SHA and reads the JSON's
		// own `fixtureSize` field, so the file name is purely a uniqueness key.
		const suffix = fixtureSizeName === "medium" ? "" : `-${fixtureSizeName}`;
		const historyPath = join(HISTORY_DIR, `${short}${suffix}.json`);
		writeFileSync(historyPath, JSON.stringify({
			commit, parentCommit, branch,
			timestamp: new Date().toISOString(),
			seededSessions: sessionIds.length,
			fixtureSize: fixtureSizeName,
			msgsPerSession,
			spans,
		}, null, 2));
		console.log(`[harness] wrote ${historyPath}`);
		// Regenerate the cross-commit comparison report.
		try {
			execFileSync(process.execPath, [resolve(PROJECT_ROOT, "scripts", "perf-report.mjs")], {
				cwd: PROJECT_ROOT,
				stdio: "inherit",
			});
		} catch (err) {
			console.warn(`[harness] perf-report.mjs failed:`, err);
		}
	} catch (err) {
		console.warn("[harness] failed to emit history JSON:", err);
	}

	// ── Hard-fail if any canonical span has zero samples ───────────
	const byName = new Map<string, number>();
	for (const e of clientEntries) byName.set(e.name, (byName.get(e.name) ?? 0) + 1);
	const missing = CANONICAL_GATE_SPANS.filter((n) => (byName.get(n) ?? 0) === 0);
	if (missing.length > 0) {
		console.error(`[harness] FAIL — canonical span(s) with zero samples: ${missing.join(", ")}`);
		console.error(`[harness] observed span counts:`);
		for (const n of ALL_SPANS) console.error(`    ${n}: ${byName.get(n) ?? 0}`);
		console.error(`[harness] raw JSON: ${jsonPath}`);
		// Per §2.4 — fail loudly with process.exit so a silently-broken
		// instrumentation can't pass with empty data.
		process.exit(1);
	}

	// Convert to assertion for cleaner Playwright output too.
	expect(missing).toEqual([]);
});
