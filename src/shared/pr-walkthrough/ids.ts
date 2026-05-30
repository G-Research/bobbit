const SHORT_SHA_LENGTH = 7;

export function shortSha(value: string | undefined, length = SHORT_SHA_LENGTH): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return "unknown";
	return trimmed.slice(0, Math.min(length, trimmed.length));
}

export function changesetIdForLocal(baseSha: string, headSha: string): string {
	return `${shortSha(baseSha)}..${shortSha(headSha)}`;
}

export function changesetIdForGithub(owner: string, repo: string, number: string | number, headSha?: string): string {
	return `github:${owner.trim()}/${repo.trim()}#${String(number).trim()}:${headSha ? shortSha(headSha) : "unknown"}`;
}

export function stableSlug(value: string): string {
	return value
		.trim()
		.replace(/\\/g, "/")
		.replace(/[^a-zA-Z0-9._/-]+/g, "-")
		.replace(/\/+/g, "/")
		.replace(/^-+|-+$/g, "")
		.replace(/\//g, "__")
		.slice(0, 96) || "item";
}

export function walkthroughCardId(phaseId: string, title: string, index = 0): string {
	return `${phaseId}-${stableSlug(title).toLowerCase()}-${index + 1}`;
}

export function diffBlockIdForFile(filePath: string, index = 0): string {
	return `block:${index + 1}:${stableSlug(filePath)}`;
}

export function hunkIdForBlock(blockId: string, hunkIndex: number): string {
	return `${blockId}:h${hunkIndex}`;
}

export function lineIdForHunk(blockId: string, hunkIndex: number, lineIndex: number): string {
	return `${blockId}:h${hunkIndex}:l${lineIndex}`;
}
