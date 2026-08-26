import { execFileSync } from "node:child_process";

interface GitOptions {
	cwd: string;
	encoding: "utf8";
	stdio: ["ignore", "pipe", "ignore"];
}

export type GitInvoker = (executable: string, args: string[], options: GitOptions) => string;

const invokeGit: GitInvoker = (executable, args, options) => execFileSync(executable, args, options);

/** Honour the manual override, otherwise resolve origin's primary branch without a shell. */
export function resolveCodeReviewBaseBranch(
	repoPath: string,
	configuredBranch: string | undefined = process.env.CODE_REVIEW_BASE,
	runGit: GitInvoker = invokeGit,
): string {
	if (configuredBranch) return configuredBranch;
	try {
		const symbolicRef = runGit(
			"git",
			["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
			{ cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		const match = /^origin\/(.+)$/.exec(symbolicRef);
		if (match?.[1]) return match[1];
	} catch {
		// Playwright discovery must remain usable when Git or origin/HEAD is absent.
	}
	return "main";
}
