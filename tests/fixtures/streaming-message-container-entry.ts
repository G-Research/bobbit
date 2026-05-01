// Test entry point — bundles StreamingMessageContainer for file:// use.
// Exposes the class globally so spec code can instantiate it and drive
// setMessage() directly to repro the sticky `_immediateUpdate` bug.
import { StreamingMessageContainer } from "../../src/ui/components/StreamingMessageContainer.js";

if (!customElements.get("streaming-message-container")) {
	customElements.define("streaming-message-container", StreamingMessageContainer);
}

(window as any).__StreamingMessageContainer = StreamingMessageContainer;
(window as any).__ready = true;
