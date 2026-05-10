/**
 * Git diff helper (shared between session and goal endpoints).
 * Extracted from server.ts (commit: split server.ts).
 */
import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { execGit, execGitSafe } from "./git-exec.js";

const execFileAsync = promisify(execFileCb);

const DIFF_MAX_BYTES = 500 * 1024; // 500KB

export async function getGitDiff(cwd: string, file?: string, containerId?: string): Promise<string> {
	const opts = { cwd, encoding: "utf-8" as const, timeout: 5000 };
	let hasHead = true;
	try { await execGit("git rev-parse --verify HEAD", cwd, 5000, containerId); } catch { hasHead = false; }

	let diff = "";
	if (file) {
		// Sanitize: reject path traversal, absolute paths, drive letters
		if (file.includes("..") || path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)) {
			throw new Error("INVALID_PATH");
		}
		if (containerId) {
			// Run git diff inside container
			if (hasHead) {
				diff = await execGitSafe(`git diff HEAD -- ${file}`, cwd, "", containerId);
			} else {
				diff = await execGitSafe(`git diff --cached -- ${file}`, cwd, "", containerId)
					+ await execGitSafe(`git diff -- ${file}`, cwd, "", containerId);
			}
			if (!diff.trim()) {
				diff = await execGitSafe(`git diff --no-index /dev/null -- ${file}`, cwd, "", containerId);
			}
		} else if (hasHead) {
			const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--", file], opts);
			diff = stdout;
		} else {
			const { stdout: s1 } = await execFileAsync("git", ["diff", "--cached", "--", file], opts);
			const { stdout: s2 } = await execFileAsync("git", ["diff", "--", file], opts);
			diff = s1 + s2;
		}
		// Try untracked if empty (host path only — container path handled above)
		if (!diff.trim() && !containerId) {
			try {
				const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
				const { stdout } = await execFileAsync("git", ["diff", "--no-index", devNull, "--", file], opts);
				diff = stdout;
			} catch (e: any) {
				// git diff --no-index exits 1 when there are differences
				if (e.stdout) diff = e.stdout;
			}
		}
	} else {
		if (containerId) {
			if (hasHead) {
				diff = await execGitSafe("git diff HEAD", cwd, "", containerId);
			} else {
				diff = await execGitSafe("git diff --cached", cwd, "", containerId)
					+ await execGitSafe("git diff", cwd, "", containerId);
			}
		} else if (hasHead) {
			const { stdout } = await execFileAsync("git", ["diff", "HEAD"], opts);
			diff = stdout;
		} else {
			const { stdout: s1 } = await execFileAsync("git", ["diff", "--cached"], opts);
			const { stdout: s2 } = await execFileAsync("git", ["diff"], opts);
			diff = s1 + s2;
		}
	}

	if (!diff.trim()) throw new Error("NO_DIFF");

	if (Buffer.byteLength(diff, "utf-8") > DIFF_MAX_BYTES) {
		diff = diff.slice(0, DIFF_MAX_BYTES) + "\n\n--- Diff truncated (exceeded 500KB) ---";
	}
	return diff;
}
