import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, nothing } from "lit";
import { PanelRight } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderContext, ToolRenderer, ToolRenderResult } from "../types.js";
import { state as appState, renderApp } from "../../../app/state.js";

/** Must match `defaults/tools/html/snapshot.ts`. */
// Read-only legacy support for archived sessions stamped before the v3 cutover. Do not extend.
const PREVIEW_SNAPSHOT_MARKER_V1 = "__preview_snapshot_v1__\n";
// Read-only legacy support for archived sessions stamped before the v3 cutover. Do not extend.
const PREVIEW_SNAPSHOT_MARKER_V2 = "__preview_snapshot_v2__\n";
// WP-E primary path — every new preview_open call emits this marker.
const PREVIEW_SNAPSHOT_MARKER_V3 = "__preview_snapshot_v3__\n";

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

type ParsedSnapshot =
	| { kind: "inline"; html: string }
	| { kind: "file"; path: string }
	| { kind: "preview"; url: string; path: string; entry?: string };

function parseSnapshotText(text: string): ParsedSnapshot | null {
	if (text.startsWith(PREVIEW_SNAPSHOT_MARKER_V3)) {
		const body = text.slice(PREVIEW_SNAPSHOT_MARKER_V3.length).trim();
		try {
			const parsed = JSON.parse(body);
			if (parsed && parsed.kind === "preview" && typeof parsed.url === "string" && parsed.url) {
				return {
					kind: "preview",
					url: parsed.url,
					path: typeof parsed.path === "string" ? parsed.path : "",
					entry: typeof parsed.entry === "string" ? parsed.entry : undefined,
				};
			}
		} catch {
			/* fall through */
		}
		return null;
	}
	// Read-only legacy support for archived sessions stamped before the v3 cutover. Do not extend.
	if (text.startsWith(PREVIEW_SNAPSHOT_MARKER_V1)) {
		return { kind: "inline", html: text.slice(PREVIEW_SNAPSHOT_MARKER_V1.length) };
	}
	// Read-only legacy support for archived sessions stamped before the v3 cutover. Do not extend.
	if (text.startsWith(PREVIEW_SNAPSHOT_MARKER_V2)) {
		const body = text.slice(PREVIEW_SNAPSHOT_MARKER_V2.length).trim();
		try {
			const parsed = JSON.parse(body);
			if (parsed && parsed.kind === "file" && typeof parsed.path === "string" && parsed.path) {
				return { kind: "file", path: parsed.path };
			}
		} catch {
			/* fall through */
		}
		return null;
	}
	return null;
}

/** Find a snapshot text block in a tool_result's content array, returning block + index. */
function findSnapshotBlock(result: ToolResultMessage<any> | undefined): { block: SnapshotBlock; index: number } | null {
	const content = result?.content;
	if (!Array.isArray(content)) return null;
	for (let i = 0; i < content.length; i++) {
		const b = content[i] as any;
		if (!b || b.type !== "text") continue;
		if (typeof b.text !== "string") continue;
		if (
			b.text.startsWith(PREVIEW_SNAPSHOT_MARKER_V1) ||
			b.text.startsWith(PREVIEW_SNAPSHOT_MARKER_V2) ||
			b.text.startsWith(PREVIEW_SNAPSHOT_MARKER_V3)
		) {
			return { block: b as SnapshotBlock, index: i };
		}
	}
	return null;
}

/** Locate (messageIndex, blockIndex) for a tool_result message whose toolCallId matches. */
async function locateToolResultBlock(toolUseId: string | undefined, blockIndexInResult: number): Promise<{ messageIndex: number; blockIndex: number } | null> {
	if (!toolUseId) return null;
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

				// 2. Parse snapshot — v1 (inline), v2 (file), or v3 (preview mount).
				const parsed = parseSnapshotText(snapshotText);
				if (!parsed) throw new Error("Snapshot block could not be parsed");

				// 3. Enable preview mode (idempotent)
				const patchResp = await gatewayFetch(`/api/sessions/${sessionId}`, {
					method: "PATCH",
					body: JSON.stringify({ preview: true }),
				});
				if (!patchResp.ok) throw new Error(`PATCH failed: ${patchResp.status}`);

				// 4. v3: mount is already populated server-side; v1/v2: re-stamp
				//    the per-session preview mount via `/api/preview/mount`.
				//
				// LEGACY CAVEAT (v2): the original behaviour BFS-walked the source
				// directory and copied every sibling. The current mount endpoint
				// requires explicit `assets`/`manifest` opt-in, so v2 reopen will
				// copy ONLY the entry file — any sibling CSS/images referenced from
				// the entry HTML will 404. This is acceptable because v2 markers
				// only exist in archived sessions (read-only legacy); the original
				// behaviour was already brittle (broken whenever the source file had
				// been moved/deleted). New previews use v3 and the mount persists
				// across the renderer's lifetime.
				let entryFromPost: string | undefined;
				let mtimeFromPost: number | undefined;
				if (parsed.kind !== "preview") {
					const postBody: Record<string, unknown> = parsed.kind === "file"
						? { file: parsed.path }
						: { html: parsed.html };
					const postResp = await gatewayFetch(`/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`, {
						method: "POST",
						body: JSON.stringify(postBody),
					});
					if (!postResp.ok) {
						if (parsed.kind === "file" && (postResp.status === 400 || postResp.status === 404)) {
							btn.textContent = "File no longer available";
							btn.disabled = true;
							return;
						}
						throw new Error(`POST failed: ${postResp.status}`);
					}
					try {
						const data = await postResp.json();
						if (typeof data?.entry === "string" && data.entry) entryFromPost = data.entry;
						if (typeof data?.mtime === "number") mtimeFromPost = data.mtime;
					} catch { /* ignore — body parse is best-effort */ }
				}

				// 5. Imperatively refresh the preview side-panel client-side.
				//    SSE only fires on new mount writes — for v3 reopens the
				//    mount already exists so no SSE arrives. Bump the mtime to
				//    force the iframe to reload (its src includes `#mtime=<n>`
				//    as a cache buster) and set the entry from the snapshot URL.
				try {
					let entry = entryFromPost;
					if (!entry && parsed.kind === "preview") {
						entry = parsed.entry;
						if (!entry && typeof parsed.url === "string") {
							// parsed.url is `/preview/<sid>/<entry>` — extract <entry>.
							const m = /^\/preview\/[^/]+\/(.+)$/.exec(parsed.url);
							if (m) entry = m[1];
						}
					}
					if (entry) (appState as any).previewPanelEntry = entry;
					(appState as any).previewPanelMtime = mtimeFromPost ?? Date.now();
					renderApp();
				} catch {
					/* state import failure shouldn't block the success animation */
				}

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
				data-testid="preview-open-button"
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
