/**
 * Tier 2.5 Playwright reporter — encodes per-test WebM videos + thumbnail
 * strips from the `beats.jsonl` files dropped into each test's output
 * directory by `BeatRecorder.flush()`, then emits a single self-contained
 * HTML report at `tests/results/tier-2-5/report.html`.
 *
 * Registered only when `process.env.RECORDSCREEN === "1"` (see the gated entry in
 * `playwright-e2e.config.ts`). When unregistered, this file is never loaded
 * — zero overhead.
 *
 * Algorithm (onEnd):
 *
 *   1. Walk Playwright's results root for `beats.jsonl` artifacts. Each one
 *      lives next to its test's beats/ PNG dir.
 *   2. For each test that captured ≥1 beat:
 *      - ffmpeg-encode beats/*.png → videos/<test-id>.webm at a synthetic
 *        framerate that yields BEAT_HOLD_MS-per-frame (1500ms). Re-encode
 *        at 30fps so the player can scrub smoothly within a held frame.
 *      - Generate per-beat 240px-wide thumbnails into thumbs/<test-id>/.
 *   3. Write report.html with one section per test: <video controls>,
 *      clickable thumbnail strip, click-to-seek + active-thumb highlight.
 *      All references use **relative paths** — no base64 inlining.
 *
 * Ported from `tests/prototype/scenario-runner.spec.ts::test.afterAll` +
 * `buildReport` + `scenarioHtml`.
 */
import type {
	FullConfig,
	FullResult,
	Reporter,
	Suite,
	TestCase,
	TestResult,
} from "@playwright/test/reporter";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Resolve an ffmpeg binary at runtime.
 *
 * Resolution order:
 *   1. `process.env.FFMPEG_PATH` if set & non-empty AND it accepts `-version`.
 *   2. System `ffmpeg` on `PATH` if it accepts `-version`.
 *   3. `null` — caller must skip encoding and emit a warning.
 *
 * Each candidate is probed with a 5s-timeout `spawnSync(cmd, ["-version"])`.
 * Exported for unit testing.
 */
export function resolveFfmpeg(): string | null {
	const envPath = process.env.FFMPEG_PATH;
	if (envPath && envPath.trim().length > 0) {
		try {
			const r = spawnSync(envPath, ["-version"], {
				timeout: 5000,
				stdio: "ignore",
			});
			if (r.status === 0) return envPath;
		} catch {
			/* fall through */
		}
	}
	try {
		const r = spawnSync("ffmpeg", ["-version"], {
			timeout: 5000,
			stdio: "ignore",
			shell: process.platform === "win32",
		});
		if (r.status === 0) return "ffmpeg";
	} catch {
		/* fall through */
	}
	return null;
}

/** Each beat is held this long in the encoded video. */
const BEAT_HOLD_MS = 1500;

/** Output root for all Tier 2.5 artifacts (videos, thumbs, report.html). */
const OUTPUT_ROOT = resolve(process.cwd(), "tests", "results", "tier-2-5");

interface BeatRecord {
	idx: number;
	label: string;
	ts: number;
	png: string;
	ms: number;
}

interface CapturedTest {
	/** Stable, filesystem-safe id used for video / thumbs filenames. */
	id: string;
	/** Human-readable title, e.g. "browser › suite › test name". */
	title: string;
	beats: BeatRecord[];
	beatsDir: string;
	videoFile?: string;
	videoBytes?: number;
}

function slugify(s: string): string {
	return s
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "test";
}

/**
 * Walk a directory tree looking for `beats.jsonl` files. Returns the list
 * of containing directories (the test's outputDir).
 */
function findBeatDirs(root: string): string[] {
	const out: string[] = [];
	if (!existsSync(root)) return out;
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				stack.push(full);
			} else if (name === "beats.jsonl") {
				out.push(dir);
			}
		}
	}
	return out;
}

