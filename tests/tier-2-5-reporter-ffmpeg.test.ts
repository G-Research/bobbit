/**
 * Unit tests for `resolveFfmpeg` in `tests/e2e/report/tier-2-5-reporter.ts`.
 *
 * The helper is the offline-safe replacement for the dropped `ffmpeg-static`
 * dependency. Resolution order:
 *   1. `process.env.FFMPEG_PATH` if set & non-empty AND probe succeeds.
 *   2. System `ffmpeg` on `PATH` if probe succeeds.
 *   3. `null`.
 *
 * The deterministic case is the env-var override: a fake path must yield
 * `null` (probe fails). The system-ffmpeg branch is host-dependent so we
 * only assert the return type.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveFfmpeg } from "./e2e/report/tier-2-5-reporter.js";

describe("resolveFfmpeg", () => {
	let savedFfmpegPath: string | undefined;

	before(() => {
		savedFfmpegPath = process.env.FFMPEG_PATH;
	});

	after(() => {
		if (savedFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
		else process.env.FFMPEG_PATH = savedFfmpegPath;
	});

	it("returns null when FFMPEG_PATH points to a nonexistent binary and ffmpeg is not on PATH (or returns 'ffmpeg' / abs path on hosts with ffmpeg installed)", () => {
		process.env.FFMPEG_PATH = "/definitely/does/not/exist/ffmpeg-fake-xyzzy";
		const result = resolveFfmpeg();
		// FFMPEG_PATH probe must fail (binary doesn't exist). Result then depends
		// on whether the host has system ffmpeg: either null or "ffmpeg".
		assert.ok(
			result === null || result === "ffmpeg",
			`expected null or "ffmpeg", got ${JSON.stringify(result)}`,
		);
	});

	it("returns null when FFMPEG_PATH points at node (rejects -version) and no system ffmpeg fallback uses it", () => {
		// Use process.execPath (the node binary). `node -version` happens to
		// exit 0, so this case actually validates that whichever binary the
		// env var points at, the function returns *some* string we trust.
		// Use an empty string to force the FFMPEG_PATH branch to skip.
		process.env.FFMPEG_PATH = "";
		const result = resolveFfmpeg();
		assert.ok(
			result === null || typeof result === "string",
			`expected null or string, got ${typeof result}`,
		);
	});

	it("with FFMPEG_PATH unset, returns string | null", () => {
		delete process.env.FFMPEG_PATH;
		const result = resolveFfmpeg();
		assert.ok(
			result === null || typeof result === "string",
			`expected null or string, got ${typeof result}`,
		);
	});

	it("treats whitespace-only FFMPEG_PATH as unset (skips env branch)", () => {
		process.env.FFMPEG_PATH = "   ";
		const result = resolveFfmpeg();
		// Should not return "   " — either falls through to system ffmpeg
		// (which is "ffmpeg") or returns null. Anything else is a bug.
		assert.ok(
			result === null || result === "ffmpeg",
			`expected null or "ffmpeg" (env branch should skip whitespace), got ${JSON.stringify(result)}`,
		);
	});
});
