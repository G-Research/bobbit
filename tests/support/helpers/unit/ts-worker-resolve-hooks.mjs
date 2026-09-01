/**
 * Module-customization resolve hook for worker_threads spawned by tests.
 *
 * Tier-1 imports src directly with NO build. Some subsystems (extension-host
 * ModuleHost) spawn a raw `new Worker(module-host-bootstrap.ts)`. Node 24
 * type-strips the .ts entry, but its static `import ... from "./x.js"` cannot be
 * resolved because only `x.ts` exists on disk (there is no dist). Vitest's main
 * thread resolves .js->.ts via its Vite pipeline, but a raw worker uses Node's
 * plain resolver. This hook restores the .js->.ts fallback ONLY inside such
 * workers (it is registered via NODE_OPTIONS --import, which affects newly
 * spawned workers, never the vitest main process).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
		try {
			return await nextResolve(specifier, context);
		} catch (err) {
			// Fall back to the .ts source when the .js sibling does not exist.
			const tsSpecifier = specifier.slice(0, -3) + ".ts";
			try {
				const resolved = await nextResolve(tsSpecifier, context);
				return resolved;
			} catch {
				throw err;
			}
		}
	}
	return nextResolve(specifier, context);
}
