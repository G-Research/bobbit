import fs from "node:fs";
import path from "node:path";
import { bobbitConfigDir, bobbitStateDir } from "./bobbit-dir.js";

/**
 * Check if project setup has been completed.
 *
 * Setup is considered complete when either:
 *   1. The sentinel file `<bobbitStateDir()>/setup-complete` exists (the user
 *      explicitly dismissed the setup wizard), OR
 *   2. A user-customised `<bobbitConfigDir()>/system-prompt.md` exists. The
 *      file is no longer scaffolded automatically — its very presence is the
 *      signal that the user has opted in to customisation.
 */
export function isSetupComplete(): boolean {
	const sentinelPath = path.join(bobbitStateDir(), "setup-complete");
	if (fs.existsSync(sentinelPath)) return true;
	const userPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
	return fs.existsSync(userPromptPath);
}
