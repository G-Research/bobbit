import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Convert an authoritative project ID into an opaque, filesystem-safe checkout
 * namespace. Never use a project ID itself as a checkout path component.
 */
export function verificationCheckoutProjectScope(projectId: string): string | undefined {
	if (typeof projectId !== "string" || !projectId || projectId.trim() !== projectId) return undefined;
	return `project-${createHash("sha256").update(projectId, "utf8").digest("hex")}`;
}

export function verificationCheckoutProjectDir(checkoutRoot: string, projectId: string): string | undefined {
	const scope = verificationCheckoutProjectScope(projectId);
	return scope ? path.join(checkoutRoot, scope) : undefined;
}

/** A repository coordinate is data, never an absolute filesystem path. */
export function verificationRepositoryKey(value: unknown): string | undefined {
	if (value === ".") return ".";
	if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\\") || value.includes("\0")
		|| path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return undefined;
	const normalized = path.posix.normalize(value);
	if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")
		|| value.split("/").some(segment => !segment || segment === "." || segment === "..")) return undefined;
	return normalized;
}

/** Normalized relative suffix accepted beneath one persisted repository root. */
export function verificationRepositoryRelativePath(value: unknown): string | undefined {
	if (value === undefined || value === "" || value === ".") return ".";
	return verificationRepositoryKey(value);
}

/** Deterministic, manager-owned child name for a private per-repository tree. */
export function verificationCheckoutRepositoryScope(repoKey: string): string | undefined {
	const key = verificationRepositoryKey(repoKey);
	if (!key) return undefined;
	return `repo-${createHash("sha256").update(key, "utf8").digest("hex")}`;
}
