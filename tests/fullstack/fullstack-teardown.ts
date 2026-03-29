/**
 * Global teardown: remove the ephemeral state directory for this fullstack test run.
 */
import { rmSync } from "node:fs";

export default function globalTeardown() {
	const bobbitDir = process.env.BOBBIT_DIR;
	if (bobbitDir && bobbitDir.includes(".e2e-fullstack-")) {
		try {
			rmSync(bobbitDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	}
}
