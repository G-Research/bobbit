/**
 * Lossless compact representation for preview marker entries.
 *
 * Raw entries are always preferred. The control-character prefix cannot occur
 * in a valid mounted filename, so encoded entries are unambiguous and old raw
 * markers remain compatible.
 */
export const PREVIEW_ENTRY_CODEC_SENTINEL = "\u001eR";
const MAX_PREVIEW_ENTRY_LENGTH = 255;
const INVALID_PREVIEW_ENTRY = /[\\/\u0000-\u001f\u007f]/u;

/** A safe single filename accepted by preview mounts and snapshot markers. */
export function isValidPreviewEntry(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_PREVIEW_ENTRY_LENGTH
		&& value !== "."
		&& value !== ".."
		&& !INVALID_PREVIEW_ENTRY.test(value);
}

/**
 * Return a smaller reversible run-length representation, or the raw value
 * when encoding would not save space. The compact grammar is deliberately
 * small and bounded: `\u001eR` followed by raw text (`~~` encodes `~`) and
 * `~<base36 count>,<hex code point>;` run tokens.
 */
export function encodePreviewEntry(entry: string): string {
	if (!isValidPreviewEntry(entry)) return entry;
	const characters = Array.from(entry);
	let encoded = PREVIEW_ENTRY_CODEC_SENTINEL;
	for (let index = 0; index < characters.length;) {
		const character = characters[index]!;
		let end = index + 1;
		while (end < characters.length && characters[end] === character) end++;
		const count = end - index;
		const run = `~${count.toString(36)},${character.codePointAt(0)!.toString(16)};`;
		if (count > run.length) encoded += run;
		else encoded += character === "~" ? "~".repeat(count * 2) : characters.slice(index, end).join("");
		index = end;
	}
	return encoded.length < entry.length ? encoded : entry;
}

/**
 * Decode a raw or compact stored marker entry. Invalid or expansion-heavy
 * envelopes fail closed; decoded output is still validated by callers.
 */
export function decodePreviewEntry(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (!value.startsWith(PREVIEW_ENTRY_CODEC_SENTINEL)) return value;
	// Writer output is always shorter than a valid (≤255 code-unit) raw entry.
	// Reject larger envelopes before parsing so malformed stored data is bounded.
	if (value.length > MAX_PREVIEW_ENTRY_LENGTH) return null;

	let decoded = "";
	let index = PREVIEW_ENTRY_CODEC_SENTINEL.length;
	while (index < value.length) {
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) return null;
		const character = String.fromCodePoint(codePoint);
		index += character.length;
		if (character !== "~") {
			if (decoded.length + character.length > MAX_PREVIEW_ENTRY_LENGTH) return null;
			decoded += character;
			continue;
		}
		if (value[index] === "~") {
			if (decoded.length + 1 > MAX_PREVIEW_ENTRY_LENGTH) return null;
			decoded += "~";
			index++;
			continue;
		}

		const comma = value.indexOf(",", index);
		const terminator = comma < 0 ? -1 : value.indexOf(";", comma + 1);
		if (comma < 0 || terminator < 0 || comma - index > 2 || terminator - comma - 1 > 6) return null;
		const countText = value.slice(index, comma);
		const pointText = value.slice(comma + 1, terminator);
		if (!/^[1-9a-z][0-9a-z]*$/iu.test(countText) || !/^[0-9a-f]{1,6}$/iu.test(pointText)) return null;
		const count = Number.parseInt(countText, 36);
		const point = Number.parseInt(pointText, 16);
		if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PREVIEW_ENTRY_LENGTH
			|| !Number.isSafeInteger(point) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
		const run = String.fromCodePoint(point);
		if (run.length * count > MAX_PREVIEW_ENTRY_LENGTH - decoded.length) return null;
		decoded += run.repeat(count);
		index = terminator + 1;
	}
	return decoded;
}
