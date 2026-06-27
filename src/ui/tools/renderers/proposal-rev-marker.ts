/**
 * Pure helpers for parsing the `__proposal_rev_v1__:<n>` marker out of
 * tool-result content. Extracted from ProposalRenderer/EditProposalRenderer
 * so unit tests can import them without dragging in lit-html.
 *
 * Design doc: docs/design/proposal-revision-snapshots.md — marker format.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";

const PROPOSAL_REV_RE = /__proposal_rev_v1__:(\d+)\b/;

export type WorkflowValidationCode = "MISSING_WORKFLOW" | "UNKNOWN_WORKFLOW";

export interface ProposalErrorDetails {
	code?: string;
	message: string;
	availableWorkflowIds: string[];
	availableWorkflows?: Array<{ id: string; name?: string }>;
}

export interface ProposalWorkflowValidationErrorDetails {
	code: WorkflowValidationCode;
	message: string;
	workflowId?: string;
	availableWorkflows?: Array<{ id: string; name?: string }>;
}

interface ResultEvidence {
	texts: string[];
	payloads: Array<Record<string, unknown>>;
}

export function isWorkflowValidationCode(code: unknown): code is WorkflowValidationCode {
	return code === "MISSING_WORKFLOW" || code === "UNKNOWN_WORKFLOW";
}

function collectResultEvidence(value: unknown, evidence: ResultEvidence, depth = 0): void {
	if (depth > 6 || value === undefined || value === null) return;
	if (typeof value === "string") {
		const text = value.trim();
		if (!text) return;
		evidence.texts.push(text);
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				evidence.payloads.push(parsed as Record<string, unknown>);
			}
		} catch { /* not json */ }
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectResultEvidence(item, evidence, depth + 1);
		return;
	}
	if (typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (typeof record.code === "string" || typeof record.message === "string" || Array.isArray(record.availableWorkflows)) {
		evidence.payloads.push(record);
	}
	if (typeof record.text === "string") collectResultEvidence(record.text, evidence, depth + 1);
	collectResultEvidence(record.content, evidence, depth + 1);
	collectResultEvidence(record.output, evidence, depth + 1);
	collectResultEvidence(record.result, evidence, depth + 1);
}

function resultEvidence(result: ToolResultMessage | undefined): ResultEvidence {
	const evidence: ResultEvidence = { texts: [], payloads: [] };
	collectResultEvidence(result, evidence);
	return evidence;
}

function resultTextBlocks(result: ToolResultMessage | undefined): string[] {
	return resultEvidence(result).texts;
}

function workflowItem(value: unknown): { id: string; name?: string } | undefined {
	if (typeof value === "string" && value.trim()) return { id: value.trim() };
	if (value && typeof value === "object") {
		const id = (value as any).id;
		if (typeof id !== "string" || !id.trim()) return undefined;
		const name = (value as any).name;
		return typeof name === "string" && name.trim()
			? { id: id.trim(), name: name.trim() }
			: { id: id.trim() };
	}
	return undefined;
}

function uniqueWorkflowIds(ids: string[]): string[] {
	return Array.from(new Set(ids.filter(Boolean)));
}

function uniqueWorkflowItems(items: Array<{ id: string; name?: string }>): Array<{ id: string; name?: string }> {
	const byId = new Map<string, { id: string; name?: string }>();
	for (const item of items) {
		if (!item.id) continue;
		const existing = byId.get(item.id);
		if (!existing || (!existing.name && item.name)) byId.set(item.id, item);
	}
	return [...byId.values()];
}

function availableWorkflowItems(value: unknown): Array<{ id: string; name?: string }> {
	if (!Array.isArray(value)) return [];
	return uniqueWorkflowItems(value.map(workflowItem).filter((item): item is { id: string; name?: string } => Boolean(item)));
}

function inferWorkflowValidationCode(text: string): WorkflowValidationCode | undefined {
	if (/workflow is required/i.test(text)) return "MISSING_WORKFLOW";
	if (/unknown workflow/i.test(text)) return "UNKNOWN_WORKFLOW";
	return undefined;
}

function parsePlaintextAvailableWorkflowIds(text: string): string[] {
	const ids: string[] = [];
	const patterns = [
		/\bworkflow IDs\s*:\s*([^\n.]+)/gi,
		/\bavailable workflows(?:\s+for this project)?\s*:\s*([^\n.]+)/gi,
		/\bone of(?:\s+these IDs)?\s*:\s*([^\n.]+)/gi,
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text))) {
			const segment = match[1] ?? "";
			for (const idMatch of segment.matchAll(/[A-Za-z0-9][A-Za-z0-9_.-]*/g)) {
				ids.push(idMatch[0]);
			}
		}
	}
	return uniqueWorkflowIds(ids);
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
	const evidence = resultEvidence(result);
	for (const payload of evidence.payloads) {
		const message = typeof payload.message === "string" && payload.message.trim()
			? payload.message.trim()
			: undefined;
		const code = typeof payload.code === "string" && payload.code.trim()
			? payload.code.trim()
			: message ? inferWorkflowValidationCode(message) : undefined;
		const structuredWorkflows = availableWorkflowItems(payload.availableWorkflows);
		const plaintextIds = message ? parsePlaintextAvailableWorkflowIds(message) : [];
		const availableWorkflows = uniqueWorkflowItems([
			...structuredWorkflows,
			...plaintextIds.map((id) => ({ id })),
		]);
		const ids = availableWorkflows.map((workflow) => workflow.id);
		if (message || code || ids.length > 0) {
			return {
				code,
				message: message || code || "Proposal failed.",
				availableWorkflowIds: ids,
				...(availableWorkflows.length > 0 ? { availableWorkflows } : {}),
			};
		}
	}
	const fallback = evidence.texts.find(Boolean);
	if (!fallback) return undefined;
	const ids = parsePlaintextAvailableWorkflowIds(fallback);
	return {
		code: inferWorkflowValidationCode(fallback),
		message: fallback,
		availableWorkflowIds: ids,
		...(ids.length > 0 ? { availableWorkflows: ids.map((id) => ({ id })) } : {}),
	};
}

export function isWorkflowValidationProposalError(result: ToolResultMessage | undefined): boolean {
	return isWorkflowValidationCode(parseProposalErrorFromResult(result)?.code);
}

export function workflowValidationErrorFromProposalResult(
	result: ToolResultMessage | undefined,
	fields?: Record<string, unknown> | null,
): ProposalWorkflowValidationErrorDetails | undefined {
	const details = parseProposalErrorFromResult(result);
	if (!details || !isWorkflowValidationCode(details.code)) return undefined;
	const workflowId = typeof fields?.workflow === "string" ? fields.workflow : undefined;
	return {
		code: details.code,
		message: details.message,
		...(workflowId !== undefined ? { workflowId } : {}),
		...(details.availableWorkflows && details.availableWorkflows.length > 0
			? { availableWorkflows: details.availableWorkflows }
			: details.availableWorkflowIds.length > 0
				? { availableWorkflows: details.availableWorkflowIds.map((id) => ({ id })) }
				: {}),
	};
}
