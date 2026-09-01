/** Decode Git's `-z` pathname output without treating newlines as separators. */
export function parseNullDelimitedGitPaths(output) {
	const text = Buffer.isBuffer(output) ? output.toString("utf-8") : String(output ?? "");
	return text.split("\0").filter(Boolean);
}
