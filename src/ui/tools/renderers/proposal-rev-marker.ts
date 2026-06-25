/**
 * Pure helpers for parsing the `__proposal_rev_v1__:<n>` marker out of
 * tool-result content. Extracted from ProposalRenderer/EditProposalRenderer
 * so unit tests can import them without dragging in lit-html.
 *
 * Design doc: docs/design/proposal-revision-snapshots.md — marker format.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";

const PROPOSAL_REV_RE = /__proposal_rev_v1__:(\d+)\b/;

export interface ProposalErrorDetails {
	code?: string;
	message: string;
	availableWorkflowIds: string[];
}

function resultTextBlocks(result: ToolResultMessage | undefined): string[] {
	if (!result) return [];
	const content = (result as any).content;
	if (typeof content === "string") return content ? [content] : [];
	if (!Array.isArray(content)) return [];
	return content
		.map((block) => block && typeof block === "object" && typeof (block as any).text === "string"
			? (block as any).text as string
			: undefined)
		.filter((text): text is string => Boolean(text));
}

function workflowId(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (value && typeof value === "object") {
		const id = (value as any).id;
		if (typeof id === "string" && id.trim()) return id.trim();
	}
	return undefined;
}

function availableWorkflowIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(new Set(value.map(workflowId).filter((id): id is string => Boolean(id))));
}

/** Extract the rev integer from a tool-result content stream, or undefined. */
export function parseRevFromResult(result: ToolResultMessage | undefined): number | undefined {
	for (const text of resultTextBlocks(result)) {
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
	for (const text of resultTextBlocks(result)) {
		try {
			const j = JSON.parse(text);
			if (j && typeof j === "object" && typeof (j as any).code === "string") {
				return (j as any).code as string;
			}
		} catch { /* not json */ }
	}
	return undefined;
}

/** Pull the structured proposal error message and workflow ids from a failed tool-result body. */
export function parseProposalErrorFromResult(result: ToolResultMessage | undefined): ProposalErrorDetails | undefined {
	if (!result) return undefined;
	let fallback: string | undefined;
	for (const text of resultTextBlocks(result)) {
		try {
			const j = JSON.parse(text);
			if (j && typeof j === "object") {
				const message = typeof (j as any).message === "string" && (j as any).message.trim()
					? (j as any).message.trim()
					: undefined;
				const code = typeof (j as any).code === "string" && (j as any).code.trim()
					? (j as any).code.trim()
					: undefined;
				const ids = availableWorkflowIds((j as any).availableWorkflows);
				if (message || code || ids.length > 0) {
					return {
						code,
						message: message || code || "Proposal failed.",
						availableWorkflowIds: ids,
					};
				}
			}
		} catch {
			fallback ||= text.trim() || undefined;
		}
	}
	return fallback ? { message: fallback, availableWorkflowIds: [] } : undefined;
}