function readBeats(jsonlPath: string): BeatRecord[] {
	const body = readFileSync(jsonlPath, "utf-8");
	const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
	const out: BeatRecord[] = [];
	for (const line of lines) {
		try {
			out.push(JSON.parse(line) as BeatRecord);
		} catch {
			// Skip malformed line — don't fail the report build for one bad row.
		}
	}
	return out;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderReport(tests: CapturedTest[], ffmpegMissing: boolean): string {
	const totalBeats = tests.reduce((a, t) => a + t.beats.length, 0);
	const totalBytes = tests.reduce((a, t) => a + (t.videoBytes ?? 0), 0);
	const banner = ffmpegMissing
		? `<div style="background:color-mix(in oklch, var(--warning) 18%, transparent);border:1px solid color-mix(in oklch, var(--warning) 45%, transparent);border-radius:6px;padding:12px 16px;margin-bottom:18px;color:var(--foreground)">
    <strong>ffmpeg not found.</strong> Videos and per-beat thumbnails were skipped.
    Install ffmpeg (<code>apt install ffmpeg</code> / <code>brew install ffmpeg</code> / <code>choco install ffmpeg</code>)
    or set <code>FFMPEG_PATH</code> to the binary path, then re-run with <code>RECORDSCREEN=1</code>.
  </div>`
		: "";
	return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Tier 2.5 — beat report</title>
<style>
  /* Theme tokens are injected by Bobbit's preview bridge. Defensive fallbacks
     for standalone open (file://) — kept light/neutral and overridden by
     :root values from the bridge. See defaults/docs/html-rendering.md. */
  :root {
    --background: #f6f7fa;
    --foreground: #1a1a1a;
    --card: #ffffff;
    --muted-foreground: #666;
    --border: #dcdde2;
    --primary: #2256d1;
    --warning: #b58105;
  }
  body { font: 14px/1.45 system-ui, -apple-system, sans-serif; max-width: 1180px; margin: 24px auto; padding: 0 16px; color: var(--foreground); background: var(--background); }
  h1 { margin-top: 0; }
  .summary, .scenario { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; margin-bottom: 22px; }
  .summary table { border-collapse: collapse; width: 100%; }
  .summary td { padding: 6px 12px; border-bottom: 1px solid var(--border); }
  .summary td:first-child { color: var(--muted-foreground); }
  .summary tr:last-child td { border-bottom: 0; }
  .scenario h2 { margin: 0 0 4px; font-size: 18px; }
  .scenario .meta { color: var(--muted-foreground); font-size: 12px; margin-bottom: 12px; font-variant-numeric: tabular-nums; }
  video { display: block; width: 100%; max-width: 100%; height: auto; background: #000; border-radius: 4px; border: 1px solid var(--border); }
  .num { font-variant-numeric: tabular-nums; }
  .missing { color: var(--negative, #b00); font-weight: 600; }
  .toc { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .toc a { padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); color: var(--primary); text-decoration: none; font-size: 12px; }
  .toc a:hover { border-color: var(--primary); }
  kbd { background: color-mix(in oklch, var(--foreground) 10%, transparent); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 3px; padding: 1px 5px; font-family: ui-monospace, monospace; font-size: 0.85em; }
  .player-tip { color: var(--muted-foreground); font-size: 12px; margin-top: 6px; }
  .beats { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 14px; }
  .beat { border: 1px solid var(--border); border-radius: 6px; background: color-mix(in oklch, var(--card) 70%, var(--background)); cursor: pointer; padding: 6px; transition: border-color 100ms, transform 100ms; }
  .beat:hover { border-color: var(--primary); transform: translateY(-1px); }
  .beat.active { border-color: var(--primary); box-shadow: 0 0 0 2px color-mix(in oklch, var(--primary) 35%, transparent); }
  .beat img { display: block; width: 100%; height: auto; border-radius: 3px; }
  .beat .lbl { font-size: 12px; color: var(--foreground); margin-top: 6px; line-height: 1.3; }
  .beat .nt { font-variant-numeric: tabular-nums; color: var(--muted-foreground); margin-right: 4px; }
</style>
</head>
<body>
<h1>Tier 2.5 — beat report</h1>
${banner}
<p style="color:var(--muted-foreground);max-width:780px">
  Each test below captures a labeled <em>beat</em> at every meaningful UX moment.
  The video holds each beat for ${BEAT_HOLD_MS} ms so you can read the labels
  and observe each state. Click any thumbnail to seek the video to that beat.
  Use <kbd>Space</kbd> to play/pause, <kbd>&lt;</kbd> / <kbd>&gt;</kbd> for
  frame-step, or the speed menu in the player.
</p>

<div class="toc">
${tests.map((t) => `  <a href="#${t.id}">${escapeHtml(t.title)} (${t.beats.length})</a>`).join("\n")}
</div>

<div class="summary">
  <table>
    <tr><td>Tests with captured beats</td><td class="num"><strong>${tests.length}</strong></td></tr>
    <tr><td>Total beats captured</td><td class="num"><strong>${totalBeats}</strong></td></tr>
    <tr><td>Total video size</td><td class="num"><strong>${(totalBytes / 1024).toFixed(1)} KB</strong></td></tr>
    <tr><td>Beat hold time</td><td class="num">${BEAT_HOLD_MS} ms</td></tr>
  </table>
</div>

${tests.map(renderTest).join("\n")}

<script>
  // Click a beat thumbnail → seek the matching <video> to that beat's
  // start time (idx * BEAT_HOLD_MS / 1000). Mark the active thumbnail.
  document.querySelectorAll('.scenario').forEach((scEl) => {
    const video = scEl.querySelector('video');
    const beats = scEl.querySelectorAll('.beat');
    if (!video) return;
    beats.forEach((b) => {
      b.addEventListener('click', () => {
        const idx = parseInt(b.getAttribute('data-idx') || '0', 10);
        video.currentTime = idx * (${BEAT_HOLD_MS} / 1000);
        video.play().catch(() => {});
        beats.forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      });
    });
    video.addEventListener('timeupdate', () => {
      const idx = Math.min(beats.length - 1, Math.floor(video.currentTime / (${BEAT_HOLD_MS} / 1000)));
      beats.forEach((x, i) => x.classList.toggle('active', i === idx));
    });
  });
</script>
</body></html>`;
}

function renderTest(t: CapturedTest): string {
	const sizeKb = t.videoBytes ? `${(t.videoBytes / 1024).toFixed(1)} KB` : "—";
	const videoBlock = t.videoFile && existsSync(t.videoFile)
		? `<video src="videos/${t.id}.webm" controls preload="metadata"></video>`
		: `<div class="missing">video missing</div>`;
	const beatsHtml = t.beats.map((b) => {
		const stem = String(b.idx).padStart(4, "0");
		const thumbRel = `thumbs/${t.id}/${stem}.jpg`;
		return `    <div class="beat" data-idx="${b.idx}">
      <img src="${thumbRel}" alt="${escapeHtml(b.label)}"/>
      <div class="lbl"><span class="nt">${b.idx + 1}.</span>${escapeHtml(b.label)}</div>
    </div>`;
	}).join("\n");
	return `<div class="scenario" id="${t.id}">
  <h2>${escapeHtml(t.title)}</h2>
  <div class="meta">${t.beats.length} beats · ${sizeKb}</div>
  ${videoBlock}
  <div class="beats">
${beatsHtml}
  </div>
</div>`;
}

class Tier25Reporter implements Reporter {
	onBegin(_config: FullConfig, _suite: Suite): void {
		// no-op
	}

	onTestEnd(_test: TestCase, _result: TestResult): void {
		// no-op — we discover beats.jsonl files by FS-scanning in onEnd, which
		// matches the prototype's pattern and avoids depending on private
		// Playwright internals (TestCase has no public outputDir accessor).
	}

	async onEnd(_result: FullResult): Promise<void> {
		// Playwright's default output root is `test-results/`; the project may
		// override it. We scan a few common roots that may contain beats.jsonl.
		const candidateRoots = [
			resolve(process.cwd(), "test-results"),
			resolve(process.cwd(), "tests", "results"),
			resolve(process.cwd(), "playwright-report"),
		];
		const seen = new Set<string>();
		const beatDirs: string[] = [];
		for (const root of candidateRoots) {
			for (const dir of findBeatDirs(root)) {
				if (!seen.has(dir)) {
					seen.add(dir);
					beatDirs.push(dir);
				}
			}
		}

		if (beatDirs.length === 0) {
			// eslint-disable-next-line no-console
			console.log("[tier-2-5] no beats.jsonl files found — skipping report");
			return;
		}

		// Build CapturedTest list.
		const tests: CapturedTest[] = [];
		for (const dir of beatDirs) {
			const jsonl = join(dir, "beats.jsonl");
			let beats: BeatRecord[];
			try {
				beats = readBeats(jsonl);
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn(`[tier-2-5] failed to read ${jsonl}: ${(err as Error).message}`);
				continue;
			}
			if (beats.length === 0) continue;
			// Derive title + id from the outputDir's last path segment, which
			// Playwright builds as `<project>-<file>-<title>-<retry>` (suitably
			// fs-safe). Fall back to the parent dir name if missing.
			const parts = dir.split(sep);
			const title = parts[parts.length - 1] || "test";
			const id = slugify(title);
			tests.push({
				id,
				title,
				beats,
				beatsDir: join(dir, "beats"),
			});
		}

		if (tests.length === 0) {
			// eslint-disable-next-line no-console
			console.log("[tier-2-5] beats.jsonl files contained no beats — skipping report");
			return;
		}

		// Disambiguate ids if collisions occur.
		const idCount = new Map<string, number>();
		for (const t of tests) {
			const n = (idCount.get(t.id) ?? 0) + 1;
			idCount.set(t.id, n);
			if (n > 1) t.id = `${t.id}-${n}`;
		}

		mkdirSync(OUTPUT_ROOT, { recursive: true });
		mkdirSync(join(OUTPUT_ROOT, "videos"), { recursive: true });
		mkdirSync(join(OUTPUT_ROOT, "thumbs"), { recursive: true });

		const ffmpeg = resolveFfmpeg();
		if (ffmpeg === null) {
			// eslint-disable-next-line no-console
			console.warn(
				"[tier-2-5] ffmpeg not found; videos and thumbnails skipped. " +
					"Install ffmpeg (apt/brew/choco) or set FFMPEG_PATH=/abs/path/to/ffmpeg.",
			);
		} else {
			for (const t of tests) {
				await encodeVideo(t, ffmpeg);
				await encodeThumbnails(t, ffmpeg);
			}
		}

		const reportPath = join(OUTPUT_ROOT, "report.html");
		writeFileSync(reportPath, renderReport(tests, ffmpeg === null), "utf-8");

		// eslint-disable-next-line no-console
		console.log(`\n[tier-2-5] report: file:///${reportPath.replace(/\\/g, "/")}`);
		// eslint-disable-next-line no-console
		console.log(`[tier-2-5] tests with beats: ${tests.length}, total beats: ${tests.reduce((a, t) => a + t.beats.length, 0)}`);
	}
}

async function encodeVideo(t: CapturedTest, ffmpeg: string): Promise<void> {
	if (t.beats.length === 0) return;
	if (!existsSync(t.beatsDir)) return;
	const out = join(OUTPUT_ROOT, "videos", `${t.id}.webm`);
	mkdirSync(dirname(out), { recursive: true });

	const beatFps = 1000 / BEAT_HOLD_MS;
	const r = spawnSync(
		ffmpeg,
		[
			"-y",
			"-framerate", String(beatFps),
			"-i", join(t.beatsDir, "%04d.png"),
			"-vf", "scale=1000:-2:flags=lanczos",
			"-r", "30",
			"-c:v", "libvpx-vp9",
			"-crf", "32",
			"-b:v", "0",
			"-pix_fmt", "yuv420p",
			"-deadline", "good",
			"-cpu-used", "4",
			out,
		],
		{ encoding: "utf-8" },
	);
	if (r.status !== 0) {
		// eslint-disable-next-line no-console
		console.error(`[tier-2-5] webm encode failed for ${t.id}:\n${r.stderr ?? ""}`);
		return;
	}
	t.videoFile = out;
	try { t.videoBytes = statSync(out).size; } catch { /* ignore */ }
}

async function encodeThumbnails(t: CapturedTest, ffmpeg: string): Promise<void> {
	const thumbDir = join(OUTPUT_ROOT, "thumbs", t.id);
	mkdirSync(thumbDir, { recursive: true });
	for (const b of t.beats) {
		const stem = String(b.idx).padStart(4, "0");
		const out = join(thumbDir, `${stem}.jpg`);
		const r = spawnSync(
			ffmpeg,
			[
				"-y",
				"-i", b.png,
				"-vf", "scale=240:-2:flags=lanczos",
				"-q:v", "4",
				out,
			],
			{ encoding: "utf-8" },
		);
		if (r.status !== 0) {
			// eslint-disable-next-line no-console
			console.warn(`[tier-2-5] thumb encode failed for ${t.id}/${stem}: ${r.stderr ?? ""}`);
		}
	}
}

export default Tier25Reporter;
