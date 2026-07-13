import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MANUAL_INHERIT_SERVER_CONFIG_ENV = "BOBBIT_MANUAL_INHERIT_SERVER_CONFIG";

const INHERITED_PREF_KEYS = new Set([
	"default.sessionModel",
	"default.sessionThinkingLevel",
	"default.reviewModel",
	"default.reviewThinkingLevel",
	"default.namingModel",
	"default.namingThinkingLevel",
	"default.imageModel",
	"allowSessionModelFallback",
	"aigw.url",
	"aigw.exclusive",
	"customProviders",
]);

const INHERITED_PREF_PREFIXES = ["providerKey."];
const INHERITED_AGENT_FILES = ["auth.json", "settings.json", "models.json", "google-code-assist.json"];

/**
 * Seed manual integration gateway defaults when explicitly requested.
 *
 * Normal mode stays isolated and only honors MANUAL_TEST_MODEL /
 * MANUAL_TEST_THINKING_LEVEL. When BOBBIT_MANUAL_INHERIT_SERVER_CONFIG=1 is
 * set, this copies the small, model-binding subset of preferences and Pi agent
 * auth/config files from the parent Bobbit server's BOBBIT_DIR into the test
 * gateway's fresh .bobbit dir. It deliberately does not point the test gateway
 * at the live BOBBIT_DIR and does not copy sessions, goals, projects, gateway
 * tokens, or TLS state.
 */
export function seedManualTestModelPreferences(dir: string): void {
	const bobbitDir = join(dir, ".bobbit");
	const stateDir = join(bobbitDir, "state");
	mkdirSync(stateDir, { recursive: true });

	const prefsPath = join(stateDir, "preferences.json");
	const prefs = readJsonObject(prefsPath);

	if (isEnabled(process.env[MANUAL_INHERIT_SERVER_CONFIG_ENV])) {
		inheritLiveServerConfig({ targetBobbitDir: bobbitDir, targetPrefs: prefs });
	}

	const model = process.env.MANUAL_TEST_MODEL?.trim();
	const thinkingLevel = process.env.MANUAL_TEST_THINKING_LEVEL?.trim();
	if (model) prefs["default.sessionModel"] = model;
	if (thinkingLevel) prefs["default.sessionThinkingLevel"] = thinkingLevel;

	if (Object.keys(prefs).length > 0) {
		writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
	}
}

function inheritLiveServerConfig({
	targetBobbitDir,
	targetPrefs,
}: {
	targetBobbitDir: string;
	targetPrefs: Record<string, unknown>;
}): void {
	const sourceBobbitDir = process.env.BOBBIT_DIR?.trim();
	if (!sourceBobbitDir) {
		console.warn(`[manual-test-model-seeding] ${MANUAL_INHERIT_SERVER_CONFIG_ENV}=1 but BOBBIT_DIR is unset; no live server config inherited.`);
		return;
	}

	const sourceRoot = resolve(sourceBobbitDir);
	const targetRoot = resolve(targetBobbitDir);
	if (sourceRoot === targetRoot) {
		console.warn(`[manual-test-model-seeding] ${MANUAL_INHERIT_SERVER_CONFIG_ENV}=1 but BOBBIT_DIR already points at the manual test gateway; skipping inheritance.`);
		return;
	}

	const sourcePrefs = readJsonObject(join(sourceRoot, "state", "preferences.json"));
	for (const [key, value] of Object.entries(sourcePrefs)) {
		if (shouldInheritPreference(key)) targetPrefs[key] = value;
	}

	const sourceAgentDir = join(sourceRoot, "agent");
	const targetAgentDir = join(targetRoot, "agent");
	for (const file of INHERITED_AGENT_FILES) {
		copyRegularFileIfPresent(join(sourceAgentDir, file), join(targetAgentDir, file));
	}
}

function shouldInheritPreference(key: string): boolean {
	return INHERITED_PREF_KEYS.has(key) || INHERITED_PREF_PREFIXES.some(prefix => key.startsWith(prefix));
}

function copyRegularFileIfPresent(source: string, target: string): void {
	try {
		if (!existsSync(source) || !statSync(source).isFile()) return;
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
	} catch (err) {
		console.warn(`[manual-test-model-seeding] Failed to inherit ${source}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function readJsonObject(file: string): Record<string, unknown> {
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Replace malformed test preferences with deterministic seed values.
	}
	return {};
}

function isEnabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}
