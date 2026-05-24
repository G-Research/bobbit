// Main chat interface

export type { Agent, AgentMessage, AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { Model } from "@earendil-works/pi-ai";
export { ChatPanel } from "./ChatPanel.js";
// Components
export { AgentInterface } from "./components/AgentInterface.js";
export { ContinueSessionChooser } from "./components/ContinueSessionChooser.js";
export { bobbitLoadingAnimation } from "./components/BobbitLoadingAnimation.js";
export { BgProcessPill, type BgProcessInfo } from "./components/BgProcessPill.js";
export { AttachmentTile } from "./components/AttachmentTile.js";
export { AskUserChoicesWidget } from "./components/AskUserChoicesWidget.js";
export { ConsoleBlock } from "./components/ConsoleBlock.js";
export { DiffBlock, isGitDiff } from "./components/DiffBlock.js";
export { ErrorMessage } from "./components/ErrorMessage.js";
export { ErrorDetails } from "./components/ErrorDetails.js";
export { CustomProviderCard } from "./components/CustomProviderCard.js";
export { ExpandableSection } from "./components/ExpandableSection.js";
export { SkillChip, type SkillChipData } from "./components/SkillChip.js";
export { Input } from "./components/Input.js";
export { MessageEditor } from "./components/MessageEditor.js";
export { MessageList } from "./components/MessageList.js";
// Message components
export type { ArtifactMessage, UserMessageWithAttachments } from "./components/Messages.js";
export {
	AbortedMessage,
	AssistantMessage,
	convertAttachments,
	defaultConvertToLlm,
	isArtifactMessage,
	isUserMessageWithAttachments,
	ToolMessage,
	ToolMessageDebugView,
	UserMessage,
} from "./components/Messages.js";
// Message renderer registry
export {
	getMessageRenderer,
	type MessageRenderer,
	type MessageRole,
	registerMessageRenderer,
	renderMessage,
} from "./components/message-renderer-registry.js";
export { ProjectPickerPopover, type ProjectPickerItem } from "./components/ProjectPickerPopover.js";
// ProviderKeyInput statically imports value symbols from `@earendil-works/pi-ai`
// (`complete`, `getModel`), which would drag the 553 kB generated model catalog
// into the entry chunk via this re-export. Consumers that need to register the
// custom element should `import "./components/ProviderKeyInput.js"` directly
// (settings-page already does, via ApiKeyPromptDialog / SettingsDialog).
// Type-only re-export keeps the public type surface; tsc erases it.
// See `src/app/pi-ai-lazy.ts` and `docs/design/shrink-initial-bundle.md`.
export type { ProviderKeyInput } from "./components/ProviderKeyInput.js";
export {
	type SandboxFile,
	SandboxIframe,
	type SandboxResult,
	type SandboxUrlProvider,
} from "./components/SandboxedIframe.js";
export { StreamingMessageContainer } from "./components/StreamingMessageContainer.js";
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
export { ThinkingBlock } from "./components/ThinkingBlock.js";
// Type-only — `ApiKeyPromptDialog` transitively pulls the pi-ai model catalog
// (via `ProviderKeyInput`). See the ProviderKeyInput re-export above.
export type { ApiKeyPromptDialog } from "./dialogs/ApiKeyPromptDialog.js";
export { AttachmentOverlay } from "./dialogs/AttachmentOverlay.js";
// Dialogs
// Type-only — `ModelSelector` statically imports `modelsAreEqual` from
// `@earendil-works/pi-ai`, which drags the 553 kB generated model catalog
// into whichever chunk reaches it. Consumers that need to open the dialog
// import directly from `./dialogs/ModelSelector.js`.
export type { ModelSelector } from "./dialogs/ModelSelector.js";
export { PersistentStorageDialog } from "./dialogs/PersistentStorageDialog.js";
// Type-only — `ProvidersModelsTab` value-imports `getProviders` from pi-ai.
export type { ProvidersModelsTab } from "./dialogs/ProvidersModelsTab.js";
export { SessionListDialog } from "./dialogs/SessionListDialog.js";
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
export { ReviewPane } from "./components/review/ReviewPane.js";
export { ReviewDocument } from "./components/review/ReviewDocument.js";
export { CommentableMarkdown } from "./components/CommentableMarkdown.js";
export { AnnotationPopover } from "./components/review/AnnotationPopover.js";
export { SearchBox } from "./components/SearchBox.js";
export { SearchResults, type SearchResult } from "./components/SearchResults.js";
export { VerificationOutputModal } from "./components/VerificationOutputModal.js";
export type { ToolRenderer, ToolRenderResult } from "./tools/types.js";
export type { Attachment } from "./utils/attachment-utils.js";
// Utils
export { loadAttachment } from "./utils/attachment-utils.js";
export { clearAuthToken, getAuthToken } from "./utils/auth-token.js";
export { formatCost, formatModelCost, formatTokenCount, formatUsage } from "./utils/format.js";
export { i18n, setLanguage, translations } from "./utils/i18n.js";
export { applyProxyIfNeeded, createStreamFn, isCorsError, shouldUseProxyForProvider } from "./utils/proxy-utils.js";
export { fetchToolContent } from "./utils/fetch-tool-content.js";
