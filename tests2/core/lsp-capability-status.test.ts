import { describe, expect, it } from "vitest";
import { languageForId } from "../../market-packs/code-intelligence/lib/language-matrix.ts";
import {
	deriveLanguageCapabilityStatus,
	type CapabilityRuntime,
	type CapabilityStatusOptions,
	type LspServiceInstanceKey,
	type LspServiceReadinessSnapshot,
	type ToolchainProbeFact,
} from "../../market-packs/code-intelligence/lib/capability-status.ts";
import type { LanguageDetection } from "../../market-packs/code-intelligence/lib/language-detection.ts";

const typescriptDetection = {
	component: "frontend",
	languageId: "typescript",
	structuralSearch: "available",
	evidence: { fileCount: 1, matchedGlobs: ["**/*.ts"], rootMarkers: ["tsconfig.json"] },
	lsp: "disabled",
	missing: [],
} satisfies LanguageDetection;

const structuralOnlyDetection = {
	...typescriptDetection,
	languageId: "bash",
	evidence: { fileCount: 1, matchedGlobs: ["**/*.sh"], rootMarkers: [] },
	lsp: "unsupported",
} satisfies LanguageDetection;

const serviceKey: LspServiceInstanceKey = {
	projectId: "project-1",
	component: "frontend",
	worktreePath: "/linked-worktrees/project-1/frontend",
	languageId: "typescript",
};

const readySnapshot: LspServiceReadinessSnapshot = {
	key: serviceKey,
	state: "ready",
	serverId: "typescript-language-server",
	serverVersion: "4.3.0",
	versionCompatible: true,
};

function compatibleProbeFacts(runtime: CapabilityRuntime): readonly ToolchainProbeFact[] {
	const language = languageForId("typescript");
	if (!language?.lsp) throw new Error("TypeScript LSP declaration is required for this test.");
	return language.lsp[runtime].map((requirement) => ({
		id: requirement.id,
		reportedVersion: requirement.version ? "test-compatible-version" : undefined,
		compatible: true,
	}));
}

function options(runtime: CapabilityRuntime, overrides: Partial<CapabilityStatusOptions> = {}): CapabilityStatusOptions {
	return {
		enabledLanguageIds: ["typescript"],
		runtime,
		toolchainProbeFacts: { [runtime]: compatibleProbeFacts(runtime) },
		serviceKey,
		serviceSnapshot: readySnapshot,
		...overrides,
	};
}

