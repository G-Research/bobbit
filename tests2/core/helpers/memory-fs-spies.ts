import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { vi } from "vitest";
import { createMemFs, type MemFs } from "../../harness/mem-fs.js";

const SYNC_METHODS = [
	"existsSync",
	"mkdirSync",
	"readFileSync",
	"writeFileSync",
	"appendFileSync",
	"readdirSync",
	"statSync",
	"lstatSync",
	"renameSync",
	"rmSync",
	"unlinkSync",
	"copyFileSync",
] as const;

/** Replace the synchronous Node filesystem surface used by these core tests with memory. */
export function installMemoryFs(): { fs: MemFs; restore: () => void } {
	const memoryFs = createMemFs();
	const spies = SYNC_METHODS.map((method) =>
		vi.spyOn(fs, method).mockImplementation((memoryFs[method] as any).bind(memoryFs)),
	);
	// Production modules use a mixture of default and named node:fs imports.
	syncBuiltinESMExports();
	return {
		fs: memoryFs,
		restore: () => {
			for (const spy of spies.reverse()) spy.mockRestore();
			syncBuiltinESMExports();
		},
	};
}
