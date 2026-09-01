/**
 * `withEnv` — scoped process.env mutation for migrated tests.
 *
 * Vitest fork workers run test files sequentially within a fork, so a test may
 * safely mutate `process.env` as long as it restores the prior state before the
 * next file runs. The codemod wraps every env-mutating legacy test in
 * `withEnv(patch, fn)`; this helper snapshots, applies, runs, and restores in a
 * `finally`, preserving the missing-vs-empty distinction (a key that did not
 * exist is deleted again; a key that was empty-string is set back to "").
 *
 * A `patch` value of `undefined` deletes that key for the duration of `fn`.
 */
import {
	deleteEnvironmentValue,
	environmentKeysEqual,
	setEnvironmentValue,
} from "../../../../scripts/testing-v2/environment-policy.mjs";

export type EnvPatch = Record<string, string | undefined>;

function applyPatch(patch: EnvPatch): void {
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) deleteEnvironmentValue(process.env, key);
		else setEnvironmentValue(process.env, key, value);
	}
}

export function withEnv<T>(patch: EnvPatch, fn: () => T): T {
	const keys = Object.keys(patch);
	const prior = new Map<string, Array<[string, string]>>();
	for (const key of keys) {
		prior.set(key, Object.keys(process.env)
			.filter((existing) => environmentKeysEqual(existing, key))
			.map((existing) => [existing, process.env[existing]!]));
	}

	const restore = (): void => {
		for (const key of keys) {
			deleteEnvironmentValue(process.env, key);
			for (const [spelling, value] of prior.get(key) ?? [])
				setEnvironmentValue(process.env, spelling, value);
		}
	};

	applyPatch(patch);
	let result: T;
	try {
		result = fn();
	} catch (err) {
		restore();
		throw err;
	}
	if (result instanceof Promise) {
		return result.finally(restore) as unknown as T;
	}
	restore();
	return result;
}
