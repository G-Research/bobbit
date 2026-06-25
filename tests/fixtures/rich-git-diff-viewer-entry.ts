// Test entry — bundles RichGitDiffViewer so we can render it in a file:// fixture.
import "../../src/ui/components/RichGitDiffViewer.js";

interface MountOptions {
	content: string;
	title?: string;
	filePath?: string;
	defaultMode?: "auto" | "split" | "inline";
	showCopy?: boolean;
}

async function waitForViewerUpdate(el: HTMLElement & { updateComplete?: Promise<unknown> }) {
	await customElements.whenDefined("rich-git-diff-viewer");
	if (el.updateComplete) await el.updateComplete;
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

(window as any).__mountRichGitDiffViewer = async (options: MountOptions) => {
	const container = document.getElementById("container")!;
	container.innerHTML = "";
	const viewer = document.createElement("rich-git-diff-viewer") as HTMLElement & {
		content: string;
		title?: string;
		filePath?: string;
		defaultMode?: "auto" | "split" | "inline";
		showCopy?: boolean;
		updateComplete?: Promise<unknown>;
	};
	viewer.content = options.content;
	viewer.title = options.title ?? "Fixture diff";
	viewer.filePath = options.filePath;
	viewer.defaultMode = options.defaultMode ?? "auto";
	viewer.showCopy = options.showCopy ?? false;
	container.appendChild(viewer);
	await waitForViewerUpdate(viewer);
	return true;
};

(window as any).__ready = true;
