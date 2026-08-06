import { promptExtensionContentDigest } from "./prompt-extension-overrides.js";

/** A small, deterministic replacement diff for the human proposal/audit surfaces. */
export function createPromptExtensionUnifiedDiff(
	before: string,
	after: string,
	labels: { packId: string; sectionId: string },
): string {
	const name = `${labels.packId}/${labels.sectionId}`;
	const oldLines = splitLines(before);
	const newLines = splitLines(after);
	const lines = [
		`--- a/${name}`,
		`+++ b/${name}`,
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
		...oldLines.map(line => `-${line}`),
		...newLines.map(line => `+${line}`),
	];
	return lines.join("\n") + "\n";
}

/** Content-only baseline metadata; does not disclose the prior text. */
export function promptExtensionBaseline(content: string): { baselineDigest: string; baselineBytes: number } {
	return {
		baselineDigest: promptExtensionContentDigest(content),
		baselineBytes: Buffer.byteLength(content, "utf8"),
	};
}

function splitLines(value: string): string[] {
	if (value === "") return [];
	const lines = value.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}
