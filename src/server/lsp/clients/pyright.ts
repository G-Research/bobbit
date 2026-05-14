/**
 * Pyright adapter — stub. v1 detects installation but doesn't implement methods.
 * When pyright is installed and a python project is detected, the factory
 * reports isInstalled=true so the supervisor can mark it ready for future
 * implementation work; today the spawn() throws and ensure() falls back to
 * `lsp_unavailable` for the caller.
 */
import type { LspClient, LspClientFactory, SpawnOpts } from "../client.js";
import type { Language } from "../types.js";
import { resolvePyrightLangserver } from "../server-process.js";

export class PyrightLspFactory implements LspClientFactory {
	readonly language: Language = "python";
	isInstalled(): boolean {
		// Stubbed to return false in v1; pyright detection is wired but the
		// client adapter is not implemented yet. Flip this to
		// `resolvePyrightLangserver() !== null` when the adapter lands.
		void resolvePyrightLangserver;
		return false;
	}
	async spawn(_opts: SpawnOpts): Promise<LspClient> {
		throw new Error("pyright adapter not implemented in v1");
	}
}
