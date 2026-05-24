// Main chat interface

export type { Agent, AgentMessage, AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { Model } from "@earendil-works/pi-ai";
export { ChatPanel } from "./ChatPanel.js";
// Components
//
// All custom-element re-exports below are type-only — a value re-export
// would force Rollup to retain the file's side-effectful `customElement`
// registration in every entry chunk that imports anything from
// `ui/index.ts` (even unrelated symbols like `AppStorage`). The actual
// `customElements.define(...)` calls happen via static side-effect
// imports inside the components themselves (ChatPanel → AgentInterface
// → BgProcessPill / MessageEditor / MessageList / …), so the elements
// are still registered on cold start. Type-only keeps the public
// library API surface (`new AgentInterface()`, `instanceof X`) for
// external consumers without dragging the value graph into entry.
export type { AgentInterface } from "./components/AgentInterface.js";
export type { ContinueSessionChooser } from "./components/ContinueSessionChooser.js";
export { bobbitLoadingAnimation } from "./components/BobbitLoadingAnimation.js";
export type { BgProcessPill, BgProcessInfo } from "./components/BgProcessPill.js";
export type { AttachmentTile } from "./components/AttachmentTile.js";
// Value re-export would force the 21 kB widget into every entry that
// touches `ui/index.ts`. The widget is registered lazily by
// `AskUserChoicesRenderer` via `app/lazy-widgets.ts`.
export type { AskUserChoicesWidget } from "./components/AskUserChoicesWidget.js";
export type { ConsoleBlock } from "./components/ConsoleBlock.js";
// `isGitDiff` is a pure function (used by BashRenderer in entry); the
// class re-export is type-only to keep the customElement registration
// side effect out of entry. BashRenderer's value import still evaluates
// the module and registers `<diff-block>` for inline diff rendering.
export { isGitDiff } from "./components/DiffBlock.js";
export type { DiffBlock } from "./components/DiffBlock.js";
export type { ErrorMessage } from "./components/ErrorMessage.js";
export type { ErrorDetails } from "./components/ErrorDetails.js";
export type { CustomProviderCard } from "./components/CustomProviderCard.js";
export type { ExpandableSection } from "./components/ExpandableSection.js";
export type { SkillChip, SkillChipData } from "./components/SkillChip.js";
export type { Input } from "./components/Input.js";
export type { MessageEditor } from "./components/MessageEditor.js";
export type { MessageList } from "./components/MessageList.js";
// Message components
// Class re-exports are type-only (registration happens via
// AgentInterface's static side-effect import of `./Messages.js`).
// Function exports stay as values — `defaultConvertToLlm` and the
// `is*` type guards are value-imported by `app/custom-messages.ts`.
export type { ArtifactMessage, UserMessageWithAttachments } from "./components/Messages.js";
export type {
	AbortedMessage,
	AssistantMessage,
	ToolMessage,
	ToolMessageDebugView,
	UserMessage,
} from "./components/Messages.js";
export {
	convertAttachments,
	defaultConvertToLlm,
	isArtifactMessage,
	isUserMessageWithAttachments,
} from "./components/Messages.js";
// Message renderer registry
export {
	getMessageRenderer,
	type MessageRenderer,
	type MessageRole,
	registerMessageRenderer,
	renderMessage,
} from "./components/message-renderer-registry.js";
// Type-only — value re-export drags the 8 kB popover (and its tag
// registration) into every entry that touches `ui/index.ts`. Consumers
// open the popover via `app/goal-entry.ts::showProjectPickerPopover`,
// which now lazy-imports the component on click.
export type { ProjectPickerPopover, ProjectPickerItem } from "./components/ProjectPickerPopover.js";
// ProviderKeyInput statically imports value symbols from `@earendil-works/pi-ai`
// (`complete`, `getModel`), which would drag the 553 kB generated model catalog
// into the entry chunk via this re-export. Consumers that need to register the
// custom element should `import "./components/ProviderKeyInput.js"` directly
// (settings-page already does, via ApiKeyPromptDialog / SettingsDialog).
// Type-only re-export keeps the public type surface; tsc erases it.
// See `src/app/pi-ai-lazy.ts` and `docs/design/shrink-initial-bundle.md`.
export type { ProviderKeyInput } from "./components/ProviderKeyInput.js";
// Type-only — a value re-export forces the 15 kB SandboxedIframe (and
// its customElement registration side effects) into every entry that
// touches `ui/index.ts`. Consumers that actually need to register the
// element should `import "./components/SandboxedIframe.js"` directly
// (currently `ui/tools/artifacts/HtmlArtifact.ts` and
// `ui/tools/javascript-repl.ts`, both already in their own lazy chunks).
export type {
	SandboxFile,
	SandboxIframe,
	SandboxResult,
	SandboxUrlProvider,
} from "./components/SandboxedIframe.js";
export type { StreamingMessageContainer } from "./components/StreamingMessageContainer.js";
// Sandbox Runtime Providers
export { ArtifactsRuntimeProvider } from "./components/sandbox/ArtifactsRuntimeProvider.js";
export { AttachmentsRuntimeProvider } from "./components/sandbox/AttachmentsRuntimeProvider.js";
export { type ConsoleLog, ConsoleRuntimeProvider } from "./components/sandbox/ConsoleRuntimeProvider.js";
export {
	type DownloadableFile,
	FileDownloadRuntimeProvider,
} from "./components/sandbox/FileDownloadRuntimeProvider.js";
export { RuntimeMessageBridge } from "./components/sandbox/RuntimeMessageBridge.js";
export { RUNTIME_MESSAGE_ROUTER } from "./components/sandbox/RuntimeMessageRouter.js";
export type { SandboxRuntimeProvider } from "./components/sandbox/SandboxRuntimeProvider.js";
export type { ThinkingBlock } from "./components/ThinkingBlock.js";
// Type-only — `ApiKeyPromptDialog` transitively pulls the pi-ai model catalog
// (via `ProviderKeyInput`). See the ProviderKeyInput re-export above.
export type { ApiKeyPromptDialog } from "./dialogs/ApiKeyPromptDialog.js";
// Value re-export would force the 14 kB overlay (and its drag/drop
// dialog graph) into every entry that touches `ui/index.ts`. The
// overlay loads on demand via `app/lazy-widgets.ts::loadAttachmentOverlay`.
export type { AttachmentOverlay } from "./dialogs/AttachmentOverlay.js";
// Dialogs
// Type-only — `ModelSelector` statically imports `modelsAreEqual` from
// `@earendil-works/pi-ai`, which drags the 553 kB generated model catalog
// into whichever chunk reaches it. Consumers that need to open the dialog
// import directly from `./dialogs/ModelSelector.js`.
export type { ModelSelector } from "./dialogs/ModelSelector.js";
export type { PersistentStorageDialog } from "./dialogs/PersistentStorageDialog.js";
// Type-only — `ProvidersModelsTab` value-imports `getProviders` from pi-ai.
export type { ProvidersModelsTab } from "./dialogs/ProvidersModelsTab.js";
export type { SessionListDialog } from "./dialogs/SessionListDialog.js";
// Type-only — `SettingsDialog` value-imports `getProviders` from pi-ai.
export type { ApiKeysTab, ProxyTab, SettingsDialog, SettingsTab } from "./dialogs/SettingsDialog.js";
// Prompts
export {
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO,
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW,
	ATTACHMENTS_RUNTIME_DESCRIPTION,
} from "./prompts/prompts.js";
// Storage
export { AppStorage, getAppStorage, setAppStorage } from "./storage/app-storage.js";
export { IndexedDBStorageBackend } from "./storage/backends/indexeddb-storage-backend.js";
export { Store } from "./storage/store.js";
export type {
	AutoDiscoveryProviderType,
	CustomProvider,
	CustomProviderType,
} from "./storage/stores/custom-providers-store.js";
export { CustomProvidersStore } from "./storage/stores/custom-providers-store.js";
export { CommandHistoryStore } from "./storage/stores/command-history-store.js";
export type { CommandHistoryEntry } from "./storage/stores/command-history-store.js";
export { ProviderKeysStore } from "./storage/stores/provider-keys-store.js";
export { SessionsStore } from "./storage/stores/sessions-store.js";
export { SettingsStore } from "./storage/stores/settings-store.js";
export { ShortcutBindingsStore } from "./storage/stores/shortcut-bindings-store.js";
export type {
	IndexConfig,
	IndexedDBConfig,
	SessionData,
	SessionMetadata,
	StorageBackend,
	StorageTransaction,
	StoreConfig,
} from "./storage/types.js";
// Artifacts — type-only re-exports keep the heavy class graph (highlight.js,
// pdfjs, docx-preview chains) out of the main chunk. Value imports happen
// inside ChatPanel via a dynamic `import("./tools/artifacts/index.js")`.
export type { Artifact, ArtifactsParams } from "./tools/artifacts/artifacts.js";
export type { ArtifactsPanel } from "./tools/artifacts/artifacts.js";
export type { ArtifactsToolRenderer } from "./tools/artifacts/artifacts-tool-renderer.js";
// Tools
export { getToolRenderer, registerToolRenderer, renderTool, setShowJsonMode } from "./tools/index.js";
export { renderCollapsibleHeader, renderHeader } from "./tools/renderer-registry.js";
export { BashRenderer } from "./tools/renderers/BashRenderer.js";
export { CalculateRenderer } from "./tools/renderers/CalculateRenderer.js";
// Tool renderers
export { DefaultRenderer } from "./tools/renderers/DefaultRenderer.js";
export { GetCurrentTimeRenderer } from "./tools/renderers/GetCurrentTimeRenderer.js";
// Review-pane web components. Value re-exports here would force the
// whole review-document chain (`@recogito/text-annotator`,
// `@annotorious/core`, `rbush`, `marked`) into every entry that
// touches `ui/index.ts` — even just for an unrelated `AppStorage`
// import — because Rollup pessimistically retains side-effectful
// re-exports. Type-only keeps the public type surface; consumers that
// need to register the custom elements should `import` them directly
// from `./components/review/...`. The cheap shells (`<review-pane>`,
// `<commentable-markdown>`) are eagerly registered by `app/render.ts`;
// the heavy `<review-document>` + `<annotation-popover>` chunk loads
// on demand via `app/lazy-review.ts`.
export type { ReviewPane } from "./components/review/ReviewPane.js";
export type { ReviewDocument } from "./components/review/ReviewDocument.js";
export type { CommentableMarkdown } from "./components/CommentableMarkdown.js";
export type { AnnotationPopover } from "./components/review/AnnotationPopover.js";
// Type-only — see comment block above on review/widget re-exports. Both
// elements are registered lazily on first render via
// `app/lazy-widgets.ts::ensureSearchBox`. Consumers wanting to mount
// the elements register them via that helper or by importing the file
// directly.
export type { SearchBox } from "./components/SearchBox.js";
export type { SearchResults } from "./components/SearchResults.js";
export type { SearchResult } from "./components/SearchResults.js";
export type { VerificationOutputModal } from "./components/VerificationOutputModal.js";
export type { ToolRenderer, ToolRenderResult } from "./tools/types.js";
export type { Attachment } from "./utils/attachment-utils.js";
// Utils
export { loadAttachment } from "./utils/attachment-utils.js";
export { clearAuthToken, getAuthToken } from "./utils/auth-token.js";
export { formatCost, formatModelCost, formatTokenCount, formatUsage } from "./utils/format.js";
export { i18n, setLanguage, translations } from "./utils/i18n.js";
export { applyProxyIfNeeded, createStreamFn, isCorsError, shouldUseProxyForProvider } from "./utils/proxy-utils.js";
export { fetchToolContent } from "./utils/fetch-tool-content.js";