describe("LSP capability status", () => {
	it("reports structural-search-only languages as unsupported without implying LSP", () => {
		const status = deriveLanguageCapabilityStatus(structuralOnlyDetection, options("host"));

		expect(status).toMatchObject({ component: "frontend", languageId: "bash", structuralSearch: "available" });
		expect(status.lsp).toEqual({
			state: "unsupported",
			actions: [],
			requirements: [],
			missing: [],
			reason: "Bash declares structural search only; no LSP server is available.",
		});
	});

	it("requires explicit enablement before evaluating toolchains or service readiness", () => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options("host", {
			enabledLanguageIds: [],
			toolchainProbeFacts: { host: [] },
			serviceSnapshot: { ...readySnapshot, state: "failed" },
		}));

		expect(status.lsp).toMatchObject({
			state: "disabled",
			missing: [],
			reason: "TypeScript LSP is disabled. Enable it explicitly before starting typescript-language-server.",
		});
		expect(status.lsp.requirements.map((requirement) => requirement.id)).toEqual(["node", "typescript-language-server", "typescript"]);
	});

	it.each(["host", "sandbox"] as const)("reports each missing %s toolchain requirement", (runtime) => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options(runtime, { toolchainProbeFacts: { [runtime]: [] } }));
		const language = languageForId("typescript");
		if (!language?.lsp) throw new Error("TypeScript LSP declaration is required for this test.");

		expect(status.lsp.state).toBe("requires-toolchain");
		expect(status.lsp.requirements).toEqual(language.lsp[runtime]);
		expect(status.lsp.missing).toEqual(language.lsp[runtime]);
		expect(status.lsp.reason).toBe(language.lsp[runtime].map((requirement) => requirement.installHint).join(" "));
	});

	it.each(["host", "sandbox"] as const)("rejects %s probe facts whose IDs do not exactly match", (runtime) => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options(runtime, {
			toolchainProbeFacts: {
				[runtime]: compatibleProbeFacts(runtime).map((fact) => ({ ...fact, id: `${fact.id}-other` })),
			},
		}));

		expect(status.lsp).toMatchObject({ state: "requires-toolchain" });
		expect(status.lsp.missing).toEqual(status.lsp.requirements);
	});

	it.each(["host", "sandbox"] as const)("requires reported version evidence for constrained %s requirements", (runtime) => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options(runtime, {
			toolchainProbeFacts: {
				[runtime]: compatibleProbeFacts(runtime).map((fact) => ({ ...fact, reportedVersion: undefined })),
			},
		}));

		expect(status.lsp).toMatchObject({ state: "requires-toolchain" });
		expect(status.lsp.missing).toEqual(status.lsp.requirements);
		expect(status.lsp.reason).toContain("has no reported version evidence");
	});

	it.each(["host", "sandbox"] as const)("requires compatible %s probe facts before checking the service", (runtime) => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options(runtime, {
			toolchainProbeFacts: {
				[runtime]: compatibleProbeFacts(runtime).map((fact) => ({ ...fact, compatible: false })),
			},
			serviceSnapshot: { ...readySnapshot, state: "failed" },
		}));

		expect(status.lsp).toMatchObject({ state: "requires-toolchain" });
		expect(status.lsp.reason).toContain("is not compatible with");
	});

	it("does not use host probe facts to establish sandbox readiness", () => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options("sandbox", {
			toolchainProbeFacts: { host: compatibleProbeFacts("host") },
		}));

		expect(status.lsp).toMatchObject({ state: "requires-toolchain" });
		expect(status.lsp.missing).toEqual(status.lsp.requirements);
	});

	it.each([
		["starting", "The managed LSP service is starting for this linked-worktree component."],
		["failed", "The managed LSP service failed for this linked-worktree component."],
		["stopped", "The managed LSP service is stopped for this linked-worktree component."],
	] as const)("reports an exact unavailable reason when the service is %s", (state, reason) => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options("host", {
			serviceSnapshot: { ...readySnapshot, state },
		}));

		expect(status.lsp).toMatchObject({ state: "unavailable", missing: [], reason });
	});

	it.each([
		["project", { ...serviceKey, projectId: "another-project" }],
		["component", { ...serviceKey, component: "backend" }],
		["worktree", { ...serviceKey, worktreePath: "/linked-worktrees/project-1/other" }],
		["language", { ...serviceKey, languageId: "javascript" }],
	] as const)("rejects a ready snapshot bound to another %s identity", (_part, key) => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options("host", {
			serviceSnapshot: { ...readySnapshot, key },
		}));

		expect(status.lsp).toMatchObject({
			state: "unavailable",
			reason: "The managed LSP service snapshot is not bound to this exact project, component, worktree, and language.",
		});
	});

	it("rejects a ready service that the platform marks version-incompatible", () => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options("host", {
			serviceSnapshot: { ...readySnapshot, serverVersion: "4.2.0", versionCompatible: false },
		}));

		expect(status.lsp).toMatchObject({
			state: "unavailable",
			reason: "The managed LSP service is not version-compatible with this language declaration.",
		});
	});

	it.each(["host", "sandbox"] as const)("never reports ready from an empty %s requirement declaration", (runtime) => {
		const language = languageForId("typescript");
		if (!language?.lsp) throw new Error("TypeScript LSP declaration is required for this test.");
		if (runtime === "host") {
			const originalRequirements = language.lsp.host;
			language.lsp.host = [];
			try {
				assertEmptyRequirementsAreUnavailable(runtime);
			} finally {
				language.lsp.host = originalRequirements;
			}
			return;
		}
		const originalRequirements = language.lsp.sandbox;
		language.lsp.sandbox = [];
		try {
			assertEmptyRequirementsAreUnavailable(runtime);
		} finally {
			language.lsp.sandbox = originalRequirements;
		}
	});

	function assertEmptyRequirementsAreUnavailable(runtime: CapabilityRuntime): void {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options(runtime, { toolchainProbeFacts: { [runtime]: [] } }));
		expect(status.lsp).toMatchObject({
			state: "unavailable",
			requirements: [],
			missing: [],
			reason: `The ${runtime} LSP declaration has no named toolchain requirements; typescript-language-server cannot be considered ready.`,
		});
	}

	it.each(["host", "sandbox"] as const)("reports ready only with all compatible %s probe facts and an exact compatible service", (runtime) => {
		const status = deriveLanguageCapabilityStatus(typescriptDetection, options(runtime));

		expect(status.lsp).toMatchObject({
			state: "ready",
			missing: [],
			reason: "typescript-language-server is ready for this linked-worktree component.",
		});
	});
});
