import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, nothing, type TemplateResult } from "lit";
import { FileText, Loader } from "lucide";
import {
	getReviewOpenState,
	openReviewReceipt,
	registerReviewOpenReceipt,
	reviewOpenReceiptFromToolResult,
	type ReviewOpenErrorCode,
	type ReviewOpenReceipt,
	type ReviewOpenState,
} from "../../../app/review-open-controller.js";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderContext, ToolRenderer, ToolRenderResult } from "../types.js";

interface ReviewOpenFileParams {
	title?: string;
	markdown?: string;
	file?: string;
}

interface ReviewOpenParams {
	title?: string;
	markdown?: string;
	file?: string;
	files?: ReviewOpenFileParams[];
	replace?: boolean;
}

interface ReviewOpenPresentation {
	buttonLabel: "Open review" | "Re-open review" | "Opening…" | "Retry open" | "Open unavailable";
	disabled: boolean;
	pending: boolean;
	status?: string;
	error?: string;
	code?: ReviewOpenErrorCode;
}

const BUTTON_CLASSES = "shrink-0 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-border bg-transparent text-primary hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

function safeToolErrorCode(result: ToolResultMessage<any> | undefined): ReviewOpenErrorCode | undefined {
	if (!result?.isError || !Array.isArray(result.content)) return undefined;
	for (const block of result.content) {
		if (block?.type !== "text" || typeof (block as any).text !== "string") continue;
		try {
			const value = JSON.parse((block as any).text);
			const code = value && typeof value === "object" ? (value as any).code : undefined;
			if (code === "REVIEW_PAYLOAD_UNAVAILABLE" || code === "REVIEW_REFERENCE_INVALID"
				|| code === "REVIEW_PAYLOAD_TOO_LARGE" || code === "REVIEW_UNAUTHORIZED"
				|| code === "REVIEW_PERSISTENCE_FAILED" || code === "REVIEW_WORKSPACE_CONFLICT"
				|| code === "REVIEW_SESSION_UNAVAILABLE" || code === "REVIEW_CLIENT_OPEN_FAILED") return code;
		} catch { /* ordinary tool error text is deliberately not rendered */ }
	}
	return undefined;
}

function errorMessage(code: ReviewOpenErrorCode | undefined): string {
	switch (code) {
		case "REVIEW_PAYLOAD_UNAVAILABLE":
			return "Saved review content is no longer available. Run review_open again.";
		case "REVIEW_REFERENCE_INVALID":
			return "Saved review data is incomplete. Run review_open again.";
		case "REVIEW_PAYLOAD_TOO_LARGE":
			return "Review exceeds the 10 MiB limit. Reduce it and run review_open again.";
		case "REVIEW_UNAUTHORIZED":
			return "This review can’t be opened from this card.";
		case "REVIEW_PERSISTENCE_FAILED":
			return "Couldn’t save the review. Retry opening it.";
		case "REVIEW_WORKSPACE_CONFLICT":
			return "The review panel changed before it could open. Retry.";
		case "REVIEW_SESSION_UNAVAILABLE":
			return "This review’s session is not available. Reconnect and retry.";
		case "REVIEW_CLIENT_OPEN_FAILED":
			return "Review content was saved, but the panel couldn’t open. Retry.";
		default:
			return "Saved review data is incomplete. Run review_open again.";
	}
}

function presentation(
	result: ToolResultMessage<any> | undefined,
	isStreaming: boolean | undefined,
	receipt: ReviewOpenReceipt | null,
	openState: ReviewOpenState | undefined,
	identityAvailable: boolean,
): ReviewOpenPresentation {
	if (isStreaming || !result) {
		return {
			buttonLabel: "Open review",
			disabled: true,
			pending: false,
			status: "Available when the review is ready.",
		};
	}
	if (result.isError) {
		const code = safeToolErrorCode(result);
		return {
			buttonLabel: "Open unavailable",
			disabled: true,
			pending: false,
			status: code ? errorMessage(code) : "The review could not be prepared. Run review_open again.",
			...(code ? { code } : {}),
		};
	}
	if (!receipt || !identityAvailable) {
		return {
			buttonLabel: "Open unavailable",
			disabled: true,
			pending: false,
			status: errorMessage("REVIEW_REFERENCE_INVALID"),
			code: "REVIEW_REFERENCE_INVALID",
		};
	}
	if (!openState || openState.phase === "available") {
		return { buttonLabel: "Open review", disabled: false, pending: false };
	}
	if (openState.phase === "pending") {
		return {
			buttonLabel: "Opening…",
			disabled: true,
			pending: true,
			status: "Opening review…",
		};
	}
	if (openState.phase === "success") {
		return {
			buttonLabel: "Re-open review",
			disabled: false,
			pending: false,
			status: "Review opened.",
		};
	}
	if (openState.retryable) {
		return {
			buttonLabel: "Retry open",
			disabled: false,
			pending: false,
			error: errorMessage(openState.code),
			code: openState.code,
		};
	}
	return {
		buttonLabel: "Open unavailable",
		disabled: true,
		pending: false,
		status: errorMessage(openState.code),
		code: openState.code,
	};
}

