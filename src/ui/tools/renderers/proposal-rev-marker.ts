/**
 * Pure helpers for parsing the `__proposal_rev_v1__:<n>` marker out of
 * tool-result content. Extracted from ProposalRenderer/EditProposalRenderer
 * so unit tests can import them without dragging in lit-html.
 *
 * Design doc: docs/design/proposal-revision-snapshots.md \u2014 marker format.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";

const PROPOSAL_REV_RE = /__proposal_rev_v1__:(\d+)\b/;

/** Extract the rev integer from a tool-result content stream, or undefined. */
export function parseRevFromResult(result: ToolResultMessage | undefined): number | undefined {
	if (!result) return undefined;
	const content = (result as any).content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const text = block && typeof block === "object" && typeof (block as any).text === "string"
			? (block as any).text as string
			: undefined;
		if (!text) continue;
		const m = PROPOSAL_REV_RE.exec(text);
		if (m) {
			const n = Number.parseInt(m[1], 10);
			if (Number.isFinite(n) && n > 0) return n;
		}
	}
	return undefined;
}

/** Pull the structured-error code field from the JSON body the gateway returns. */
export function parseErrorCodeFromResult(result: ToolResultMessage | undefined): string | undefined {
	if (!result) return undefined;
	const content = (result as any).content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const text = block && typeof block === "object" && typeof (block as any).text === "string"
			? (block as any).text as string
			: undefined;
		if (!text) continue;
		try {
			const j = JSON.parse(text);
			if (j && typeof j === "object" && typeof (j as any).code === "string") {
				return (j as any).code as string;
			}
		} catch { /* not json */ }
	}
	return undefined;
}
