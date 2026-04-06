// Test entry point — bundles only AssistantMessage + MarkdownBlock.
// Built by esbuild at test-time (not checked in).
// We re-export AssistantMessage so the custom element gets registered.
export { AssistantMessage } from "../../src/ui/components/Messages.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "../../src/ui/components/ThinkingBlock.js";
