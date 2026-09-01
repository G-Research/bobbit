import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createFsFromVolume, Volume } from "memfs";
import { vi } from "vitest";

export type NodeFs = typeof fs;

/**
 * Temporarily route selected node:fs APIs through a fresh in-memory volume.
 * Callers own the beforeAll/afterAll scope so shared isolate:false forks never
 * retain the spies after their file finishes.
 */
export function installScopedMemFs(methods: ReadonlyArray<keyof NodeFs>): {
	fs: NodeFs;
	restore(): void;
} {
	const memoryFs = createFsFromVolume(new Volume()) as unknown as NodeFs;

	// memfs canonicalizes to POSIX paths on Windows. Production path guards use
	// host-shaped path.resolve/path.relative, so keep realpath results host-shaped.
	const rawRealpathSync = memoryFs.realpathSync.bind(memoryFs);
	memoryFs.realpathSync = ((value: Parameters<NodeFs["realpathSync"]>[0], options?: Parameters<NodeFs["realpathSync"]>[1]) => {
		const real = String(rawRealpathSync(value, options as never)).replace(/\//g, path.sep);
		if (process.platform !== "win32" || /^[A-Za-z]:[\\/]/.test(real)) return real;
		const drive = path.parse(String(value)).root.slice(0, 2) || path.parse(process.cwd()).root.slice(0, 2) || "C:";
		return path.resolve(`${drive}${real.startsWith(path.sep) ? "" : path.sep}${real}`);
	}) as NodeFs["realpathSync"];

	const spies = methods.map((name) =>
		vi.spyOn(fs as any, name as any).mockImplementation((memoryFs as any)[name].bind(memoryFs)),
	);
	// Modules using `import * as fs` receive Node's named built-in exports. Keep
	// those bindings aligned with the spied default export for the scoped period.
	syncBuiltinESMExports();

	return {
		fs: memoryFs,
		restore() {
			for (const spy of spies.reverse()) spy.mockRestore();
			syncBuiltinESMExports();
		},
	};
}
