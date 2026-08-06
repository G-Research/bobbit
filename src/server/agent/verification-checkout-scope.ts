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
