// Server-side re-export shim. The YAML → cards synthesis (validate + map +
// DiffReferenceMapper + flattenDiffBlocks + helpers) was MOVED into the PURE shared
// module src/shared/pr-walkthrough/yaml-to-cards.ts so the first-party pr-walkthrough
// pack can bundle and run the SAME synthesis (design built-in-first-party-packs.md
// §8.4). This file keeps the agent-side import surface stable (ZERO behavior change)
// and maps the structural synthesis result onto the server `WalkthroughStorePayload`
// type, which intentionally stays server-side.
import {
	mapYamlToWalkthroughPayload as mapYamlToCards,
	validatePrWalkthroughYaml,
	type MapYamlToWalkthroughPayloadOptions,
	type PrWalkthroughYamlDocument,
	type WalkthroughParsedDiffForYamlMapping,
} from "../../shared/pr-walkthrough/yaml-to-cards.js";
import type { WalkthroughStorePayload } from "./walkthrough-store.js";

export { validatePrWalkthroughYaml };
export type {
	MapYamlToWalkthroughPayloadOptions,
	PrWalkthroughValidationError,
	PrWalkthroughValidationSummary,
	PrWalkthroughYamlAnchor,
	PrWalkthroughYamlDesignDecision,
	PrWalkthroughYamlDocument,
	PrWalkthroughYamlLaunchTarget,
	PrWalkthroughYamlOmission,
	PrWalkthroughYamlPr,
	PrWalkthroughYamlRelevantHunk,
	PrWalkthroughYamlReviewChunk,
	PrWalkthroughYamlValidationOptions,
	PrWalkthroughYamlValidationResult,
	PrWalkthroughYamlWalkthrough,
	WalkthroughParsedDiffForYamlMapping,
	WalkthroughSynthesisExport,
	WalkthroughSynthesisLimits,
	WalkthroughSynthesisResult,
} from "../../shared/pr-walkthrough/yaml-to-cards.js";

/**
 * Map a validated YAML document onto the server's `WalkthroughStorePayload`. The
 * shared synthesis returns the structurally-identical `WalkthroughSynthesisResult`;
 * the cast pins the server payload type at this boundary so the agent toolchain +
 * store keep their existing type without the shared module taking a server dep.
 */
export function mapYamlToWalkthroughPayload(
	document: PrWalkthroughYamlDocument,
	parsedDiff: WalkthroughParsedDiffForYamlMapping = {},
	options: MapYamlToWalkthroughPayloadOptions = {},
): WalkthroughStorePayload {
	return mapYamlToCards(document, parsedDiff, options) as WalkthroughStorePayload;
}
