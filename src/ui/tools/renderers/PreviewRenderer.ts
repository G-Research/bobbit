import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, nothing } from "lit";
import { PanelRight } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderContext, ToolRenderer, ToolRenderResult } from "../types.js";

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
	assets?: string[];
	manifest?: string;
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
	| { kind: "preview"; url: string; path: string; entry?: string; contentHash?: string };

function parseSnapshotText(text: string): ParsedSnapshot | null {
	if (text.startsWith(PREVIEW_SNAPSHOT_MARKER_V3)) {
		const body = text.slice(PREVIEW_SNAPSHOT_MARKER_V3.length).trim();
		try {
			const parsed = JSON.parse(body);
			if (parsed && parsed.kind === "preview" && typeof parsed.url === "string" && parsed.url) {
				const contentHash = normalizeContentHash(parsed.contentHash);
				return {
					kind: "preview",
					url: parsed.url,
					path: typeof parsed.path === "string" ? parsed.path : "",
					entry: typeof parsed.entry === "string" ? parsed.entry : undefined,
					...(contentHash ? { contentHash } : {}),
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

function normalizeContentHash(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const hash = value.trim().toLowerCase();
	return /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
}

function hashString(value: string): string {
	let h = 5381;
	for (let i = 0; i < value.length; i++) h = ((h << 5) + h) ^ value.charCodeAt(i);
	return (h >>> 0).toString(36);
}

function baseName(path: string | undefined): string {
	if (!path) return "";
	const clean = path.split(/[?#]/, 1)[0]?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
	return clean.split("/").filter(Boolean).pop() || clean || "";
}

function previewTabTitle(params: PreviewOpenParams | undefined, parsed: ParsedSnapshot, entry: string | undefined): string {
	const sourcePath = params?.file
		|| (parsed.kind === "file" ? parsed.path : undefined)
		|| (parsed.kind === "preview" ? parsed.entry || parsed.path : undefined)
		|| entry;
	return baseName(sourcePath) || "inline.html";
}

function previewTabId(toolUseId: string | undefined, blockIndex: number, parsed: ParsedSnapshot, entry: string | undefined, params: PreviewOpenParams | undefined): string {
	if (toolUseId) return `preview:tool:${encodeURIComponent(toolUseId)}:${blockIndex}`;
	const stable = (parsed.kind === "preview" ? parsed.contentHash : undefined)
		|| params?.file
		|| entry
		|| (parsed.kind === "preview" ? parsed.url : parsed.kind === "file" ? parsed.path : parsed.html.slice(0, 1024));
	return `preview:snapshot:${hashString(stable)}`;
}

function restorableSnapshot(parsed: ParsedSnapshot, params: PreviewOpenParams | undefined): ParsedSnapshot {
	if (parsed.kind === "preview") {
		if (typeof params?.file === "string" && params.file) return { kind: "file", path: params.file };
		if (typeof params?.html === "string") return { kind: "inline", html: params.html };
	}
	return parsed;
}

function mountBodyForSnapshot(parsed: ParsedSnapshot, params: PreviewOpenParams | undefined): Record<string, unknown> | null {
	const restorable = restorableSnapshot(parsed, params);
	if (restorable.kind === "file") {
		const body: Record<string, unknown> = { file: restorable.path };
		if (Array.isArray(params?.assets) && params.assets.length > 0) body.assets = params.assets;
		if (typeof params?.manifest === "string" && params.manifest) body.manifest = params.manifest;
		return body;
	}
	if (restorable.kind === "inline") return { html: restorable.html };
	return null;
}

function previewTabSource(
	params: PreviewOpenParams | undefined,
	parsed: ParsedSnapshot,
	entry: string | undefined,
	toolUseId: string | undefined,
	blockIndex: number,
): Record<string, unknown> {
	const restorable = restorableSnapshot(parsed, params);
	const contentHash = parsed.kind === "preview" ? parsed.contentHash : undefined;
	const source: Record<string, unknown> = {
		type: "preview_open",
		snapshotKind: restorable.kind,
		markerKind: parsed.kind,
		toolUseId,
		blockIndex,
		entry,
		params: { file: params?.file || "", inline: !params?.file },
	};
	if (contentHash) source.contentHash = contentHash;
	if (parsed.kind === "preview") {
		source.url = parsed.url;
		source.snapshotUrl = parsed.url;
		source.snapshotPath = parsed.path;
	}
	if (restorable.kind === "file") {
		source.path = restorable.path;
	} else if (restorable.kind === "inline") {
		source.inline = true;
	} else {
		source.path = restorable.path;
	}
	return source;
}

function previewTabState(parsed: ParsedSnapshot, entry: string | undefined, mtime: number, url: string | undefined, params: PreviewOpenParams | undefined): Record<string, unknown> {
	const restorable = restorableSnapshot(parsed, params);
	const contentHash = parsed.kind === "preview" ? parsed.contentHash : undefined;
	const state: Record<string, unknown> = {
		snapshotKind: restorable.kind,
		markerKind: parsed.kind,
		entry,
		mtime,
		url,
	};
	if (contentHash) state.contentHash = contentHash;
	if (restorable.kind === "inline") state.snapshotHtml = restorable.html;
	else if (restorable.kind === "file") state.snapshotFile = restorable.path;
	if (parsed.kind === "preview") {
		state.snapshotUrl = parsed.url;
		state.snapshotPath = parsed.path;
	}
	return state;
}

function entryFromSnapshot(parsed: ParsedSnapshot, params: PreviewOpenParams | undefined, fallback?: string): string {
	if (fallback) return fallback;
	if (parsed.kind === "preview") {
		if (parsed.entry) return parsed.entry;
		const m = /^\/preview\/[^/]+\/(.+)$/.exec(parsed.url);
		if (m) return decodeURIComponent(m[1]);
	}
	if (typeof params?.file === "string" && params.file) return baseName(params.file);
	if (parsed.kind === "file") return baseName(parsed.path);
	return "inline.html";
}

const registeredPreviewSnapshotKeys = new Set<string>();

function rememberPreviewSnapshotFromRender(
	params: PreviewOpenParams | undefined,
	result: ToolResultMessage<any> | undefined,
	isStreaming: boolean | undefined,
	ctx: ToolRenderContext | undefined,
): void {
	if (isStreaming || !result || result.isError || !ctx?.sessionId) return;
	const snap = findSnapshotBlock(result);
	if (!snap || snap.block._truncated) return;
	const parsed = parseSnapshotText(snap.block.text);
	if (!parsed || parsed.kind !== "preview" || !parsed.contentHash) return;
	const entry = entryFromSnapshot(parsed, params);
	const key = `${ctx.sessionId}:${ctx.toolUseId || ""}:${snap.index}:${entry}:${parsed.contentHash}`;
	if (registeredPreviewSnapshotKeys.has(key)) return;
	registeredPreviewSnapshotKeys.add(key);
	queueMicrotask(async () => {
		try {
			const [{ state: appState, renderApp }, workspace, previewPanel] = await Promise.all([
				import("../../../app/state.js"),
				import("../../../app/panel-workspace.js"),
				import("../../../app/preview-panel.js"),
			]);
			const version = workspace.registerPreviewVersion(appState, ctx.sessionId!, entry, parsed.contentHash, { current: false });
			const liveHash = normalizeContentHash((appState as any).previewPanelContentHash);
			const liveEntry = workspace.previewEntryLabel((appState as any).previewPanelEntry || "inline.html");
			if (liveHash !== parsed.contentHash || liveEntry !== workspace.previewEntryLabel(entry)) return;
			const tabSource = previewTabSource(params, parsed, entry, ctx.toolUseId, snap.index);
			const tabState = previewTabState(parsed, entry, (appState as any).previewPanelMtime || Date.now(), parsed.url, params);
			if (version != null) {
				tabSource.version = version;
				tabState.version = version;
			}
			previewPanel.selectHtmlPreviewTab({
				sessionId: ctx.sessionId,
				entry,
				mtime: (appState as any).previewPanelMtime || Date.now(),
				contentHash: parsed.contentHash,
				url: parsed.url,
				source: tabSource,
				state: tabState,
				select: false,
				setAssistantTab: false,
			});
			renderApp();
		} catch {
			/* best-effort metadata enrichment */
		}
	});
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
		rememberPreviewSnapshotFromRender(params, result, isStreaming, ctx);
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

				const snapshotContentHash = parsed.kind === "preview" ? parsed.contentHash : undefined;
				let liveContentHashBeforeOpen: string | undefined;
				try {
					const { state: appState } = await import("../../../app/state.js");
					liveContentHashBeforeOpen = normalizeContentHash((appState as any).previewPanelContentHash);
				} catch { /* optional state probe */ }

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
				let contentHashFromPost: string | undefined;
				const liveAlreadyHasSnapshot = !!snapshotContentHash && liveContentHashBeforeOpen === snapshotContentHash;
				const postBody = liveAlreadyHasSnapshot ? null : mountBodyForSnapshot(parsed, params);
				if (postBody) {
					const postResp = await gatewayFetch(`/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`, {
						method: "POST",
						body: JSON.stringify(postBody),
					});
					if (!postResp.ok) {
						if ("file" in postBody && (postResp.status === 400 || postResp.status === 404)) {
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
						contentHashFromPost = normalizeContentHash(data?.contentHash);
					} catch { /* ignore — body parse is best-effort */ }
				}

				// 5. Imperatively refresh the preview side-panel client-side.
				//    SSE only fires on new mount writes — for v3 reopens the
				//    mount already exists so no SSE arrives. Bump the mtime to
				//    force the iframe to reload (its src includes `#mtime=<n>`
				//    as a cache buster) and set the entry from the snapshot URL.
				try {
					const [{ state: appState, renderApp }, workspace, { selectHtmlPreviewTab }] = await Promise.all([
						import("../../../app/state.js"),
						import("../../../app/panel-workspace.js"),
						import("../../../app/preview-panel.js"),
					]);
					let entry = entryFromPost;
					if (!entry && parsed.kind === "preview") {
						entry = parsed.entry;
						if (!entry && typeof parsed.url === "string") {
							// parsed.url is `/preview/<sid>/<entry>` — extract <entry>.
							const m = /^\/preview\/[^/]+\/(.+)$/.exec(parsed.url);
							if (m) entry = decodeURIComponent(m[1]);
						}
					}
					const mtime = mtimeFromPost ?? Date.now();
					const mountedContentHash = contentHashFromPost || snapshotContentHash;
					// Explicit Open clicks refresh the current filename tab. Historical
					// versioned tabs are created during transcript/workspace hydration; the
					// button should not fork a second tab for the same filename.
					const shouldKeepCurrentPreviewTab = true;
					void liveAlreadyHasSnapshot;
					const version = workspace.registerPreviewVersion(appState, sessionId, entry || "inline.html", mountedContentHash, { current: shouldKeepCurrentPreviewTab });
					if (entry) (appState as any).previewPanelEntry = entry;
					(appState as any).previewPanelMtime = mtime;
					(appState as any).previewPanelContentHash = mountedContentHash || "";
					(appState as any).isPreviewSession = true;
					const tabId = previewTabId(ctx?.toolUseId, snap.index, parsed, entry, params);
					const tabTitle = previewTabTitle(params, parsed, entry);
					const tabSource = previewTabSource(params, parsed, entry, ctx?.toolUseId, snap.index);
					const tabState = previewTabState(parsed, entry, mtime, parsed.kind === "preview" ? parsed.url : undefined, params);
					if (mountedContentHash) {
						tabSource.contentHash = mountedContentHash;
						tabState.contentHash = mountedContentHash;
					}
					if (version != null) {
						tabSource.version = version;
						tabState.version = version;
					}
					selectHtmlPreviewTab({
						sessionId,
						entry,
						mtime,
						contentHash: mountedContentHash,
						id: tabId,
						title: tabTitle,
						url: parsed.kind === "preview" ? parsed.url : undefined,
						source: tabSource,
						state: tabState,
						historical: !shouldKeepCurrentPreviewTab,
						version,
						dedupeWithLive: shouldKeepCurrentPreviewTab,
						select: true,
					});
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
