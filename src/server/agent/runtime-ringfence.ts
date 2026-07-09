import fs from "node:fs";

export interface ResolveAgentRuntimeModulesDirOptions {
	workingModulesDir: string;
	snapshotModulesDir?: string;
	exists?: (p: string) => boolean;
}

/**
 * Testable seam for agent-runtime module resolution.
 *
 * Final contract (implemented by the ring-fence fix): prefer snapshotModulesDir
 * when it contains @earendil-works/pi-coding-agent/package.json; otherwise fall
 * back to workingModulesDir. Keeping this pure lets the core-tier reproducing
 * test avoid import.meta.resolve, real node_modules, Docker, or network.
 *
 * Current stub intentionally mirrors today's behavior: resolve only from the
 * mutable working node_modules tree.
 */
export function resolveAgentRuntimeModulesDir(opts: ResolveAgentRuntimeModulesDirOptions): string {
	const { workingModulesDir, snapshotModulesDir, exists = fs.existsSync } = opts;
	void snapshotModulesDir;
	void exists;
	return workingModulesDir;
}
