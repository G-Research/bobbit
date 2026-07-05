// Test entry — bundles <message-list> so we can exercise UX-02's DOM-identity
// contract from a file:// fixture: does the SAME logical id-less transcript
// row keep its DOM node across a "re-snapshot" (a re-render where the
// reducer's `_insertionTick` metadata changes but the row's position/content
// does not)?
//
// Helpers exposed on `window`:
//   __mountMessageList(slotId, messages)  — render <message-list> with the
//                                            given raw messages (already
//                                            carrying reducer metadata, as
//                                            the real reducer would stamp
//                                            them)
//   __tagRows()                           — stamp a unique, non-attribute JS
//                                            marker on every top-level
//                                            rendered row element (survives
//                                            only if Lit reuses the node)
//   __readRowMarkers()                    — read back the markers in
//                                            current DOM order (undefined
//                                            for a node that was never
//                                            tagged, i.e. newly created)
//   __countRowNodes()                     — number of top-level row elements
import { html, render } from "lit";
import "../../src/ui/components/MessageList.js";

const ROW_CONTAINER_SELECTOR = "message-list > div.flex.flex-col.gap-3";
const MARKER_PROP = "__uxRowMarker";
let markerCounter = 0;

(window as any).__mountMessageList = (slotId: string, messages: any[]): void => {
	const slot = document.getElementById(slotId)!;
	render(
		html`<message-list
			.messages=${messages}
			.tools=${[]}
			.isStreaming=${false}
		></message-list>`,
		slot,
	);
};

(window as any).__tagRows = (): void => {
	const container = document.querySelector(ROW_CONTAINER_SELECTOR);
	if (!container) return;
	for (const el of Array.from(container.children)) {
		(el as any)[MARKER_PROP] = `marker-${markerCounter++}`;
	}
};

(window as any).__readRowMarkers = (): Array<string | undefined> => {
	const container = document.querySelector(ROW_CONTAINER_SELECTOR);
	if (!container) return [];
	return Array.from(container.children).map((el) => (el as any)[MARKER_PROP]);
};

(window as any).__countRowNodes = (): number => {
	const container = document.querySelector(ROW_CONTAINER_SELECTOR);
	return container ? container.children.length : 0;
};

(window as any).__ready = true;
