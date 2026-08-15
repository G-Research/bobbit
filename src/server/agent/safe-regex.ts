/**
 * Bounded, linear-time regular-expression compilation for caller-provided
 * patterns. RE2 deliberately rejects backreferences and look-around because
 * those constructs can require non-linear matching in JavaScript's engine.
 */
import { RE2 } from "re2-wasm";

export const MAX_SAFE_REGEX_PATTERN_BYTES = 1_024;

export class SafeRegexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SafeRegexError";
	}
}

export function compileSafeRegex(
	pattern: string,
	options: { caseSensitive?: boolean; maxPatternBytes?: number } = {},
): RE2 {
	const maxPatternBytes = options.maxPatternBytes ?? MAX_SAFE_REGEX_PATTERN_BYTES;
	if (typeof pattern !== "string") throw new SafeRegexError("Pattern must be a string");
	if (Buffer.byteLength(pattern, "utf8") > maxPatternBytes) {
		throw new SafeRegexError(`Pattern exceeds the ${maxPatternBytes}-byte limit`);
	}
	try {
		// re2-wasm requires Unicode mode. Its `i` flag is locale-independent,
		// unlike lowercasing text with the host's current locale.
		return new RE2(pattern, options.caseSensitive ? "u" : "iu");
	} catch (error) {
		throw new SafeRegexError(error instanceof Error ? error.message : "Invalid regular expression");
	}
}

/** Escape text for the legacy invalid-pattern-as-literal fallback. */
export function compileSafeLiteral(pattern: string, caseSensitive = false): RE2 {
	return compileSafeRegex(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), { caseSensitive });
}
