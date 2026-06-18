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

export function applyBudgets(
	blocks: ContextBlock[],
	perProviderMax: Map<string, number>,
	globalMax: number,
): { kept: ContextBlock[]; omitted: { block: ContextBlock; why: string }[] } {
	const kept: ContextBlock[] = [];
	const omitted: { block: ContextBlock; why: string }[] = [];
	const usedByProvider = new Map<string, number>();
	let globalUsed = 0;
	let truncationConsumed = false;

	const ordered = blocks
		.map((block, index) => ({ block, index }))
		.sort((a, b) => (b.block.priority - a.block.priority) || (a.index - b.index));

	for (const { block } of ordered) {
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
			kept.push(block);
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

		kept.push(truncated);
		globalUsed += truncated.tokenEstimate;
		usedByProvider.set(block.providerId, providerUsed + truncated.tokenEstimate);
	}

	return { kept, omitted };
}