function feedback(view: ReviewOpenPresentation, feedbackId: string): TemplateResult | typeof nothing {
	const diagnostic = view.code ? html` <span class="font-mono">(${view.code})</span>` : nothing;
	if (view.error) {
		return html`<div id=${feedbackId} data-testid="review-open-error" role="alert" class="text-xs text-destructive">${view.error}${diagnostic}</div>`;
	}
	if (view.status) {
		return html`<div id=${feedbackId} data-testid="review-open-status" role="status" class="text-xs text-muted-foreground">${view.status}${diagnostic}</div>`;
	}
	return nothing;
}

function accessibleActionLabel(view: ReviewOpenPresentation, title: string): string {
	const action = view.buttonLabel === "Opening…" ? "Opening review" : view.buttonLabel;
	return `${action}: ${title}`;
}

export class ReviewOpenRenderer implements ToolRenderer<ReviewOpenParams, any> {
	render(
		params: ReviewOpenParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
		ctx?: ToolRenderContext,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const title = params?.title ?? "Review";
		const label = params?.files
			? html`Review: ${title} (${params.files.length} ${params.files.length === 1 ? "file" : "files"})`
			: params?.file
				? html`Review: <span class="font-mono">${params.file}</span>`
				: html`Review: ${title}`;

		// Parsing and state lookup are read-only. Mounting or hydrating a historical
		// card must never open a review or clear an authoritative replay tombstone.
		const ownerSessionId = ctx?.sessionId;
		const toolUseId = ctx?.toolUseId;
		const receipt = !isStreaming && result && toolUseId
			? reviewOpenReceiptFromToolResult(result, toolUseId)
			: null;
		const openState = ownerSessionId && toolUseId && receipt
			? getReviewOpenState(ownerSessionId, toolUseId, receipt.payloadId)
			: undefined;
		const view = presentation(result, isStreaming, receipt, openState, !!ownerSessionId && !!toolUseId);
		const accessibleTitle = receipt?.title || title;
		const feedbackId = `review-open-feedback-${encodeURIComponent(ownerSessionId || "unknown")}-${encodeURIComponent(toolUseId || "unknown")}`;

		const onOpen = async (event: Event): Promise<void> => {
			event.preventDefault();
			event.stopPropagation();
			if (view.disabled || !ownerSessionId || !toolUseId || !receipt) return;
			const button = event.currentTarget as HTMLButtonElement;
			button.disabled = true;
			button.setAttribute("aria-busy", "true");
			button.setAttribute("aria-label", `Opening review: ${accessibleTitle}`);
			button.textContent = "Opening…";
			registerReviewOpenReceipt(ownerSessionId, toolUseId, receipt);
			await openReviewReceipt({
				sessionId: ownerSessionId,
				toolUseId,
				receipt,
				intent: "manual",
			});
		};

		return {
			content: html`
				<div class="flex items-center justify-between gap-2">
					<div class="flex-1 min-w-0">${renderHeader(state, FileText, label)}</div>
					<button
						type="button"
						data-testid="review-open-button"
						class=${BUTTON_CLASSES}
						?disabled=${view.disabled}
						aria-busy=${view.pending ? "true" : "false"}
						aria-label=${accessibleActionLabel(view, accessibleTitle)}
						aria-describedby=${view.status || view.error ? feedbackId : nothing}
						@click=${onOpen}
					>
						${view.pending ? html`<span class="inline-flex animate-spin" aria-hidden="true">${icon(Loader, "xs")}</span>` : nothing}
						${view.buttonLabel}
					</button>
				</div>
				${feedback(view, feedbackId)}
			`,
			isCustom: false,
		};
	}
}

interface ReviewCloseParams {
	title?: string;
}

export class ReviewCloseRenderer implements ToolRenderer<ReviewCloseParams, any> {
	render(
		params: ReviewCloseParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const label = params?.title
			? html`Closed review: ${params.title}`
			: "Closed all review tabs";
		return { content: renderHeader(state, FileText, label), isCustom: false };
	}
}
