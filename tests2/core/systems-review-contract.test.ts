// v2-native — Systems Interaction Review prompt/registry contract coverage.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	SYSTEMS_INTERACTION_REVIEW_CONTRACTS,
	SYSTEMS_INTERACTION_REVIEW_PROMPT,
	SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
	SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256,
	resolveSystemsInteractionReviewContract,
} from "../../src/server/agent/systems-interaction-review-contract.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CONTRACT_FILE = path.join(ROOT, "src", "server", "agent", "systems-interaction-review-contract.ts");

function authoredFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const out: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) out.push(...authoredFiles(full));
		else if (/\.(?:ts|ya?ml)$/.test(entry.name)) out.push(full);
	}
	return out;
}

describe("Systems Interaction Review shared prompt contract", () => {
	it("publishes an immutable v1 registry entry with a reproducible digest", () => {
		expect(SYSTEMS_INTERACTION_REVIEW_PROMPT_ID).toBe("bobbit:systems-interaction-review/v1");
		expect(SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256).toMatch(/^[a-f0-9]{64}$/);
		expect(SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256).toBe(
			createHash("sha256").update(SYSTEMS_INTERACTION_REVIEW_PROMPT, "utf8").digest("hex"),
		);

		const resolved = resolveSystemsInteractionReviewContract(SYSTEMS_INTERACTION_REVIEW_PROMPT_ID);
		expect(resolved).toBe(SYSTEMS_INTERACTION_REVIEW_CONTRACTS[SYSTEMS_INTERACTION_REVIEW_PROMPT_ID]);
		expect(resolved).toEqual({
			prompt: SYSTEMS_INTERACTION_REVIEW_PROMPT,
			sha256: SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256,
		});
		expect(Object.isFrozen(SYSTEMS_INTERACTION_REVIEW_CONTRACTS)).toBe(true);
		expect(Object.isFrozen(resolved)).toBe(true);
	});

	it("fails closed for unknown versions and cannot mutate the published v1 entry", () => {
		expect(() => resolveSystemsInteractionReviewContract("bobbit:systems-interaction-review/v2"))
			.toThrow(/Unknown Systems Interaction Review prompt contract/);
		expect(() => {
			(resolvedContract() as { prompt: string }).prompt = "changed";
		}).toThrow();
		expect(resolveSystemsInteractionReviewContract(SYSTEMS_INTERACTION_REVIEW_PROMPT_ID).prompt)
			.toBe(SYSTEMS_INTERACTION_REVIEW_PROMPT);
	});

	it("has one authored prompt body rather than workflow-local copies", () => {
		const marker = "For every behavior spanning multiple modules or layers, build and verify these traces";
		const files = [
			...authoredFiles(path.join(ROOT, "src")),
			...authoredFiles(path.join(ROOT, "defaults")),
			...authoredFiles(path.join(ROOT, "workflows")),
			...authoredFiles(path.join(ROOT, ".bobbit", "config")),
		];
		const occurrences = files.flatMap((file) => {
			const text = fs.readFileSync(file, "utf8");
			return text.includes(marker) ? [path.relative(ROOT, file).replaceAll("\\", "/")] : [];
		});
		expect(occurrences).toEqual([path.relative(ROOT, CONTRACT_FILE).replaceAll("\\", "/")]);
	});

	it("requires the complete state trace and conservative mixed-state synthesis", () => {
		const prompt = SYSTEMS_INTERACTION_REVIEW_PROMPT;
		for (const layer of [
			"producer",
			"aggregation/normalization",
			"API/transport",
			"persistence/cache",
			"UI consumer",
		]) expect(prompt).toContain(layer);
		for (const state of ["empty", "complete", "partial", "failed", "stale", "mixed-success"])
			expect(prompt).toMatch(new RegExp(`\\b${state}\\b`, "i"));
		expect(prompt).toMatch(/positive summary booleans[\s\S]*required data is complete[\s\S]*all relevant members agree/i);
		expect(prompt).toMatch(/missing, failed, stale, partial, or disagreeing members[\s\S]*not[\s\S]*authoritative positive/i);
	});

	it("requires end-to-end action identity and exact final-mutator test evidence", () => {
		const prompt = SYSTEMS_INTERACTION_REVIEW_PROMPT;
		for (const layer of ["visible control", "event payload", "route/handler", "resolved target", "final side effect"])
			expect(prompt).toContain(layer);
		expect(prompt).toMatch(/last production-owned adapter immediately before the actual mutation or remote effect/i);
		expect(prompt).toMatch(/successful registered integration or browser test[\s\S]*exact target and scope[\s\S]*final mutator/i);
		expect(prompt).toMatch(/Route-only or unit-only assertions[\s\S]*do not prove the target/i);
		expect(prompt).toMatch(/queue[\s\S]*retry[\s\S]*process[\s\S]*client boundary/i);
	});

	it("requires exhaustive medium-severity escalation without speculative failures", () => {
		const prompt = SYSTEMS_INTERACTION_REVIEW_PROMPT;
		expect(prompt).toMatch(/Do not stop after the first finding/i);
		expect(prompt).toMatch(/every reproducible medium-or-higher cross-layer correctness defect/i);
		for (const category of [
			"wrong-target",
			"hidden-or-misstated-work",
			"incomplete-authoritative",
			"untested-destructive-aggregate-target",
		]) expect(prompt).toContain(category);
		expect(prompt).toMatch(/medium-or-higher wrong-target, hidden-or-misstated-work, or incomplete-authoritative bug blocks/i);
		expect(prompt).toMatch(/Do not fail for style preferences, speculative architecture concerns, or a test gap without a concrete behavior or invariant at risk/i);
	});

	it("requires gap-free checkpoints and reserves the verdict/report for the server", () => {
		const prompt = SYSTEMS_INTERACTION_REVIEW_PROMPT;
		expect(prompt).toMatch(/Process all assigned chunks in order/i);
		expect(prompt).toMatch(/checkpoint can never pass/i);
		expect(prompt).toMatch(/final only after coverage is gap-free/i);
		expect(prompt).toMatch(/server determines the verdict and renders the only final verification report/i);
		expect(prompt).toMatch(/Do not provide a generic prose verdict/i);
	});
});

function resolvedContract() {
	return resolveSystemsInteractionReviewContract(SYSTEMS_INTERACTION_REVIEW_PROMPT_ID);
}
