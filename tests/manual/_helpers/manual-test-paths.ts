import { realpathSync } from "node:fs";

/**
 * Canonical OS temp root for manual-integration fixtures.
 *
 * On macOS `/tmp` is a symlink to `/private/tmp`. Project registration
 * (`POST /api/projects`) rejects symlinked roots with the `symlink_root`
 * guard unless the canonical path is supplied, so fixtures that build a
 * project `rootPath` under the temp dir must register the real path.
 *
 * We canonicalize the base temp directory (which always exists) here so any
 * fixture path built on top of it — via `join(manualTmpRoot(), "...")` — is
 * already symlink-free and passes registration on every platform. Falls back
 * to the raw base if it cannot be resolved (e.g. a not-yet-created Windows
 * `C:\Temp`).
 */
export function manualTmpRoot(): string {
	const base = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
	try {
		return realpathSync(base);
	} catch {
		return base;
	}
}
