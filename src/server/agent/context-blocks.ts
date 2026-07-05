export type ContextBlockAuthority = "memory" | "skill" | "tool" | "workflow" | "role" | "generic";

export interface ContextBlock {
	id: string;
	title: string;
	providerId: string;
	authority: ContextBlockAuthority;
	content: string;
	reason: string;
	priority: number;
	tokenEstimate: number;
}

export function estimateTokens(s: string): number {
	return Math.ceil(s.length / 4);
}

function attr(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/"/g, "&quot;");
}

export function fenceBlock(b: ContextBlock): string {
	return `<context-block id="${attr(b.id)}" source="${attr(b.title)}" authority="${attr(b.authority)}" reason="${attr(b.reason)}">\n${b.content}\n</context-block>`;
}

/**
 * EXT-06 (fair-share floor): with a SINGLE global priority queue, one greedy
 * high-priority pack's oversized demand can push every lower-priority pack's
 * blocks — even a single small one that would trivially fit in whatever
 * headroom the greedy pack leaves behind — into `omitted` via the
 * "stop entirely after the first truncation" rule below. See
 * FINDINGS.md EXT-06 and docs/design/context-budget-fair-share.md.
 *
 * Fix: a two-phase allocation.
 *   Phase 1 (guarantee): each CONTRIBUTING pack (a distinct `providerId` among
 *   `blocks`) is reserved up to `floor(globalMax / N)` of the shared budget —
 *   spent on WHOLE blocks from that pack's OWN priority order only. A block
 *   too big for the guarantee is deferred to phase 2 rather than truncated
 *   here, so it gets a shot at the pack's full (non-fair-share-capped) budget
 *   instead of being sliced down to a possibly-useless fair-share-sized sliver.
 *   Phase 2 (leftover): whatever of the global budget phase 1 left unspent
 *   (packs that asked for less than their share) is handed out by GLOBAL
 *   priority order across everything phase 1 deferred — this is the
 *   pre-existing greedy/truncate-then-stop policy, just running on the
 *   remainder instead of the whole budget.
 * The final `kept` order is re-sorted by (priority desc, original index asc)
 * regardless of which phase picked a block, so callers see the same
 * priority-ordered contract as before — the two-phase allocation is purely
 * internal bookkeeping.
 *
 * A single contributing pack (N=1) degrades to `fairShare === globalMax`,
 * i.e. byte-identical to the pre-fix single-phase algorithm.
 */
export function applyBudgets(
	blocks: ContextBlock[],
	perProviderMax: Map<string, number>,
	globalMax: number,
): { kept: ContextBlock[]; omitted: { block: ContextBlock; why: string }[] } {
	type Item = { block: ContextBlock; index: number };
	const indexed: Item[] = blocks.map((block, index) => ({ block, index }));
	const keptIndexed: Item[] = [];
	const omitted: { block: ContextBlock; why: string }[] = [];
	const usedByProvider = new Map<string, number>();
	let globalUsed = 0;

	// Distinct provider ids in first-appearance order — deterministic and
	// independent of Set/Map iteration quirks across engines.
	const providerOrder: string[] = [];
	const seenProviders = new Set<string>();
	for (const { block } of indexed) {
		if (!seenProviders.has(block.providerId)) {
			seenProviders.add(block.providerId);
			providerOrder.push(block.providerId);
		}
	}
	const n = providerOrder.length;
	const fairShare = n > 0 ? Math.floor(globalMax / n) : globalMax;
	const deferred = new Set<Item>(indexed);

	// Phase 1 — guarantee pass.
	for (const providerId of providerOrder) {
		const ownItems = indexed
			.filter(({ block }) => block.providerId === providerId)
			.sort((a, b) => (b.block.priority - a.block.priority) || (a.index - b.index));
		const providerMax = perProviderMax.get(providerId) ?? globalMax;
		const guaranteeCap = Math.min(fairShare, providerMax);
		let providerUsed = 0;

		for (const item of ownItems) {
			const globalHeadroom = Math.max(0, globalMax - globalUsed);
			const guaranteeHeadroom = Math.max(0, guaranteeCap - providerUsed);
			const headroom = Math.min(globalHeadroom, guaranteeHeadroom);
			if (item.block.tokenEstimate <= 0 || item.block.tokenEstimate > headroom) continue; // deferred to phase 2

			keptIndexed.push(item);
			deferred.delete(item);
			globalUsed += item.block.tokenEstimate;
			providerUsed += item.block.tokenEstimate;
		}
		usedByProvider.set(providerId, providerUsed);
	}

	// Phase 2 — leftover pass: the pre-existing greedy/truncate-then-stop policy,
	// running on whatever phase 1 didn't claim.
	const remaining = [...deferred].sort((a, b) => (b.block.priority - a.block.priority) || (a.index - b.index));
	let truncationConsumed = false;
	for (const item of remaining) {
		const { block } = item;
		if (truncationConsumed) {
			omitted.push({ block, why: "after-truncation" });
			continue;
		}

		const providerUsed = usedByProvider.get(block.providerId) ?? 0;
		const providerMax = perProviderMax.get(block.providerId) ?? globalMax;
		const globalHeadroom = Math.max(0, globalMax - globalUsed);
		const providerHeadroom = Math.max(0, providerMax - providerUsed);
		const headroom = Math.min(globalHeadroom, providerHeadroom);

		if (block.tokenEstimate <= headroom) {
			keptIndexed.push(item);
			globalUsed += block.tokenEstimate;
			usedByProvider.set(block.providerId, providerUsed + block.tokenEstimate);
			continue;
		}

		truncationConsumed = true;
		if (headroom < 32) {
			omitted.push({ block, why: "truncated-below-min" });
			continue;
		}

		const suffix = "…[truncated]";
		const keepChars = headroom * 4 - suffix.length;
		if (keepChars <= 0) {
			omitted.push({ block, why: "below-min" });
			continue;
		}

		const truncated: ContextBlock = {
			...block,
			content: block.content.slice(0, keepChars) + suffix,
		};
		truncated.tokenEstimate = estimateTokens(truncated.content);
		if (truncated.tokenEstimate < 32) {
			omitted.push({ block, why: "truncated-below-min" });
			continue;
		}

		keptIndexed.push({ block: truncated, index: item.index });
		globalUsed += truncated.tokenEstimate;
		usedByProvider.set(block.providerId, providerUsed + truncated.tokenEstimate);
	}

	// Callers depend on priority-ordered output (rendering, tests) — not on the
	// two-phase allocation's internal bookkeeping order.
	keptIndexed.sort((a, b) => (b.block.priority - a.block.priority) || (a.index - b.index));
	return { kept: keptIndexed.map((i) => i.block), omitted };
}
