/**
 * Lazy loader for the review-document chain.
 *
 * The heavy review components — `<review-document>` and
 * `<annotation-popover>` — pull in `@recogito/text-annotator`,
 * `@annotorious/core`, `rbush`, and `marked`. None of that is needed on
 * cold start (review pane and inline proposal comments only appear when
 * the user explicitly opens a review or a proposal panel).
 *
 * The cheap shells — `<commentable-markdown>` and `<review-pane>` —
 * stay eagerly registered so `render.ts` can emit them inline. They
 * each call `ensureReviewComponents()` from their `connectedCallback`,
 * which fires the dynamic import once. Lit auto-upgrades the unknown
 * `<review-document>` / `<annotation-popover>` elements once the chunk
 * lands; property bindings set before upgrade are preserved.
 *
 * Memoised — second call returns the same promise; module evaluation
 * (and therefore `customElements.define`) only runs once.
 */
let _loaded: Promise<unknown> | null = null;

export function ensureReviewComponents(): Promise<unknown> {
	if (_loaded) return _loaded;
	_loaded = Promise.all([
		import("../ui/components/review/ReviewDocument.js"),
		import("../ui/components/review/AnnotationPopover.js"),
	]);
	return _loaded;
}
