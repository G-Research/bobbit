import type { ProjectConfigStore } from "./project-config-store.js";

/**
 * The container CLI binary used to run agent sandboxes. This is distinct from
 * the `sandbox` enable flag (`"none" | "docker"`): `sandbox: "docker"` means
 * "sandboxing is ON", while `RuntimeBin` selects which binary actually runs the
 * containers. Configured via the `sandbox_runtime` project-config key.
 */
export type RuntimeBin = "docker" | "podman";

/** Safe default — preserves today's behaviour when `sandbox_runtime` is unset. */
export const DEFAULT_RUNTIME_BIN: RuntimeBin = "docker";

/**
 * Single source of truth for which container CLI binary to spawn.
 * Unknown/empty/missing store → `"docker"` (never hard-fails on a typo).
 */
export function runtimeBin(
	store: Pick<ProjectConfigStore, "getSandboxRuntime"> | null | undefined,
): RuntimeBin {
	return store?.getSandboxRuntime() ?? DEFAULT_RUNTIME_BIN;
}
