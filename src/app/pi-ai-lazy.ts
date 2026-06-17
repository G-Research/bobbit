/**
 * Lazy loader for `@earendil-works/pi-ai`.
 *
 * The pi-ai index re-exports `./models.js`, which has a top-level side effect
 * that materialises a 553 kB generated model catalog (`models.generated.js`).
 * Any static value import from the bare specifier drags it into whichever
 * chunk imports it — including the entry chunk.
 *
 * Importing pi-ai through this helper instead keeps the catalog out of the
 * eager entry graph: Vite emits the pi-ai module + catalog into its own
 * lazy chunk, fetched on demand when an actual value (e.g. `streamSimple`,
 * `getModel`) is needed.
 *
 * Type-only imports (`import type { ... } from "@earendil-works/pi-ai"`)
 * are erased by `tsc` and never reach Vite — they remain free.
 *
 * See `docs/design/shrink-initial-bundle.md` (Task A) for the full design.
 */

import type { Context, Model } from "@earendil-works/pi-ai";

let _pi: Promise<typeof import("@earendil-works/pi-ai")> | null = null;

export function loadPiAi(): Promise<typeof import("@earendil-works/pi-ai")> {
	return (_pi ??= import("@earendil-works/pi-ai"));
}

export async function getPiAiProviders(): Promise<string[]> {
	const { getProviders } = await loadPiAi();
	return [...getProviders()];
}

export async function getPiAiModel(provider: string, modelId: string): Promise<Model<any> | undefined> {
	const { getModel } = await loadPiAi();
	return getModel(provider as any, modelId) as Model<any> | undefined;
}

export async function completePiAi(model: Model<any>, context: Context, options?: unknown): Promise<any> {
	const { complete } = await loadPiAi();
	return complete(model as any, context, options as any);
}
