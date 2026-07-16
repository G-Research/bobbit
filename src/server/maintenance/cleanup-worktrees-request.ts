import type {
	CleanupWorktreeInventoryRequest,
	CleanupWorktreeInventoryResponse,
} from "../agent/worktree-inventory.js";

type CleanupWorktreesValidation =
	| { ok: true; request: CleanupWorktreeInventoryRequest; legacyResponse: boolean }
	| { ok: false; error: string };

export type CleanupWorktreesRequestResult =
	| { status: 200; body: CleanupWorktreeInventoryResponse | { cleaned: number } }
	| { status: 400; body: { error: string } };

export interface CleanupWorktreesInventory {
	cleanup(request: CleanupWorktreeInventoryRequest): Promise<CleanupWorktreeInventoryResponse>;
}

function owns(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Validate the canonical and legacy cleanup-worktrees request shapes before any
 * inventory scan or cleanup can run.
 */
export function validateCleanupWorktreesRequest(body: unknown, hasRequestBody: boolean): CleanupWorktreesValidation {
	const isPlainObjectBody = body !== null && typeof body === "object" && !Array.isArray(body);
	if (isPlainObjectBody && owns(body, "mode")) {
		const record = body as Record<string, unknown>;
		const mode = record.mode;
		if (mode !== "all-safe" && mode !== "selected") {
			return { ok: false, error: "mode must be all-safe or selected" };
		}
		if (mode === "all-safe") {
			if (owns(body, "itemIds") || owns(body, "worktrees")) {
				return { ok: false, error: "mode=all-safe does not accept selectors" };
			}
			return { ok: true, request: { mode: "all-safe" }, legacyResponse: false };
		}
		if (!Array.isArray(record.itemIds) || record.itemIds.some(id => typeof id !== "string")) {
			return { ok: false, error: "itemIds must be an array of strings" };
		}
		return { ok: true, request: { mode: "selected", itemIds: record.itemIds as string[] }, legacyResponse: false };
	}
	if (isPlainObjectBody && owns(body, "itemIds")) {
		return { ok: false, error: "mode is required when itemIds is provided" };
	}
	if ((body === null && hasRequestBody) || (body !== null && !isPlainObjectBody)) {
		return { ok: false, error: "cleanup-worktrees body must be an object" };
	}
	const legacyBodyKeys = isPlainObjectBody ? Object.keys(body as Record<string, unknown>) : [];
	if (legacyBodyKeys.some(key => key !== "worktrees")) {
		return { ok: false, error: "legacy cleanup-worktrees body accepts worktrees only" };
	}
	const worktrees = isPlainObjectBody ? (body as Record<string, unknown>).worktrees : undefined;
	if (isPlainObjectBody && owns(body, "worktrees") && (!Array.isArray(worktrees) || worktrees.some(wt =>
		!wt || typeof wt !== "object" || Array.isArray(wt)
		|| typeof (wt as Record<string, unknown>).path !== "string"
		|| typeof (wt as Record<string, unknown>).branch !== "string"
		|| typeof (wt as Record<string, unknown>).repoPath !== "string"
	))) {
		return { ok: false, error: "worktrees must be an array of { path, branch, repoPath }" };
	}
	return {
		ok: true,
		request: {
			mode: "legacy-orphaned",
			worktrees: worktrees as Array<{ path: string; branch: string; repoPath: string }> | undefined,
		},
		legacyResponse: true,
	};
}

/** Execute validated cleanup while preserving the legacy `{ cleaned }` response. */
export async function executeCleanupWorktreesRequest(
	body: unknown,
	hasRequestBody: boolean,
	inventory: CleanupWorktreesInventory,
): Promise<CleanupWorktreesRequestResult> {
	const validation = validateCleanupWorktreesRequest(body, hasRequestBody);
	if (!validation.ok) return { status: 400, body: { error: validation.error } };
	const result = await inventory.cleanup(validation.request);
	return validation.legacyResponse
		? { status: 200, body: { cleaned: result.counts.cleaned } }
		: { status: 200, body: result };
}
