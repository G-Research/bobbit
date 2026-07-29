import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

/** Environment key inherited by every worker participating in one test run. */
export const RUN_ROOT_ENV = "BOBBIT_V2_RUN_ROOT";

// Credentials must never affect unit discovery. Keep this intentionally broad:
// provider additions should be safe by default rather than requiring every test
// harness to learn a new secret name.
export const CREDENTIAL_ENV_PATTERN = /^(?:CLAUDE_CODE_|(?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|GITHUB|GH|AWS|AZURE|COHERE|MISTRAL|GROQ|TOGETHER|DEEPSEEK|XAI|AIGW)_(?:API_)?(?:KEY|TOKEN|SECRET|ACCESS_TOKEN|CLIENT_SECRET)|BOBBIT_.*(?:KEY|TOKEN|SECRET|CREDENTIAL).*)$/;

function canonicalDirectory(path: string): string {
	mkdirSync(path, { recursive: true });
	try { return realpathSync(path); } catch { return resolve(path); }
}

function ownedChild(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !resolve(rel).startsWith("..");
}

let runRoot: string | undefined;

/** Return the canonical, per-coordinator root. Child workers reuse its env value. */
export function getRunRoot(): string {
	if (runRoot) return runRoot;
	const inherited = process.env[RUN_ROOT_ENV];
	if (inherited) return runRoot = canonicalDirectory(inherited);
	const base = canonicalDirectory(tmpdir());
	runRoot = canonicalDirectory(mkdtempSync(join(base, "bobbit-v2-run-")));
	process.env[RUN_ROOT_ENV] = runRoot;
	return runRoot;
}

/** Allocate a unique directory owned by this run; only such children may be removed. */
export function createRunChild(prefix: string): string {
	const root = getRunRoot();
	return canonicalDirectory(mkdtempSync(join(root, `${prefix}-`)));
}

export function removeOwnedRunChild(path: string): void {
	const root = getRunRoot();
	if (!ownedChild(root, path)) throw new Error(`refusing to remove non-owned test path: ${path}`);
	rmSync(path, { recursive: true, force: true });
}

/** Redirect all user-discovery roots before a server/discovery module is imported. */
export function installRunIsolation(): string {
	const root = getRunRoot();
	const home = canonicalDirectory(join(root, "home"));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.BOBBIT_DIR = canonicalDirectory(join(root, "bobbit"));
	for (const key of Object.keys(process.env)) {
		if (CREDENTIAL_ENV_PATTERN.test(key)) delete process.env[key];
	}
	return root;
}

/** Snapshot/delete credentials for focused tests that deliberately seed them. */
export function isolateCredentialEnv(): () => void {
	const saved = new Map<string, string | undefined>();
	for (const key of Object.keys(process.env)) {
		if (CREDENTIAL_ENV_PATTERN.test(key)) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	}
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

export function isOwnedRunPath(path: string): boolean {
	return existsSync(getRunRoot()) && (resolve(path) === getRunRoot() || ownedChild(getRunRoot(), resolve(path)));
}
