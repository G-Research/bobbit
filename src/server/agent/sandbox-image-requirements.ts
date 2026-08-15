import { createHash } from "node:crypto";
import { isValidSandboxRequirementId } from "./pack-manifest.js";

/** The small, core-owned vocabulary that can alter the sandbox image. */
export type SandboxToolchainId = "python";

export interface SandboxToolchainRecipe {
	readonly id: SandboxToolchainId;
}

/**
 * This is deliberately the only profile allowlist. Pack declarations can name
 * an id from this table, but cannot provide packages, commands, or build args.
 */
export const SANDBOX_TOOLCHAIN_RECIPES: Readonly<Record<SandboxToolchainId, SandboxToolchainRecipe>> = Object.freeze({
	python: Object.freeze({ id: "python" }),
});

export interface SandboxImageRequirement {
	readonly packId: string;
	readonly requirementId: string;
	readonly profiles: readonly SandboxToolchainId[];
}

export interface SandboxImagePlan {
	/** The validated project-configured image reference, unchanged for no-profile plans. */
	readonly baseImageName: string;
	/** The only image reference supplied to Docker by the core builder. */
	readonly imageName: string;
	readonly profiles: readonly SandboxToolchainId[];
	readonly fingerprint: string;
	/** Deterministically ordered, authorization-projected requirement metadata. */
	readonly requirements: readonly SandboxImageRequirement[];
}

export interface SandboxImagePlanInput {
	readonly baseImageName: string;
	readonly requirements: readonly SandboxImageRequirement[];
	readonly piAgentVersion: string | null;
}

export interface ParsedSandboxImageReference {
	/** Validated reference with no tag or digest. */
	readonly repository: string;
	/** Canonical reference used only as a fingerprint input. */
	readonly normalized: string;
}

export class UnsupportedSandboxImagePlanError extends Error {
	constructor(message = "Unsupported sandbox image plan") {
		super(message);
		this.name = "UnsupportedSandboxImagePlanError";
	}
}

const PLAN_FORMAT_VERSION = 1;
const RECIPE_SET_VERSION = 1;
const FINGERPRINT_LENGTH = 16;
/** Bounds the derived plan and every status projection from all active packs. */
export const MAX_SANDBOX_IMAGE_PLAN_REQUIREMENT_ROWS = 256;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const REPOSITORY_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG = /^[\w][\w.-]{0,127}$/;

/**
 * Accept a conventional Docker repository with an optional tag and/or exact
 * sha256 digest. This intentionally rejects whitespace, paths, URLs, shell
 * metacharacters, and uppercase repository components before Docker is called.
 */
export function parseSandboxBaseImageReference(value: string): ParsedSandboxImageReference | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.trim() !== value) return null;

	const digestIndex = value.indexOf("@");
	if (digestIndex !== -1 && value.indexOf("@", digestIndex + 1) !== -1) return null;
	const named = digestIndex === -1 ? value : value.slice(0, digestIndex);
	const digest = digestIndex === -1 ? undefined : value.slice(digestIndex + 1);
	if (!named || (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest))) return null;

	const slashSegments = named.split("/");
	if (slashSegments.some((segment) => !segment)) return null;
	let repositoryParts = slashSegments;
	const last = slashSegments.at(-1)!;
	const tagSeparator = last.lastIndexOf(":");
	let tag: string | undefined;
	if (tagSeparator !== -1) {
		tag = last.slice(tagSeparator + 1);
		if (!TAG.test(tag)) return null;
		repositoryParts = [...slashSegments.slice(0, -1), last.slice(0, tagSeparator)];
	}
	if (repositoryParts.length === 0) return null;

	// A colon is legal only in the first (registry) component, and only as a port.
	const first = repositoryParts[0]!;
	const colon = first.lastIndexOf(":");
	if (colon !== -1) {
		const host = first.slice(0, colon);
		const port = first.slice(colon + 1);
		if (!host || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) || !/^[0-9]{1,5}$/.test(port)) return null;
		repositoryParts = [`${host}:${port}`, ...repositoryParts.slice(1)];
	} else if (!REPOSITORY_COMPONENT.test(first)) {
		return null;
	}
	if (repositoryParts.slice(1).some((part) => !REPOSITORY_COMPONENT.test(part))) return null;

	const repository = repositoryParts.join("/");
	return { repository, normalized: `${repository}${tag ? `:${tag}` : ""}${digest ? `@${digest}` : ""}` };
}

function canonicalProfiles(requirements: readonly SandboxImageRequirement[]): SandboxToolchainId[] {
	const profiles = new Set<SandboxToolchainId>();
	for (const requirement of requirements) {
		if (!requirement || !Array.isArray(requirement.profiles)) {
			throw new UnsupportedSandboxImagePlanError();
		}
		const requirementProfiles = new Set<SandboxToolchainId>();
		for (const profile of requirement.profiles) {
			if (typeof profile !== "string" || !(profile in SANDBOX_TOOLCHAIN_RECIPES) || requirementProfiles.has(profile as SandboxToolchainId)) {
				throw new UnsupportedSandboxImagePlanError();
			}
			requirementProfiles.add(profile as SandboxToolchainId);
			profiles.add(profile as SandboxToolchainId);
		}
	}
	return [...profiles].sort();
}

