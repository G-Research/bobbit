// v2-native — pure UTF-8 text-likeness classification for uploaded attachments.
import { describe, expect, it } from "vitest";
import { decodeLikelyUtf8Text } from "../../src/shared/uploaded-attachment-text.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("uploaded attachment UTF-8 text classifier", () => {
	it("rejects dense valid UTF-8 C1 controls", () => {
		expect(decodeLikelyUtf8Text(encode("a".repeat(98) + "\u0080\u009f"))).toBeUndefined();
	});

	it("keeps the existing density allowance for an isolated C1 control", () => {
		const text = "a".repeat(99) + "\u0080";
		expect(decodeLikelyUtf8Text(encode(text))).toBe(text);
	});
});
