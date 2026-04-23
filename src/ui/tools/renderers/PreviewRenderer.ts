import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, nothing } from "lit";
import { PanelRight } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderContext, ToolRenderer, ToolRenderResult } from "../types.js";

/** Must match `defaults/tools/html/snapshot.ts` PREVIEW_SNAPSHOT_MARKER. */
const PREVIEW_SNAPSHOT_MARKER = "__preview_snapshot_v1__\n";

interface PreviewOpenParams {
	html?: string;
	file?: string;
}

interface SnapshotBlock {
	type: "text";
	text: string;
	_truncated?: boolean;
	_originalLength?: number;
	preview?: string;
}

/** Find a snapshot text block in a tool_result's content array, returning block + index. */
function findSnapshotBlock(result: ToolResultMessage<any> | undefined): { block: SnapshotBlock; index: number } | null {
	const content = result?.content;
	if (!Array.isArray(content)) return null;
	for (let i = 0; i < content.length; i++) {
		const b = content[i] as any;
		if (!b || b.type !== "text") continue;
		if (typeof b.text !== "string") continue;
		if (b.text.startsWith(PREVIEW_SNAPSHOT_MARKER)) {
			return { block: b as SnapshotBlock, index: i };
		}
	}
	return null;
}

/** Locate (messageIndex, blockIndex) for a tool_result message whose toolCallId matches. */
async function locateToolResultBlock(toolUseId: string | undefined, blockIndexInResult: number): Promise<{ messageIndex: number; blockIndex: number } | null> {
	if (!toolUseId) return null;
	const { state: appState } = await import("../../../app/state.js");
	const messages: any[] | undefined = (appState as any).remoteAgent?.state?.messages;
	if (!Array.isArray(messages)) return null;
	for (let mi = 0; mi < messages.length; mi++) {
		const msg = messages[mi];
		const role = msg?.role;
		const isToolResult = role === "toolResult" || role === "tool_result" || role === "tool";
		if (!isToolResult) continue;
		if (msg.toolCallId !== toolUseId) continue;
		return { messageIndex: mi, blockIndex: blockIndexInResult };
	}
	return null;
}

export class PreviewOpenRenderer implements ToolRenderer<PreviewOpenParams, any> {
	render(
		params: PreviewOpenParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
		ctx?: ToolRenderContext,
	): ToolRenderResult {
		const toolState = getToolState(result, isStreaming);
		const label = params?.file
			? html`Preview: <span class="font-mono">${params.file}</span>`
			: "Preview: inline HTML";

		// Resolve the button disabled/tooltip state.
		const snap = findSnapshotBlock(result);
		const isResultError = !!result?.isError;
		const isComplete = !!result && !isStreaming;

		// Decide button behavior
		let disabled: boolean;
		let tooltip: string;
		if (isStreaming && !result) {
			disabled = true;
			tooltip = "Waiting for preview_open to complete…";
		} else if (isResultError) {
			disabled = true;
			tooltip = "preview_open failed — reopen unavailable";
		} else if (isComplete && !snap) {
			// Historical single-block result or missing snapshot
			disabled = true;
			tooltip = "Snapshot not captured — reopen unavailable for this historical preview";
		} else if (!isComplete) {
			// No result yet, not streaming — shouldn't usually happen
			disabled = true;
			tooltip = "Waiting for preview_open to complete…";
		} else {
			disabled = false;
			tooltip = "Re-open this preview in the side panel";
		}

		const onClick = async (e: Event) => {
			const btn = e.currentTarget as HTMLButtonElement;
			if (btn.disabled) return;
			const sessionId = ctx?.sessionId;
			if (!sessionId || !snap) return;

			const origLabel = btn.textContent;
			btn.disabled = true;
			btn.textContent = "Opening…";

			try {
				// Lazy-load helpers to avoid an import cycle at module init time.
				const [{ gatewayFetch }, { fetchToolContent }] = await Promise.all([
					import("../../../app/api.js"),
					import("../../utils/fetch-tool-content.js"),
				]);

				// 1. Resolve full snapshot text (inline or lazy-load)
				let snapshotText = snap.block.text;
				if (snap.block._truncated) {
					const located = await locateToolResultBlock(ctx?.toolUseId, snap.index);
					if (!located) throw new Error("Could not locate snapshot block in transcript");
					snapshotText = await fetchToolContent(sessionId, located.messageIndex, located.blockIndex);
				}

				// 2. Strip marker to get raw HTML
				const htmlPayload = snapshotText.startsWith(PREVIEW_SNAPSHOT_MARKER)
					? snapshotText.slice(PREVIEW_SNAPSHOT_MARKER.length)
					: snapshotText;

				// 3. Enable preview mode (idempotent)
				const patchResp = await gatewayFetch(`/api/sessions/${sessionId}`, {
					method: "PATCH",
					body: JSON.stringify({ preview: true }),
				});
				if (!patchResp.ok) throw new Error(`PATCH failed: ${patchResp.status}`);

				// 4. Push HTML to the preview panel
				const postResp = await gatewayFetch(`/api/preview?sessionId=${encodeURIComponent(sessionId)}`, {
					method: "POST",
					body: JSON.stringify({ html: htmlPayload }),
				});
				if (!postResp.ok) throw new Error(`POST failed: ${postResp.status}`);

				btn.textContent = "Opened ✓";
				setTimeout(() => {
					btn.textContent = origLabel;
					btn.disabled = false;
				}, 1500);
			} catch (err) {
				btn.textContent = "Failed — retry";
				btn.disabled = false;
				// eslint-disable-next-line no-console
				console.error("[PreviewRenderer] reopen failed:", err);
			}
		};

		const openButton = html`
			<button
				class="text-xs px-2 py-0.5 rounded border border-border bg-transparent text-primary hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
				?disabled=${disabled}
				title=${tooltip}
				data-preview-open-btn
				@click=${onClick}
			>
				Open
			</button>
		`;

		return {
			content: html`
				<div class="flex items-center justify-between gap-2">
					<div class="flex-1 min-w-0">${renderHeader(toolState, PanelRight, label)}</div>
					${openButton}
				</div>
				${nothing}
			`,
			isCustom: false,
		};
	}
}
