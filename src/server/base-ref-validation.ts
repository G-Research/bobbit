export interface BaseRefValidationInput {
	value: unknown;
	sandbox: string;
}

export interface BaseRefValidationError {
	field: "base_ref";
	error: string;
}

export interface BaseRefMissingDetailsError extends BaseRefValidationError {
	details: Array<{ component: string; message: string }>;
}

export const KNOWN_NON_ORIGIN_BASE_REF_REMOTES = new Set([
	"upstream",
	"fork",
	"mirror",
	"github",
	"gitlab",
	"bitbucket",
	"remote",
]);

export function normalizeBaseRefValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

// Mirrors git's `check-ref-format` predicate closely enough for API validation
// without an exec round-trip. See docs/design/base-ref.md.
export function isValidBaseRefBranchGrammar(name: string): boolean {
	if (!name) return false;
	if (/\s/.test(name)) return false;
	if (name.startsWith("-") || name.endsWith(".")) return false;
	if (name.includes("..") || name.includes("@{")) return false;
	if (/[\x00-\x1f\x7f~^:?*\[\\]/.test(name)) return false;
	return /^[A-Za-z0-9_./-]+$/.test(name);
}

export function baseRefCommitShaError(value: string): BaseRefValidationError {
	return { field: "base_ref", error: `base_ref must be a branch ref, not a commit SHA. Got: ${value}` };
}

export function baseRefBranchGrammarError(value: string): BaseRefValidationError {
	return { field: "base_ref", error: `base_ref must be a valid branch name. Got: ${value}` };
}

export function baseRefNonOriginRemoteError(value: string): BaseRefValidationError {
	return {
		field: "base_ref",
		error: `base_ref only supports the 'origin' remote today. Got: ${value}. If you need a different primary remote, configure it as 'origin' in your local clone.`,
	};
}

export function baseRefSandboxLocalError(value: string): BaseRefValidationError {
	return {
		field: "base_ref",
		error: `base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: ${value}`,
	};
}

export function baseRefTagError(value: string): BaseRefValidationError {
	return {
		field: "base_ref",
		error: `base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: ${value}`,
	};
}

export function baseRefMissingInReposError(
	value: string,
	failures: Array<{ component: string; message: string }>,
	checkedRepoCount: number,
): BaseRefMissingDetailsError {
	return {
		field: "base_ref",
		error: `base_ref '${value}' is not present in ${failures.length} of ${checkedRepoCount} component repos`,
		details: failures,
	};
}

export function baseRefSkippedRepoWarning(componentName: string, repoPath: string): string {
	return `base_ref validation skipped for component '${componentName}': not a git repo at ${repoPath}`;
}

export function validateBaseRefShape(input: BaseRefValidationInput): BaseRefValidationError | null {
	const baseRefValue = normalizeBaseRefValue(input.value);
	if (!baseRefValue) return null;

	// Reject before grammar — a 40-char hex string is grammatically valid but is
	// rejected for clarity.
	if (/^[0-9a-f]{7,40}$/i.test(baseRefValue)) {
		return baseRefCommitShaError(baseRefValue);
	}

	if (!isValidBaseRefBranchGrammar(baseRefValue)) {
		return baseRefBranchGrammarError(baseRefValue);
	}

	const firstSegment = baseRefValue.split("/")[0];
	if (baseRefValue.includes("/") && firstSegment !== "origin" && KNOWN_NON_ORIGIN_BASE_REF_REMOTES.has(firstSegment)) {
		return baseRefNonOriginRemoteError(baseRefValue);
	}

	if (input.sandbox === "docker" && !baseRefValue.startsWith("origin/")) {
		return baseRefSandboxLocalError(baseRefValue);
	}

	return null;
}
