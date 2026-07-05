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
 *
 * W2.Q (staleness across transitive deps): freshness used to be gated only on
 * the caller-supplied `deps` list (defaulting to `[entry]`). Every call site
 * hand-curates that list, and it's easy to miss a file that the entry imports
 * *indirectly* (e.g. `agent-interface-dialog-escape-entry.ts` -> AgentInterface.ts
 * -> MessageEditor.ts) — a change to that transitive file then leaves the
 * cached bundle looking "fresh" and the spec silently exercises stale code.
 * Fixed by asking esbuild for a `--metafile` on every build, which lists every
 * file actually pulled into the bundle, and using *that* full input set (not
 * the hand-written `deps`) as the freshness gate from then on. `deps` is now
 * only a bootstrap fallback for the very first build, before a metafile exists.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface BuildBundleOptions {
	entry: string;
	outfile: string;
	/**
	 * Bootstrap source file(s) used only before a metafile exists (i.e. the
	 * very first build of `outfile`). Defaults to `[entry]`. Every subsequent
	 * freshness check uses esbuild's own metafile — the full transitive input
	 * set — instead, so this no longer needs to be exhaustive.
	 */
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

function metafilePathFor(outfile: string): string {
	return `${outfile}.meta.json`;
}

/**
 * Resolve the full set of files that fed the last successful build of
 * `outfile`, using esbuild's own `--metafile` output (every input actually
 * pulled into the bundle, transitively). Falls back to the caller-supplied
 * `fallbackDeps` when no metafile exists yet — the very first build, or a
 * bundle left over from before this script wrote metafiles.
 */
function resolveTrackedInputs(outfile: string, fallbackDeps: string[]): string[] {
	try {
		const meta = JSON.parse(fs.readFileSync(metafilePathFor(outfile), "utf-8"));
		const inputs = Object.keys(meta.inputs ?? {});
		if (inputs.length > 0) return inputs.map((p) => path.resolve(p));
	} catch { /* no metafile yet — use fallback */ }
	return fallbackDeps;
}

function isFresh(outfile: string, trackedInputs: string[]): boolean {
	let outMtime: number;
	try {
		outMtime = fs.statSync(outfile).mtimeMs;
	} catch {
		return false;
	}
	for (const input of trackedInputs) {
		let inputMtime: number;
		try {
			inputMtime = fs.statSync(input).mtimeMs;
		} catch {
			return false; // a tracked input vanished/moved — force rebuild
		}
		if (inputMtime > outMtime) return false;
	}
	return true;
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
	const fallbackDeps = opts.deps ?? [entry];
	const cssSidecarExisted = fs.existsSync(cssSidecarFor(outfile));

	if (isFresh(outfile, resolveTrackedInputs(outfile, fallbackDeps))) {
		if (!opts.keepCss) cleanupCssSidecar(outfile, cssSidecarExisted);
		return;
	}

	const outDir = path.dirname(outfile);
	fs.mkdirSync(outDir, { recursive: true });

	const lockDir = `${outfile}.lock`;
	const start = Date.now();

	while (true) {
		try {
			fs.mkdirSync(lockDir);
			break; // acquired the lock
		} catch (err: any) {
			if (err.code === "ENOENT") {
				// Playwright may delete test-results between our parent mkdir and
				// lock acquisition. Recreate the parent and retry the same atomic
				// mkdir lock; do not fall back to a non-atomic check-then-create.
				fs.mkdirSync(outDir, { recursive: true });
				continue;
			}
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

			// Another worker may have finished the rebuild while we slept. Re-resolve
			// tracked inputs — the metafile it wrote may cover a different input set.
			if (isFresh(outfile, resolveTrackedInputs(outfile, fallbackDeps))) {
				if (!opts.keepCss) cleanupCssSidecar(outfile, cssSidecarExisted);
				return;
			}
		}
	}

	try {
		// Re-check after acquiring the lock — earlier worker may have built it.
		if (isFresh(outfile, resolveTrackedInputs(outfile, fallbackDeps))) {
			if (!opts.keepCss) cleanupCssSidecar(outfile, cssSidecarExisted);
			return;
		}
		const metaPath = metafilePathFor(outfile);
		const flags = [...(opts.extraFlags ?? DEFAULT_FLAGS), `--metafile=${metaPath}`];
		execSync(`npx esbuild ${entry} ${flags.join(" ")} --outfile=${outfile}`, { stdio: "pipe" });
		// Most file:// fixtures don't link esbuild's CSS sidecar; leaving it behind
		// creates untracked repo artifacts when a bundled component imports CSS.
		if (!opts.keepCss) cleanupCssSidecar(outfile, cssSidecarExisted);
	} finally {
		try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
	}
}

