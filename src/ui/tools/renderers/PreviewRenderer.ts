import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, nothing } from "lit";
import { PanelRight } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderContext, ToolRenderer, ToolRenderResult } from "../types.js";
import { state as appState } from "../../../app/state.js";

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
	| { kind: "preview"; url: string; path: string; entry?: string; contentHash?: string; artifactId?: string };

function parseSnapshotText(text: string): ParsedSnapshot | null {
	if (text.startsWith(PREVIEW_SNAPSHOT_MARKER_V3)) {
		const body = text.slice(PREVIEW_SNAPSHOT_MARKER_V3.length).trim();
		try {
			const parsed = JSON.parse(body);
			if (parsed && parsed.kind === "preview" && typeof parsed.url === "string" && parsed.url) {
				const contentHash = normalizeContentHash(parsed.contentHash);
				const artifactId = normalizeArtifactId(parsed.artifactId ?? parsed.artifact_id ?? parsed.aid);
				return {
					kind: "preview",
					url: parsed.url,
					path: typeof parsed.path === "string" ? parsed.path : "",
					entry: typeof parsed.entry === "string" ? parsed.entry : undefined,
					...(contentHash ? { contentHash } : {}),
					...(artifactId ? { artifactId } : {}),
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

function normalizeContentHash(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const hash = value.trim().toLowerCase();
	return /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
}

// Mirrors VALID_ARTIFACT_ID in src/server/preview/artifacts.ts. Keeping the
// client-side check in sync gives the user a clean "unavailable" state instead
// of a generic "Failed — retry" when a marker carries a malformed id (which the
// server would also reject with 400/404).
const VALID_ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
function normalizeArtifactId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const artifactId = value.trim();
	if (!artifactId || !VALID_ARTIFACT_ID_RE.test(artifactId)) return undefined;
	return artifactId;
}

function baseName(path: string | undefined): string {
	if (!path) return "";
	const clean = path.split(/[?#]/, 1)[0]?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
	return clean.split("/").filter(Boolean).pop() || clean || "";
}

function legacyPreviewParamsSnapshot(params: PreviewOpenParams | undefined): ParsedSnapshot | null {
	// Legacy v3 markers predate artifact ids. For those markers only, best-effort
	// restore from the original tool params when they are still available.
	if (typeof params?.html === "string") return { kind: "inline", html: params.html };
	if (typeof params?.file === "string" && params.file) return { kind: "file", path: params.file };
	return null;
}

function restorableSnapshot(parsed: ParsedSnapshot, params: PreviewOpenParams | undefined): ParsedSnapshot {
	// New v3 preview markers are artifact-backed. Do not fall back to source paths
	// when an artifact id is present: if artifact restore fails, the tab must show
	// an error instead of aliasing to the current source file.
	if (parsed.kind === "preview" && !parsed.artifactId) return legacyPreviewParamsSnapshot(params) ?? parsed;
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
		if (parsed.artifactId) source.artifactId = parsed.artifactId;
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
		if (parsed.artifactId) state.artifactId = parsed.artifactId;
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

function currentPreviewHashForEntry(workspace: any, appState: any, sessionId: string, entry: string): string | undefined {
	const label = workspace.previewEntryLabel(entry);
	const currentTabId = workspace.previewEntryTabId(entry);
	const tabs = typeof workspace.panelTabsForSession === "function" ? workspace.panelTabsForSession(appState, sessionId) : [];
	const currentTab = Array.isArray(tabs) ? tabs.find((tab: any) => tab?.kind === "preview" && tab?.id === currentTabId) : undefined;
	const tabHash = typeof workspace.previewContentHashFromTab === "function" ? workspace.previewContentHashFromTab(currentTab) : "";
	if (tabHash) return tabHash;
	const liveEntry = typeof workspace.previewEntryLabel === "function" ? workspace.previewEntryLabel(appState.previewPanelEntry || "inline.html") : baseName(appState.previewPanelEntry || "inline.html");
	return liveEntry === label ? normalizeContentHash(appState.previewPanelContentHash) : undefined;
}

function restoreErrorPayload(message = "Preview artifact unavailable", status?: number, artifactId?: string): Record<string, unknown> {
	return {
		message,
		...(typeof status === "number" ? { status } : {}),
		retryable: typeof status === "number" ? status >= 500 : false,
		...(artifactId ? { artifactId } : {}),
	};
}

function selectPreviewRestoreErrorTab(args: {
	appState: any;
	renderApp: () => void;
	workspace: any;
	previewPanel: any;
	sessionId: string;
	entry: string;
	parsed: ParsedSnapshot;
	params: PreviewOpenParams | undefined;
	ctx: ToolRenderContext | undefined;
	blockIndex: number;
	contentHash?: string;
	status?: number;
	message?: string;
}): void {
	const { appState, workspace, previewPanel, sessionId, entry, parsed, params, ctx, blockIndex, contentHash, status, message } = args;
	const artifactId = parsed.kind === "preview" ? parsed.artifactId : undefined;
	const error = restoreErrorPayload(message, status, artifactId);
	const identity = workspace.previewTabIdentityForContent(appState, sessionId, entry, contentHash, { historical: true });
	const version = identity.version;
	const source = previewTabSource(params, parsed, entry, ctx?.toolUseId, blockIndex);
	const tabState = previewTabState(parsed, entry, Date.now(), parsed.kind === "preview" ? parsed.url : undefined, params);
	source.restoreError = error;
	tabState.restoreError = error;
	if (contentHash) {
		source.contentHash = contentHash;
		tabState.contentHash = contentHash;
	}
	if (version != null) {
		source.version = version;
		tabState.version = version;
	}
	previewPanel.selectHtmlPreviewTab({
		sessionId,
		entry,
		contentHash,
		url: parsed.kind === "preview" ? parsed.url : undefined,
		source,
		state: tabState,
		historical: true,
		version,
		dedupeWithLive: false,
		select: true,
	});
	appState.isPreviewSession = true;
	appState.previewPanelEntry = "";
	appState.previewPanelMtime = 0;
	appState.previewPanelContentHash = "";
	appState.previewPanelMountedTabId = "";
	args.renderApp();
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
			const liveHash = normalizeContentHash((appState as any).previewPanelContentHash);
			const liveEntry = workspace.previewEntryLabel((appState as any).previewPanelEntry || "inline.html");
			if (liveHash !== parsed.contentHash || liveEntry !== workspace.previewEntryLabel(entry)) return;
			const identity = workspace.previewTabIdentityForContent(appState, ctx.sessionId!, entry, parsed.contentHash, { current: true });
			const version = identity.version;
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
				const [{ gatewayFetch }, { fetchToolContent }, { state: appState, renderApp }, workspace, previewPanel] = await Promise.all([
					import("../../../app/api.js"),
					import("../../utils/fetch-tool-content.js"),
					import("../../../app/state.js"),
					import("../../../app/panel-workspace.js"),
					import("../../../app/preview-panel.js"),
				]);

				// 1. Resolve full snapshot text (inline or lazy-load)
				let snapshotText = snap.block.text;
				if (snap.block._truncated) {
					const located = await locateToolResultBlock(ctx?.toolUseId, snap.index);
					if (!located) throw new Error("Could not locate snapshot block in transcript");
					snapshotText = await fetchToolContent(sessionId, located.messageIndex, located.blockIndex);
				}

				// 2. Parse snapshot — v1 (inline), v2 (file), or v3 (artifact-backed preview mount).
				const parsed = parseSnapshotText(snapshotText);
				if (!parsed) throw new Error("Snapshot block could not be parsed");

				let entry = entryFromSnapshot(parsed, params);
				const snapshotContentHash = parsed.kind === "preview" ? parsed.contentHash : undefined;
				const snapshotArtifactId = parsed.kind === "preview" ? parsed.artifactId : undefined;
				const currentHashBeforeOpen = currentPreviewHashForEntry(workspace, appState, sessionId, entry);
				const snapshotMatchesCurrent = !!snapshotContentHash && currentHashBeforeOpen === snapshotContentHash;

				const selectRestoreError = (status?: number, message = "Preview artifact unavailable") => {
					selectPreviewRestoreErrorTab({
						appState,
						renderApp,
						workspace,
						previewPanel,
						sessionId,
						entry,
						parsed,
						params,
						ctx,
						blockIndex: snap.index,
						contentHash: snapshotContentHash,
						status,
						message,
					});
				};

				// 3. Enable preview mode (idempotent)
				const patchResp = await gatewayFetch(`/api/sessions/${sessionId}`, {
					method: "PATCH",
					body: JSON.stringify({ preview: true }),
				});
				if (!patchResp.ok) throw new Error(`PATCH failed: ${patchResp.status}`);

				// 4. Restore the exact snapshot into the single live mount when needed.
				// v3 markers with artifact ids restore by artifact only. Legacy v3 markers
				// without artifact ids may best-effort re-stamp original inline/file params,
				// and v1/v2 markers keep their existing mount-endpoint fallback.
				let mtimeFromPost: number | undefined;
				let contentHashFromPost: string | undefined;
				let urlFromPost: string | undefined;
				let artifactIdFromPost: string | undefined;
				const postMountSnapshot = async (postBody: Record<string, unknown>) => {
					const postResp = await gatewayFetch(`/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`, {
						method: "POST",
						body: JSON.stringify(postBody),
					});
					if (!postResp.ok) {
						if ("file" in postBody && (postResp.status === 400 || postResp.status === 404)) {
							btn.textContent = "File no longer available";
							btn.disabled = true;
							return false;
						}
						throw new Error(`POST failed: ${postResp.status}`);
					}
					try {
						const data = await postResp.json();
						if (typeof data?.entry === "string" && data.entry) entry = data.entry;
						if (typeof data?.mtime === "number") mtimeFromPost = data.mtime;
						if (typeof data?.url === "string" && data.url) urlFromPost = data.url;
						contentHashFromPost = normalizeContentHash(data?.contentHash);
						// The server now persists an immutable artifact on every successful mount
						// and returns its id. Capture it so the resulting tab can restore by
						// artifact later (e.g. switching back to this filename tab after another
						// preview overwrote the live mount). Without this, legacy v1/v2 or
						// v3-without-artifactId markers create tabs with no restore source and
						// the iframe 404s the next time the tab is selected — pinned by
						// tests/e2e/ui/dynamic-chat-tabs.spec.ts "legacy v1 and v2 preview_open
						// snapshots remain distinct across reload".
						if (typeof data?.artifactId === "string" && data.artifactId) artifactIdFromPost = data.artifactId;
					} catch { /* ignore — body parse is best-effort */ }
					return true;
				};
				if (parsed.kind === "preview") {
					if (!snapshotMatchesCurrent) {
						if (snapshotArtifactId) {
							const restoreResp = await gatewayFetch(`/api/preview/artifacts/${encodeURIComponent(snapshotArtifactId)}/restore?sessionId=${encodeURIComponent(sessionId)}`, {
								method: "POST",
								body: JSON.stringify({ artifactId: snapshotArtifactId }),
							});
							if (!restoreResp.ok) {
								selectRestoreError(restoreResp.status, "Preview artifact unavailable");
								throw new Error(`Preview artifact restore failed: ${restoreResp.status}`);
							}
							const data = await restoreResp.json().catch(() => ({} as any));
							if (typeof data?.entry === "string" && data.entry) entry = data.entry;
							if (typeof data?.mtime === "number") mtimeFromPost = data.mtime;
							if (typeof data?.url === "string" && data.url) urlFromPost = data.url;
							if (typeof data?.artifactId === "string" && data.artifactId) artifactIdFromPost = data.artifactId;
							const restoredHash = normalizeContentHash(data?.contentHash);
							if (snapshotContentHash && !restoredHash) {
								selectRestoreError(502, "Preview artifact unavailable");
								throw new Error("Preview artifact restore returned no valid content hash");
							}
							if (snapshotContentHash && restoredHash !== snapshotContentHash) {
								selectRestoreError(409, "Preview artifact unavailable");
								throw new Error("Preview artifact content hash mismatch");
							}
							contentHashFromPost = restoredHash || snapshotContentHash;
						} else {
							const postBody = mountBodyForSnapshot(parsed, params);
							if (postBody && !(await postMountSnapshot(postBody))) return;
						}
					}
				} else {
					const postBody = mountBodyForSnapshot(parsed, params);
					if (postBody && !(await postMountSnapshot(postBody))) return;
				}

				// 5. Imperatively refresh the preview side-panel client-side.
				const mtime = mtimeFromPost ?? Date.now();
				const mountedContentHash = contentHashFromPost || snapshotContentHash;
				const currentHashForEntry = currentHashBeforeOpen || currentPreviewHashForEntry(workspace, appState, sessionId, entry);
				const shouldKeepCurrentPreviewTab = !currentHashForEntry || (!!mountedContentHash && currentHashForEntry === mountedContentHash);
				const identity = workspace.previewTabIdentityForContent(appState, sessionId, entry, mountedContentHash, {
					current: shouldKeepCurrentPreviewTab,
					historical: !shouldKeepCurrentPreviewTab,
				});
				const version = identity.version;
				appState.previewPanelEntry = entry;
				appState.previewPanelMtime = mtime;
				appState.previewPanelContentHash = mountedContentHash || "";
				appState.isPreviewSession = true;
				const tabSource = previewTabSource(params, parsed, entry, ctx?.toolUseId, snap.index);
				const tabState = previewTabState(parsed, entry, mtime, urlFromPost || (parsed.kind === "preview" ? parsed.url : undefined), params);
				if (mountedContentHash) {
					tabSource.contentHash = mountedContentHash;
					tabState.contentHash = mountedContentHash;
				}
				if (version != null) {
					tabSource.version = version;
					tabState.version = version;
				}
				const resolvedArtifactId = artifactIdFromPost
					|| (parsed.kind === "preview" ? parsed.artifactId : undefined);
				if (resolvedArtifactId) {
					tabSource.artifactId = resolvedArtifactId;
					tabState.artifactId = resolvedArtifactId;
				}
				previewPanel.selectHtmlPreviewTab({
					sessionId,
					entry,
					mtime,
					contentHash: mountedContentHash,
					url: urlFromPost || (parsed.kind === "preview" ? parsed.url : undefined),
					source: tabSource,
					state: tabState,
					historical: !shouldKeepCurrentPreviewTab,
					version,
					dedupeWithLive: shouldKeepCurrentPreviewTab,
					select: true,
				});
				renderApp();

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
