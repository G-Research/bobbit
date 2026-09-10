import QRCode from "qrcode";

export interface QrCodeOptions {
	width?: number;
	margin?: number;
	color?: { dark?: string; light?: string };
}

/**
 * Keep CommonJS interop at a static module boundary. Vite/Rolldown can otherwise
 * apply default-export interop twice when `qrcode` itself is dynamically
 * imported, leaving its browser default undefined at runtime.
 */
export function qrCodeToDataUrl(text: string, options?: QrCodeOptions): Promise<string> {
	return QRCode.toDataURL(text, options);
}
