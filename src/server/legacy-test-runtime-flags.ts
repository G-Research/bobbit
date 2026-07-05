export interface LegacyTestRuntimeFlags {
	skipRemotePush: boolean;
	skipNonLocalRemoteGit: boolean;
	skipMcp: boolean;
	skipWorktreePool: boolean;
	skipTitleGeneration: boolean;
}

export type LegacyTestRuntimeFlagOverrides = Partial<LegacyTestRuntimeFlags>;

export function resolveLegacyTestRuntimeFlags(env: NodeJS.ProcessEnv = process.env): LegacyTestRuntimeFlags {
	return {
		skipRemotePush: env.BOBBIT_TEST_NO_PUSH === "1",
		skipNonLocalRemoteGit: env.BOBBIT_TEST_NO_REMOTE === "1" || env.BOBBIT_TEST_NO_EXTERNAL === "1",
		skipMcp: !!env.BOBBIT_SKIP_MCP,
		skipWorktreePool: !!env.BOBBIT_SKIP_WORKTREE_POOL,
		skipTitleGeneration: !!env.BOBBIT_SKIP_TITLE_GEN,
	};
}

let configuredOverrides: LegacyTestRuntimeFlagOverrides | undefined;

export function configureLegacyTestRuntimeFlags(overrides: LegacyTestRuntimeFlagOverrides | undefined): LegacyTestRuntimeFlagOverrides | undefined {
	const previous = configuredOverrides;
	configuredOverrides = overrides;
	return previous;
}

export function getLegacyTestRuntimeFlags(): LegacyTestRuntimeFlags {
	const flags = resolveLegacyTestRuntimeFlags();
	if (!configuredOverrides) return flags;
	for (const key of Object.keys(configuredOverrides) as Array<keyof LegacyTestRuntimeFlags>) {
		const value = configuredOverrides[key];
		if (value !== undefined) flags[key] = value;
	}
	return flags;
}
