export interface LegacyTestRuntimeFlags {
	skipRemotePush: boolean;
	skipNonLocalRemoteGit: boolean;
	skipMcp: boolean;
	skipWorktreePool: boolean;
	skipTitleGeneration: boolean;
	skipAigwDiscovery: boolean;
	skipLlmReview: boolean;
	testNoExternal: boolean;
	e2e: boolean;
	skipNpmCi: boolean;
	testRecordSetup?: string;
	e2eTmpRoot?: string;
	testPreparingDelayMs?: string;
	e2eProfile: boolean;
	e2eProfileFlushMs?: string;
}

export type LegacyTestRuntimeFlagOverrides = Partial<LegacyTestRuntimeFlags>;

function resolveLegacyTestRuntimeFlagsFromProcessEnv(): LegacyTestRuntimeFlags {
	return {
		skipRemotePush: process.env.BOBBIT_TEST_NO_PUSH === "1",
		skipNonLocalRemoteGit: process.env.BOBBIT_TEST_NO_REMOTE === "1" || process.env.BOBBIT_TEST_NO_EXTERNAL === "1",
		skipMcp: !!process.env.BOBBIT_SKIP_MCP,
		skipWorktreePool: !!process.env.BOBBIT_SKIP_WORKTREE_POOL,
		skipTitleGeneration: !!process.env.BOBBIT_SKIP_TITLE_GEN,
		skipAigwDiscovery: !!process.env.BOBBIT_SKIP_AIGW_DISCOVERY,
		skipLlmReview: !!process.env.BOBBIT_LLM_REVIEW_SKIP,
		testNoExternal: process.env.BOBBIT_TEST_NO_EXTERNAL === "1",
		e2e: process.env.BOBBIT_E2E === "1",
		skipNpmCi: !!process.env.BOBBIT_SKIP_NPM_CI,
		testRecordSetup: process.env.BOBBIT_TEST_RECORD_SETUP,
		e2eTmpRoot: process.env.BOBBIT_E2E_TMP_ROOT,
		testPreparingDelayMs: process.env.BOBBIT_TEST_PREPARING_DELAY_MS,
		e2eProfile: process.env.BOBBIT_E2E_PROFILE === "1",
		e2eProfileFlushMs: process.env.BOBBIT_E2E_PROFILE_FLUSH_MS,
	};
}

export function resolveLegacyTestRuntimeFlags(env: NodeJS.ProcessEnv = process.env): LegacyTestRuntimeFlags {
	if (env === process.env) return resolveLegacyTestRuntimeFlagsFromProcessEnv();
	return {
		skipRemotePush: env.BOBBIT_TEST_NO_PUSH === "1",
		skipNonLocalRemoteGit: env.BOBBIT_TEST_NO_REMOTE === "1" || env.BOBBIT_TEST_NO_EXTERNAL === "1",
		skipMcp: !!env.BOBBIT_SKIP_MCP,
		skipWorktreePool: !!env.BOBBIT_SKIP_WORKTREE_POOL,
		skipTitleGeneration: !!env.BOBBIT_SKIP_TITLE_GEN,
		skipAigwDiscovery: !!env.BOBBIT_SKIP_AIGW_DISCOVERY,
		skipLlmReview: !!env.BOBBIT_LLM_REVIEW_SKIP,
		testNoExternal: env.BOBBIT_TEST_NO_EXTERNAL === "1",
		e2e: env.BOBBIT_E2E === "1",
		skipNpmCi: !!env.BOBBIT_SKIP_NPM_CI,
		testRecordSetup: env.BOBBIT_TEST_RECORD_SETUP,
		e2eTmpRoot: env.BOBBIT_E2E_TMP_ROOT,
		testPreparingDelayMs: env.BOBBIT_TEST_PREPARING_DELAY_MS,
		e2eProfile: env.BOBBIT_E2E_PROFILE === "1",
		e2eProfileFlushMs: env.BOBBIT_E2E_PROFILE_FLUSH_MS,
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
		if (value !== undefined) (flags as any)[key] = value;
	}
	return flags;
}
