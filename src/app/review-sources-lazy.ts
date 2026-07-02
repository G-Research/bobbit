type ReviewSourcesModule = typeof import("./review-sources.js");

let reviewSourcesPromise: Promise<ReviewSourcesModule> | null = null;

export function loadReviewSources(): Promise<ReviewSourcesModule> {
	return reviewSourcesPromise ??= import("./review-sources.js");
}
