let loadPrWalkthroughPanelPromise: Promise<void> | null = null;

export function ensurePrWalkthroughPanel(): Promise<void> {
	if (!loadPrWalkthroughPanelPromise) {
		loadPrWalkthroughPanelPromise = import("../ui/components/pr-walkthrough/PrWalkthroughPanel.js").then(() => undefined);
	}
	return loadPrWalkthroughPanelPromise;
}
