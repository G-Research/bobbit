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
export type EnvPatch = Record<string, string | undefined>;

function applyPatch(patch: EnvPatch): void {
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

export function withEnv<T>(patch: EnvPatch, fn: () => T): T {
	const keys = Object.keys(patch);
	const hadKey = new Map<string, boolean>();
	const prior = new Map<string, string | undefined>();
	for (const key of keys) {
		const present = Object.prototype.hasOwnProperty.call(process.env, key);
		hadKey.set(key, present);
		prior.set(key, present ? process.env[key] : undefined);
	}

	const restore = (): void => {
		for (const key of keys) {
			if (hadKey.get(key)) process.env[key] = prior.get(key) as string;
			else delete process.env[key];
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
