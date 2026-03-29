/**
 * Global teardown: remove ephemeral state directories created for this test run.
 * Handles both legacy `.e2e-bobbit-*` dirs and per-worker `.e2e-worker-*` dirs.
 */
import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

export default function globalTeardown() {
	// Legacy: single shared dir from config env
	const bobbitDir = process.env.BOBBIT_DIR;
	if (bobbitDir && (bobbitDir.includes(".e2e-bobbit-") || bobbitDir.includes(".e2e-fullstack-"))) {
		try { rmSync(bobbitDir, { recursive: true, force: true }); } catch {}
	}

	// Per-worker dirs created by gateway-harness.ts
	const projectRoot = join(import.meta.dirname, "..", "..");
	try {
		for (const entry of readdirSync(projectRoot)) {
			if (entry.startsWith(".e2e-worker-")) {
				try { rmSync(join(projectRoot, entry), { recursive: true, force: true }); } catch {}
			}
		}
	} catch {}
}
