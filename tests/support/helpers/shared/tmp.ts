import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Create a temp dir and return its canonical (realpath'd) path.
 * Portable across macOS (/var -> /private/var symlink), Linux, and Windows.
 */
export function makeTmpDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Canonicalize an existing path (no-op when already canonical). */
export function canonical(p: string): string {
	return fs.realpathSync(p);
}
