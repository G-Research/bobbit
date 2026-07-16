const stderrText = (error) => {
	if (!error || typeof error !== "object" || !("stderr" in error)) return "";
	const { stderr } = error;
	return Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr ?? "");
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Git reports a missing path at an otherwise valid revision with one of these
 * two messages, depending on whether the path exists in the working tree.
 * Match the requested path and revision exactly so unrelated Git failures stay
 * fatal.
 */
export function isMissingGitPathAtRevisionError(error, { path, revision }) {
	if (error?.status !== 128) return false;
	const quotedPath = escapeRegExp(path);
	const quotedRevision = escapeRegExp(revision);
	return new RegExp(
		`^fatal: path '${quotedPath}' (?:does not exist in|exists on disk, but not in) '${quotedRevision}'\\r?\\n?$`,
	).test(stderrText(error));
}

/**
 * Read a historical migration source that is allowed to disappear once its
 * migration lands. The injected reader keeps the exceptional policy pure and
 * directly testable without spawning Git.
 */
export function readOptionalGitPath(readGitText, { path, revision }) {
	try {
		return readGitText(["show", `${revision}:${path}`]);
	} catch (error) {
		if (isMissingGitPathAtRevisionError(error, { path, revision })) return "";
		throw error;
	}
}
