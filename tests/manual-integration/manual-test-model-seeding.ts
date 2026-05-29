import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Seed manual integration gateway defaults when explicitly requested.
 *
 * This lets the long-running manual specs exercise non-default providers (for
 * example OpenAI Codex) without changing their normal provider selection.
 */
export function seedManualTestModelPreferences(dir: string): void {
	const model = process.env.MANUAL_TEST_MODEL?.trim();
	const thinkingLevel = process.env.MANUAL_TEST_THINKING_LEVEL?.trim();
	if (!model && !thinkingLevel) return;

	const stateDir = join(dir, ".bobbit", "state");
	mkdirSync(stateDir, { recursive: true });

	const prefsPath = join(stateDir, "preferences.json");
	let prefs: Record<string, unknown> = {};
	if (existsSync(prefsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(prefsPath, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				prefs = parsed;
			}
		} catch {
			// Replace malformed test preferences with the requested deterministic seed.
		}
	}

	if (model) prefs["default.sessionModel"] = model;
	if (thinkingLevel) prefs["default.sessionThinkingLevel"] = thinkingLevel;

	writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}
