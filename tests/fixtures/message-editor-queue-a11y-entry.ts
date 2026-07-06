// Test entry — bundles the REAL <message-editor> Lit component to pin the
// judgment-item-12 a11y fix (PR #246): a steered queue pill's accessible
// name must include "(steered)", not just its amber-vs-muted color.
import "../../src/ui/components/MessageEditor.js";

(window as any).__mountEditor = (container: HTMLElement) => {
	container.innerHTML = "";
	const el = document.createElement("message-editor") as any;
	el.sessionId = "queue-a11y-test";
	el.onSteer = () => {};
	el.onRemoveQueued = () => {};
	el.onEditQueued = () => {};
	el.onReorder = () => {};
	container.appendChild(el);
	return el;
};

(window as any).__setQueue = (el: any, queue: Array<{ id: string; text: string; isSteered: boolean; createdAt: number }>) => {
	el.queuedMessages = queue;
};

(window as any).__ready = true;
