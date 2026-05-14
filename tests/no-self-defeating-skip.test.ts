/**
 * Pinning test: no self-defeating skip patterns in the e2e suite.
 *
 * A self-defeating skip is one where the skip predicate overlaps with the
 * regression the test is supposed to catch — e.g. "skip if the API returns
 * non-2xx" in a test whose whole job is to assert that the API returns 2xx.
 *
 * The canonical bad pattern:
 *   const res = await apiFetch("/api/some/route");
 *   if (!res.ok) testInfo.skip();   // ← masks the regression silently
 *
 * Legitimate guards MUST be annotated with `// SKIP_OK: <reason>` on the
 * same or immediately preceding line so this test recognises them.
 *
 * The ONLY approved way to skip based on an HTTP response is to use an
 * explicit env-variable opt-out (e.g. SKIP_LSP_E2E=1) set by CI config,
 * not an automatic skip triggered by a failing precondition.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const E2E_ROOT = join(__dirname, "e2e");

// Patterns that indicate a self-defeating skip.
// We look for `testInfo.skip()` / `test.skip()` guarded by an HTTP-response
// predicate (`!*.ok`, `!*.status`, `.ok)`-check, etc.)
//
// The heuristic: on the same line as `testInfo.skip()` or `test.skip()`,
// OR on the line immediately before it, there is a reference to a response
// property like `.ok` or `.status` that could be masking a real regression.
const SELF_DEFEATING_PATTERNS = [
	// if (!<anything>.ok) testInfo.skip()  (single-line form)
	/if\s*\(\s*!\s*\w+\.ok\s*\)\s*testInfo\.skip\(\)/,
	// if (!<anything>.ok) test.skip()
	/if\s*\(\s*!\s*\w+\.ok\s*\)\s*test\.skip\(\)/,
	// } catch { test.skip(); }  / } catch { testInfo.skip(); }
	// (catches swallowed by skip without a SKIP_OK annotation)
	/}\s*catch\s*(?:\([^)]*\))?\s*\{\s*(?:test|testInfo)\.skip\(\)/,
];

function collectSpecFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectSpecFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
			results.push(full);
		}
	}
	return results;
}

const files = collectSpecFiles(E2E_ROOT);

for (const file of files) {
	const rel = relative(__dirname, file);
	const lines = readFileSync(file, "utf-8").split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const prevLine = i > 0 ? lines[i - 1] : "";

		// If the line or previous line has a SKIP_OK annotation, it's blessed.
		const hasAnnotation = (s: string) => s.includes("// SKIP_OK:") || s.includes("/* SKIP_OK:");
		if (hasAnnotation(line) || hasAnnotation(prevLine)) {
			continue;
		}

		for (const pattern of SELF_DEFEATING_PATTERNS) {
			if (pattern.test(line)) {
				assert.fail(
					`Self-defeating skip detected in ${rel}:${i + 1}\n` +
					`  > ${line.trim()}\n` +
					`\n` +
					`  A skip predicate that overlaps with the regression being tested\n` +
					`  turns the test into a silent no-op when its subject is broken.\n` +
					`\n` +
					`  Fix options:\n` +
					`    1. Replace with a hard assertion: expect(res.status).toBe(200)\n` +
					`    2. Use an explicit env-flag: if (process.env.SKIP_FOO_E2E) testInfo.skip()\n` +
					`    3. If the skip is genuinely safe, annotate it:\n` +
					`       // SKIP_OK: <reason why this can't mask a real regression>\n` +
					`       if (!res.ok) testInfo.skip()`,
				);
			}
		}
	}
}

// If we get here, no self-defeating skips were found.
console.log(`✓ no-self-defeating-skip: scanned ${files.length} e2e spec files — all clean`);
