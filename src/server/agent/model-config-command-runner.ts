import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Shared process seam for models.json and gateway credential command references.
 * Callers choose their own failure semantics: model config resolution is lenient,
 * while gateway credentials fail closed.
 */
export interface ModelConfigCommandRunner {
	execFile(
		file: string,
		args: readonly string[],
		options: { encoding: "utf-8"; timeout: number; windowsHide: boolean },
	): Promise<{ stdout: unknown; stderr: unknown }>;
}

const execFileAsync = promisify(execFile);

export const realModelConfigCommandRunner: ModelConfigCommandRunner = {
	async execFile(file, args, options) {
		return execFileAsync(file, [...args], options);
	},
};
