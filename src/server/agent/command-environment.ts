/**
 * Validation, normalization, and runtime overlay for declared command
 * environments. These maps are plaintext project configuration, never a
 * transport for host process environment values or shell syntax.
 */

export type CommandEnvironment = Record<string, string>;

export const COMMAND_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_COMMAND_ENV_ENTRIES = 100;
export const MAX_COMMAND_ENV_KEY_LENGTH = 128;
export const MAX_COMMAND_ENV_VALUE_LENGTH = 16_384;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function foldedKey(key: string): string {
	return key.toLocaleLowerCase("en-US");
}

/**
 * Returns a user-facing validation error for a command-environment map, or
 * null when the map is valid. Empty values intentionally remain valid.
 */
export function validateCommandEnvironment(value: unknown, path: string): string | null {
	if (!isPlainObject(value)) return `${path}: must be an object with string values`;
	const entries = Object.entries(value);
	if (entries.length > MAX_COMMAND_ENV_ENTRIES) {
		return `${path}: exceeds ${MAX_COMMAND_ENV_ENTRIES} entries`;
	}

	const seen = new Map<string, string>();
	for (const [key, entryValue] of entries) {
		if (key.length === 0) return `${path}: key must not be empty`;
		if (key.length > MAX_COMMAND_ENV_KEY_LENGTH) {
			return `${path}.${key}: key exceeds ${MAX_COMMAND_ENV_KEY_LENGTH} characters`;
		}
		if (!COMMAND_ENV_KEY_PATTERN.test(key)) {
			return `${path}.${key}: key must match ${COMMAND_ENV_KEY_PATTERN}`;
		}
		if (typeof entryValue !== "string") return `${path}.${key}: value must be a string`;
		if (entryValue.length > MAX_COMMAND_ENV_VALUE_LENGTH) {
			return `${path}.${key}: value exceeds ${MAX_COMMAND_ENV_VALUE_LENGTH} characters`;
		}
		const folded = foldedKey(key);
		const existing = seen.get(folded);
		if (existing !== undefined) {
			return `${path}: duplicate keys "${existing}" and "${key}" (case-insensitive)`;
		}
		seen.set(folded, key);
	}
	return null;
}

/**
 * Safely accepts hand-authored persisted YAML. Invalid maps are omitted rather
 * than partially coerced; normal request paths use validateCommandEnvironment
 * and reject the write before it reaches persistence.
 */
export function normalizeCommandEnvironment(value: unknown): CommandEnvironment | undefined {
	if (value === undefined) return undefined;
	const error = validateCommandEnvironment(value, "env");
	if (error !== null) {
		console.warn(`[command-environment] Ignoring malformed command environment: ${error}`);
		return undefined;
	}
	return { ...(value as CommandEnvironment) };
}

/**
 * Produces an independent, literal command environment snapshot. Later maps
 * override earlier maps case-insensitively so spelling and behavior are stable
 * across Windows and POSIX.
 */
export function resolveCommandEnvironment(
	base: NodeJS.ProcessEnv,
	component?: CommandEnvironment,
	step?: CommandEnvironment,
): NodeJS.ProcessEnv {
	const resolved: NodeJS.ProcessEnv = { ...base };
	const overlay = (values: CommandEnvironment | undefined): void => {
		if (!values) return;
		for (const [key, value] of Object.entries(values)) {
			const folded = foldedKey(key);
			for (const existing of Object.keys(resolved)) {
				if (foldedKey(existing) === folded) delete resolved[existing];
			}
			resolved[key] = value;
		}
	};
	overlay(component);
	overlay(step);
	return resolved;
}
