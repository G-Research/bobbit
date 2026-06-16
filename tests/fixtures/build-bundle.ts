/**
 * Build an esbuild IIFE bundle for a file:// fixture, atomically and
 * idempotently across parallel workers.
 *
 * Why this exists:
 * - Multiple `*.spec.ts` files often share a fixture bundle (e.g.
 *   `git-status-widget-states.spec.ts` and `git-status-widget-multi-repo.spec.ts`
 *   both produce `git-status-widget-states-bundle.js`). When workers run in
 *   parallel, two `beforeAll` hooks racing on `--outfile=…` will truncate the
 *   bundle mid-write while the other worker's `page.goto(file://…)` is loading
 *   it, leaving `__ready` unset and the test timing out.
 * - `esbuild --outfile=X` is NOT atomic on Windows: it truncates X and streams
 *   bytes in. A reader sees a partial JS payload and the IIFE never finishes
 *   evaluating.
 *
 * Fix: serialise rebuild via a directory-based mutex (`mkdirSync` is atomic
 * on every OS we care about). Only one worker rebuilds; the others poll until
 * the lock is released, then re-check the mtime and skip. Combined with a
 * mtime-staleness gate, the steady-state cost is one `statSync` per worker.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface BuildBundleOptions {
	entry: string;
	outfile: string;
	/** Source file(s) whose mtime invalidates the bundle. Defaults to [entry]. */
	deps?: string[];
	/** esbuild flags appended after the entry. Default IIFE/ES2022/web tsconfig. */
	extraFlags?: string[];
	/** Preserve esbuild's CSS sidecar when a fixture explicitly links it. */
	keepCss?: boolean;
}

const DEFAULT_FLAGS = [
	"--bundle",
	"--format=iife",
	"--target=es2022",
	"--tsconfig=tsconfig.web.json",
	"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
	"--define:import.meta.url='\"http://localhost/\"'",
];

const LOCK_TIMEOUT_MS = 60_000;
const LOCK_STALE_MS = 90_000;
const POLL_INTERVAL_MS = 100;

function isFresh(outfile: string, depMtime: number): boolean {
	try {
		return fs.statSync(outfile).mtimeMs >= depMtime;
	} catch {
		return false;
	}
}

function sleep(ms: number): void {
	// Sync sleep — `beforeAll` is sync, no event loop access. `Atomics.wait`
	// on a fresh SharedArrayBuffer parks the thread cleanly without
	// busy-spinning the CPU.
	const sab = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(sab, 0, 0, ms);
}

function cssSidecarFor(outfile: string): string {
	return outfile.replace(/\.js$/i, ".css");
}

function cleanupCssSidecar(outfile: string, existedBeforeBuild: boolean): void {
	if (existedBeforeBuild) return;
	try { fs.rmSync(cssSidecarFor(outfile), { force: true }); } catch { /* ignore */ }
}

export function buildBundle(opts: BuildBundleOptions): void {
	const { entry, outfile } = opts;
	const deps = opts.deps ?? [entry];
	const depMtime = deps.reduce((m, p) => Math.max(m, fs.statSync(p).mtimeMs), 0);
	const cssSidecarExisted = fs.existsSync(cssSidecarFor(outfile));

	if (isFresh(outfile, depMtime)) {
		if (!opts.keepCss) cleanupCssSidecar(outfile, cssSidecarExisted);
		return;
	}

	fs.mkdirSync(path.dirname(outfile), { recursive: true });

	const lockDir = `${outfile}.lock`;
	const start = Date.now();

	while (true) {
		try {
			fs.mkdirSync(lockDir);
			break; // acquired the lock
		} catch (err: any) {
			if (err.code !== "EEXIST") throw err;
			// Another worker holds the lock. If it's stale (process crashed),
			// force-release.
			try {
				const age = Date.now() - fs.statSync(lockDir).mtimeMs;
				if (age > LOCK_STALE_MS) {
					try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
					continue;
				}
			} catch { /* ignore */ }

			if (Date.now() - start > LOCK_TIMEOUT_MS) {
				throw new Error(`buildBundle: timed out waiting for ${lockDir}`);
			}
			sleep(POLL_INTERVAL_MS);

			// Another worker may have finished the rebuild while we slept.
			if (isFresh(outfile, depMtime)) {
				if (!opts.keepCss) cleanupCssSidecar(outfile, cssSidecarExisted);
				return;
			}
		}
	}

	try {
		// Re-check after acquiring the lock — earlier worker may have built it.
		if (isFresh(outfile, depMtime)) {
			if (!opts.keepCss) cleanupCssSidecar(outfile, cssSidecarExisted);
			return;
		}
		const flags = opts.extraFlags ?? DEFAULT_FLAGS;
		execSync(`npx esbuild ${entry} ${flags.join(" ")} --outfile=${outfile}`, { stdio: "pipe" });
		// Most file:// fixtures don't link esbuild's CSS sidecar; leaving it behind
		// creates untracked repo artifacts when a bundled component imports CSS.
		if (!opts.keepCss) cleanupCssSidecar(outfile, cssSidecarExisted);
	} finally {
		try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
	}
}

