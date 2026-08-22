/**
 * Agent-realm binding for project-scoped extension pack local data.
 *
 * The server-owned resolver derives project and pack identity. Agent/session
 * callers only select the execution realm; cwd/worktree paths are deliberately
 * absent from this contract.
 */
export const BOBBIT_PACK_LOCAL_DATA_ENV = "BOBBIT_PACK_LOCAL_DATA_JSON";

export type PackLocalDataRealm = "host" | "sandbox";
export type PackLocalDataBindings = Readonly<Record<string, string>>;

export interface PackLocalDataBindingScope {
	projectId: string;
	realm: PackLocalDataRealm;
}

export type PackLocalDataBindingsResolver = (
	scope: PackLocalDataBindingScope,
) => PackLocalDataBindings | undefined;

/**
 * Resolve and deterministically serialize the exact pack-id-to-directory map.
 * Empty maps omit the environment capability entirely.
 */
export function resolvePackLocalDataEnvironment(
	resolver: PackLocalDataBindingsResolver | null | undefined,
	projectId: string | undefined,
	sandboxed: boolean,
): Record<string, string> {
	if (!resolver || !projectId) return {};
	const bindings = resolver({ projectId, realm: sandboxed ? "sandbox" : "host" });
	if (!bindings) return {};

	const entries = Object.entries(bindings).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
	if (entries.length === 0) return {};
	for (const [packId, directory] of entries) {
		if (!packId || typeof directory !== "string" || directory.length === 0) {
			throw new Error("Pack local-data resolver returned an invalid runtime binding");
		}
	}
	return {
		[BOBBIT_PACK_LOCAL_DATA_ENV]: JSON.stringify(Object.fromEntries(entries)),
	};
}
