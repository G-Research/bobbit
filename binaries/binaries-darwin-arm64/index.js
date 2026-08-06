// Auto-generated: per-platform binary path exports.
// See ../../src/server/binaries.ts for the resolver that consumes these.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const ext = process.platform === "win32" ? ".exe" : "";

export const fdPath = join(dir, "bin", `fd${ext}`);
export const rgPath = join(dir, "bin", `rg${ext}`);
/** Self-contained executable from the official ast-grep release archive. */
export const astGrepPath = join(dir, "bin", `ast-grep${ext}`);
/** @deprecated Kept for consumers which historically called the executable sg. */
export const sgPath = astGrepPath;
