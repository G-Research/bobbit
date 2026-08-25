/**
 * Decode bytes only when they look like ordinary UTF-8 text.
 *
 * Filename extensions and MIME metadata are intentionally not inputs: uploaded
 * attachment metadata is untrusted, so text eligibility must come from bytes.
 */
export function decodeLikelyUtf8Text(bytes: Uint8Array): string | undefined {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}

	let suspiciousControls = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		// Preserve whitespace controls used by ordinary text. NUL is a strong
		// binary signal; judge other C0/C1/DEL controls by density so an occasional
		// form-feed does not make an otherwise readable file opaque.
		if (code === 0) return undefined;
		if (
			(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
			|| (code >= 0x7f && code <= 0x9f)
		) {
			suspiciousControls++;
		}
	}

	return text.length > 0 && suspiciousControls / text.length > 0.01
		? undefined
		: text;
}
