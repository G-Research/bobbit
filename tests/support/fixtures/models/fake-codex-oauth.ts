import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Installs a credential-shaped, explicitly fake Codex OAuth row in an isolated
 * test agent directory. The prior auth.json bytes are restored verbatim.
 */
export function installFakeCodexOAuth(agentDir: string): () => void {
	mkdirSync(agentDir, { recursive: true });
	const authPath = join(agentDir, "auth.json");
	const existed = existsSync(authPath);
	const previous = existed ? readFileSync(authPath) : undefined;
	let auth: Record<string, unknown> = {};
	if (previous) {
		try { auth = JSON.parse(previous.toString("utf8")); } catch { auth = {}; }
	}
	auth["openai-codex"] = {
		type: "oauth",
		access: "test-only-codex-access",
		refresh: "test-only-codex-refresh",
		expires: Date.now() + 60 * 60 * 1000,
	};
	writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf8");

	return () => {
		if (existed && previous) writeFileSync(authPath, previous);
		else rmSync(authPath, { force: true });
	};
}
