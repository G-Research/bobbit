import { gatewayRoute, normalizeBasePath, withBasePath } from "../shared/base-path.js";

const SPA_BASE_PATH_ASSIGNMENT = 'window.__BOBBIT_BASE_PATH__ = "";';

/**
 * Stamp a production SPA shell for the active runtime mount.
 *
 * Root mode is byte-for-byte identity. Mounted mode requires exactly one
 * runtime marker and re-anchors only root-absolute `src`/`href` attributes.
 */
export function rewriteSpaShell(html: string, basePath: string): string {
	const base = normalizeBasePath(basePath);
	if (!base) return html;

	const first = html.indexOf(SPA_BASE_PATH_ASSIGNMENT);
	const last = html.lastIndexOf(SPA_BASE_PATH_ASSIGNMENT);
	if (first < 0 || first !== last) {
		throw new Error("SPA shell must contain exactly one Bobbit base-path marker");
	}

	const stamped = html.slice(0, first)
		+ `window.__BOBBIT_BASE_PATH__ = ${JSON.stringify(base)};`
		+ html.slice(first + SPA_BASE_PATH_ASSIGNMENT.length);

	return stamped.replace(
		/\b(src|href)(\s*=\s*)(["'])(\/(?!\/)[^"']*)\3/gi,
		(_match, attribute: string, equals: string, quote: string, value: string) =>
			`${attribute}${equals}${quote}${base}${value}${quote}`,
	);
}

/** Clone and mount the browser-facing fields of the dynamic PWA manifest. */
export function rewriteManifestForBasePath(
	manifest: Record<string, unknown>,
	basePath: string,
	token?: string,
): Record<string, unknown> {
	const base = normalizeBasePath(basePath);
	const rewritten: Record<string, unknown> = { ...manifest };

	if (base || token) {
		const launch = withBasePath(gatewayRoute("/"), base);
		rewritten.start_url = token
			? `${launch}?token=${encodeURIComponent(token)}`
			: launch;
	}
	if (!base) return rewritten;

	rewritten.scope = withBasePath(gatewayRoute("/"), base);
	if (Array.isArray(manifest.icons)) {
		rewritten.icons = manifest.icons.map((icon) => {
			if (!icon || typeof icon !== "object") return icon;
			const entry = icon as Record<string, unknown>;
			const src = entry.src;
			if (typeof src !== "string" || !src.startsWith("/") || src.startsWith("//")) return icon;
			return { ...entry, src: withBasePath(gatewayRoute(src), base) };
		});
	}
	return rewritten;
}
