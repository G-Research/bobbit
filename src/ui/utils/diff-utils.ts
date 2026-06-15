/** Returns true if the text looks like a unified git diff. */
export function isGitDiff(text: string): boolean {
	return /^diff --git /m.test(text) && /^@@ /m.test(text);
}