function orderedRequirements(requirements: readonly SandboxImageRequirement[]): readonly SandboxImageRequirement[] {
	return requirements
		.map((requirement) => {
			if (!requirement || typeof requirement.packId !== "string" || !isValidSandboxRequirementId(requirement.requirementId)) {
				throw new UnsupportedSandboxImagePlanError();
			}
			return Object.freeze({
				packId: requirement.packId,
				requirementId: requirement.requirementId,
				profiles: Object.freeze([...new Set(requirement.profiles)].sort()) as readonly SandboxToolchainId[],
			});
		})
		.sort((a, b) => a.packId.localeCompare(b.packId) || a.requirementId.localeCompare(b.requirementId));
}

/** Resolve authorized profile ids into a canonical, core-derived Docker plan. */
export function resolveSandboxImagePlan(input: SandboxImagePlanInput): SandboxImagePlan {
	if (!Array.isArray(input.requirements) || input.requirements.length > MAX_SANDBOX_IMAGE_PLAN_REQUIREMENT_ROWS) {
		throw new UnsupportedSandboxImagePlanError();
	}
	const base = parseSandboxBaseImageReference(input.baseImageName);
	if (!base) throw new UnsupportedSandboxImagePlanError("Unsupported configured sandbox image");
	if (input.piAgentVersion !== null && (typeof input.piAgentVersion !== "string" || input.piAgentVersion.length > 128)) {
		throw new UnsupportedSandboxImagePlanError();
	}

	const profiles = canonicalProfiles(input.requirements);
	const requirements = orderedRequirements(input.requirements);
	const canonicalPayload = JSON.stringify({
		format: PLAN_FORMAT_VERSION,
		baseImage: base.normalized,
		profiles,
		recipeSet: RECIPE_SET_VERSION,
		piAgentVersion: input.piAgentVersion,
	});
	const fingerprint = createHash("sha256").update(canonicalPayload).digest("hex");
	const imageName = profiles.length === 0 ? input.baseImageName : `${base.repository}:bobbit-req-${fingerprint.slice(0, FINGERPRINT_LENGTH)}`;
	return Object.freeze({
		baseImageName: input.baseImageName,
		imageName,
		profiles: Object.freeze(profiles),
		fingerprint,
		requirements: Object.freeze(requirements),
	});
}

/** Fixed Docker arguments; no declaration-provided value crosses this boundary. */
export function sandboxImageBuildArgs(plan: SandboxImagePlan): readonly string[] {
	if (!SHA256_DIGEST.test(plan.fingerprint) || plan.profiles.some((profile) => !(profile in SANDBOX_TOOLCHAIN_RECIPES))) {
		throw new UnsupportedSandboxImagePlanError();
	}
	return Object.freeze([
		"--build-arg",
		`BOBBIT_SANDBOX_TOOLCHAINS=${plan.profiles.join(",")}`,
		"--build-arg",
		`BOBBIT_SANDBOX_REQUIREMENTS_FINGERPRINT=${plan.fingerprint}`,
	]);
}

export type SandboxRequirementState = "pending" | "available" | "failed" | "unsupported";

export interface SandboxRequirementStatusEntry {
	readonly packId: string;
	readonly requirementId: string;
	readonly state: SandboxRequirementState;
	readonly code?: string;
}

export interface SandboxRequirementsStatus {
	readonly fingerprint: string;
	readonly profiles: readonly SandboxToolchainId[];
	readonly entries: readonly SandboxRequirementStatusEntry[];
}

/** Project-local, bounded failures for the exact desired plan only. */
export class SandboxImageRequirementFailureStore {
	private readonly failures = new Map<string, { code: string; message: string }>();
	constructor(private readonly capacity = 64) {}

	private key(projectId: string, fingerprint: string): string {
		return `${projectId}\0${fingerprint}`;
	}

	recordFailure(projectId: string, fingerprint: string): void {
		const key = this.key(projectId, fingerprint);
		this.failures.delete(key);
		this.failures.set(key, { code: "build-failed", message: "Sandbox image build failed" });
		while (this.failures.size > this.capacity) this.failures.delete(this.failures.keys().next().value!);
	}

	recordBuildFailure(projectId: string, fingerprint: string): void {
		this.recordFailure(projectId, fingerprint);
	}

	recordSuccess(projectId: string, fingerprint: string): void {
		this.failures.delete(this.key(projectId, fingerprint));
	}

	recordBuildSuccess(projectId: string, fingerprint: string): void {
		this.recordSuccess(projectId, fingerprint);
	}

	getFailure(projectId: string, fingerprint: string): { readonly code: string; readonly message: string } | undefined {
		const key = this.key(projectId, fingerprint);
		const failure = this.failures.get(key);
		if (!failure) return undefined;
		this.failures.delete(key);
		this.failures.set(key, failure);
		return failure;
	}

	getBuildFailure(projectId: string, fingerprint: string): { readonly code: string; readonly message: string } | undefined {
		return this.getFailure(projectId, fingerprint);
	}

	invalidateProject(projectId: string): void {
		for (const key of this.failures.keys()) if (key.startsWith(`${projectId}\0`)) this.failures.delete(key);
	}
}

/** Shared only by the server process; failure state is never persisted or cross-project. */
export const sandboxImageRequirements = new SandboxImageRequirementFailureStore();

/** Status helper intentionally exposes only a stable code, never Docker output. */
export function sandboxRequirementsStatus(plan: SandboxImagePlan, state: SandboxRequirementState, code?: string): SandboxRequirementsStatus {
	return Object.freeze({
		fingerprint: plan.fingerprint,
		profiles: plan.profiles,
		entries: Object.freeze(plan.requirements.map((requirement) => Object.freeze({
			packId: requirement.packId,
			requirementId: requirement.requirementId,
			state,
			...(code ? { code } : {}),
		}))),
	});
}
