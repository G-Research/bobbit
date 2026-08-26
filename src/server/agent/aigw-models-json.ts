import { applyEdits, findNodeAtLocation, getNodeValue, modify, parse, parseTree, visit, type Node as JsoncNode, type ParseError } from "jsonc-parser";

export const AIGW_MANAGED_MARKER = {
	kind: "aigw-publication",
	version: 1,
} as const;

/**
 * Single URL comparison used everywhere Bobbit decides whether a models.json
 * AIGW provider still points at the configured gateway. Trailing slashes and
 * host casing are insignificant; anything unparsable or non-HTTP is
 * incomparable (`undefined`) and therefore never matches.
 */
export function comparableAigwUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.href.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

export class AigwModelsJsonOwnershipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AigwModelsJsonOwnershipError";
	}
}

interface FormattingOptions {
	insertSpaces: boolean;
	tabSize: number;
	eol: string;
}

function formattingFor(source: string): FormattingOptions {
	const eol = source.includes("\r\n") ? "\r\n" : "\n";
	const indent = source.match(/(?:\r?\n)([ \t]+)["\w]/)?.[1] ?? "  ";
	return {
		insertSpaces: !indent.includes("\t"),
		tabSize: indent.includes("\t") ? 1 : Math.max(1, indent.length),
		eol,
	};
}

function objectProperties(node: JsoncNode | undefined, name: string): JsoncNode[] {
	if (node?.type !== "object") return [];
	return (node.children ?? []).filter((property) =>
		property.type === "property" && property.children?.[0]?.value === name,
	);
}

function propertyValue(property: JsoncNode | undefined): JsoncNode | undefined {
	return property?.children?.[1];
}

function parseDocument(source: string): JsoncNode {
	const errors: ParseError[] = [];
	const root = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false });
	if (!root || root.type !== "object" || errors.length > 0) {
		throw new AigwModelsJsonOwnershipError("models.json is malformed; refusing to alter user-owned bytes");
	}
	return root;
}

interface AigwPathState {
	root: JsoncNode;
	providers?: JsoncNode;
	aigw?: JsoncNode;
}

/** Read-only ownership view of the AIGW provider Pi will load. */
export type AigwTargetRealm =
	| { kind: "absent" }
	| { kind: "managed"; provider: Record<string, unknown> }
	| { kind: "unmarked-user"; provider: Record<string, unknown> }
	| { kind: "invalid"; reason: string };

function inspectAigwPath(source: string): AigwPathState {
	const root = parseDocument(source);
	const providerProperties = objectProperties(root, "providers");
	if (providerProperties.length > 1) {
		throw new AigwModelsJsonOwnershipError("models.json has duplicate providers keys; refusing ambiguous AIGW publication");
	}
	const providers = providerProperties[0] ? propertyValue(providerProperties[0]) : undefined;
	if (providers && providers.type !== "object") {
		throw new AigwModelsJsonOwnershipError("models.json providers is not an object; refusing AIGW publication");
	}
	const aigwProperties = objectProperties(providers, "aigw");
	if (aigwProperties.length > 1) {
		throw new AigwModelsJsonOwnershipError("models.json has duplicate providers.aigw keys; refusing ambiguous AIGW publication");
	}
	return { root, providers, aigw: aigwProperties[0] ? propertyValue(aigwProperties[0]) : undefined };
}

function isManagedAigw(aigw: JsoncNode | undefined): boolean {
	if (aigw?.type !== "object") return false;
	const markerProperties = objectProperties(aigw, "x-bobbit-managed");
	if (markerProperties.length !== 1) return false;
	const marker = propertyValue(markerProperties[0]);
	if (!marker) return false;
	const value = getNodeValue(marker) as Record<string, unknown> | undefined;
	return value?.kind === AIGW_MANAGED_MARKER.kind && value?.version === AIGW_MANAGED_MARKER.version;
}

function assertAigwFieldsUnambiguous(aigw: JsoncNode): void {
	for (const name of ["baseUrl", "apiKey", "api", "headers", "models", "x-bobbit-managed"]) {
		if (objectProperties(aigw, name).length > 1) {
			throw new AigwModelsJsonOwnershipError(
				`models.json has duplicate providers.aigw.${name} keys; refusing ambiguous AIGW publication`,
			);
		}
	}
}

function setValue(source: string, path: (string | number)[], value: unknown, formatting: FormattingOptions): string {
	return applyEdits(source, modify(source, path, value, { formattingOptions: formatting }));
}

/**
 * Classify the exact AIGW target realm without changing or normalizing its bytes.
 * Malformed and duplicate provider paths are unavailable rather than being
 * replaced with live discovery metadata that Pi will not load.
 */
export function inspectAigwTargetRealm(source: string | undefined): AigwTargetRealm {
	if (source === undefined) return { kind: "absent" };
	try {
		const state = inspectAigwPath(source);
		if (!state.aigw) return { kind: "absent" };
		if (state.aigw.type !== "object") {
			return { kind: "invalid", reason: "models.json providers.aigw is not an object" };
		}
		assertAigwFieldsUnambiguous(state.aigw);
		// Reparse only after the tree-level ambiguity checks so returned nested
		// metadata uses ordinary objects without accepting duplicate target paths.
		const provider = (parse(source, [], {
			allowTrailingComma: true,
			disallowComments: false,
		}) as Record<string, any>).providers.aigw as Record<string, unknown>;
		return isManagedAigw(state.aigw)
			? { kind: "managed", provider }
			: { kind: "unmarked-user", provider };
	} catch (error) {
		return {
			kind: "invalid",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

// ── Legacy (pre-0.17.0) publication adoption ───────────────────────

/**
 * Bobbit's generated provider is fully deterministic (see
 * `writeAigwModelsJson`), which is what makes recognising its own older,
 * unmarked output safe. These constants describe that exact shape; anything
 * that deviates is treated as hand-authored and left untouched.
 */
const LEGACY_PROVIDER_KEYS = ["baseUrl", "apiKey", "api", "headers", "models"] as const;
const LEGACY_SESSION_HEADER = `!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;

/**
 * True when the exact byte range of the `providers.aigw` value contains no
 * comment and no trailing comma. Comments, trailing commas, and unknown fields
 * anywhere *outside* that range (root comments, sibling providers, the comma
 * delimiting the `aigw` property itself) are irrelevant to ownership.
 *
 * jsonc-parser's scanner is used rather than a regex so comment-like text
 * inside string values cannot be mistaken for a comment.
 */
function aigwRangeIsPlainJson(source: string, aigw: JsoncNode): boolean {
	const start = aigw.offset;
	const end = aigw.offset + aigw.length;
	let plain = true;
	const overlaps = (offset: number, length: number) => offset < end && offset + Math.max(length, 1) > start;
	visit(source, {
		onComment: (offset, length) => { if (overlaps(offset, length)) plain = false; },
		// The document already parsed with `allowTrailingComma`, so any error
		// reported without it is a trailing comma (reported at the token that
		// follows it — for a trailing comma inside `aigw` that is its own `}`/`]`).
		onError: (_code, offset, length) => { if (overlaps(offset, length)) plain = false; },
	}, { allowTrailingComma: false, disallowComments: false });
	return plain;
}

/** All criteria are required; any deviation keeps the block user-owned. */
function isLegacyBobbitPublication(source: string, aigw: JsoncNode, configuredAigwUrl: string): boolean {
	const properties = (aigw.children ?? []).filter((property) => property.type === "property");
	if (properties.length !== LEGACY_PROVIDER_KEYS.length) return false;
	if (!LEGACY_PROVIDER_KEYS.every((key) => objectProperties(aigw, key).length === 1)) return false;

	const headersNode = propertyValue(objectProperties(aigw, "headers")[0]);
	if (headersNode?.type !== "object") return false;
	if ((headersNode.children ?? []).filter((property) => property.type === "property").length !== 2) return false;

	const provider = getNodeValue(aigw) as Record<string, unknown>;
	if (provider.apiKey !== "none" || provider.api !== "openai-completions") return false;

	const headers = provider.headers as Record<string, unknown>;
	if (typeof headers["User-Agent"] !== "string" || !/^Bobbit\//.test(headers["User-Agent"] as string)) return false;
	if (headers["x-opencode-session"] !== LEGACY_SESSION_HEADER) return false;

	if (!Array.isArray(provider.models)) return false;
	if (!provider.models.every((model) => !!model && typeof model === "object" && !Array.isArray(model))) return false;

	const configured = comparableAigwUrl(configuredAigwUrl);
	if (!configured || comparableAigwUrl(provider.baseUrl) !== configured) return false;

	return aigwRangeIsPlainJson(source, aigw);
}

export type AigwAdoptionResult =
	| { adopted: true; text: string; realm: Extract<AigwTargetRealm, { kind: "managed" }> }
	| { adopted: false; text: string | undefined; realm: AigwTargetRealm };

/**
 * Adopt a `providers.aigw` block that Bobbit itself published before the
 * `x-bobbit-managed` marker existed (v0.16.3 and earlier), so upgraded installs
 * resume managed discovery and upstream-provider provenance instead of being
 * frozen forever as "user-owned".
 *
 * Adoption inserts *only* the marker, through the same jsonc edit path as every
 * other write here; the enclosing document is never reformatted. Absent,
 * already-marked, invalid, and unrecognised blocks are returned unchanged.
 * Ambiguous/malformed documents still fail closed by throwing before any
 * mutation is considered.
 */
export function adoptLegacyAigwProvider(source: string | undefined, configuredAigwUrl: string): AigwAdoptionResult {
	if (source === undefined) return { adopted: false, text: source, realm: { kind: "absent" } };
	const state = inspectAigwPath(source);
	if (!state.aigw) return { adopted: false, text: source, realm: { kind: "absent" } };
	if (state.aigw.type !== "object") {
		return { adopted: false, text: source, realm: { kind: "invalid", reason: "models.json providers.aigw is not an object" } };
	}
	assertAigwFieldsUnambiguous(state.aigw);
	if (isManagedAigw(state.aigw) || !isLegacyBobbitPublication(source, state.aigw, configuredAigwUrl)) {
		return { adopted: false, text: source, realm: inspectAigwTargetRealm(source) };
	}
	const text = setValue(source, ["providers", "aigw", "x-bobbit-managed"], AIGW_MANAGED_MARKER, formattingFor(source));
	const realm = inspectAigwTargetRealm(text);
	// Defensive: never report adoption unless the resulting bytes really classify
	// as managed, so a failed edit can't silently claim ownership.
	if (realm.kind !== "managed") return { adopted: false, text: source, realm: inspectAigwTargetRealm(source) };
	return { adopted: true, text, realm };
}

/**
 * Insert or refresh Bobbit's explicitly marked AIGW provider. Existing unmarked
 * providers and malformed/ambiguous documents are user-owned and fail closed.
 */
export function publishManagedAigwProvider(source: string | undefined, generatedProvider: Record<string, unknown>): string {
	let text = source ?? "{}\n";
	const formatting = formattingFor(text);
	const state = inspectAigwPath(text);
	const generated = { ...generatedProvider, "x-bobbit-managed": AIGW_MANAGED_MARKER };

	if (!state.aigw) {
		return setValue(text, ["providers", "aigw"], generated, formatting);
	}
	if (!isManagedAigw(state.aigw)) {
		throw new AigwModelsJsonOwnershipError(
			"models.json already contains an unmarked providers.aigw block; it is user-owned and was not changed",
		);
	}
	assertAigwFieldsUnambiguous(state.aigw);

	// Only Bobbit-managed fields are refreshed. Unknown fields and comments in
	// the marked provider remain byte-for-byte where jsonc-parser leaves them.
	for (const key of ["baseUrl", "apiKey", "api", "models"] as const) {
		text = setValue(text, ["providers", "aigw", key], generatedProvider[key], formatting);
	}
	const headers = generatedProvider.headers as Record<string, unknown> | undefined;
	const reparsed = inspectAigwPath(text);
	const headersNode = findNodeAtLocation(reparsed.root, ["providers", "aigw", "headers"]);
	if (headersNode && headersNode.type !== "object") {
		text = setValue(text, ["providers", "aigw", "headers"], {}, formatting);
	}
	for (const [name, value] of Object.entries(headers ?? {})) {
		text = setValue(text, ["providers", "aigw", "headers", name], value, formatting);
	}
	text = setValue(text, ["providers", "aigw", "x-bobbit-managed", "kind"], AIGW_MANAGED_MARKER.kind, formatting);
	text = setValue(text, ["providers", "aigw", "x-bobbit-managed", "version"], AIGW_MANAGED_MARKER.version, formatting);
	return text;
}

/** Remove only a provider carrying Bobbit's forward-only publication marker. */
export function removeManagedAigwProvider(source: string): { text: string; removed: boolean } {
	const formatting = formattingFor(source);
	const state = inspectAigwPath(source);
	if (!state.aigw || !isManagedAigw(state.aigw)) return { text: source, removed: false };
	assertAigwFieldsUnambiguous(state.aigw);
	return {
		text: setValue(source, ["providers", "aigw"], undefined, formatting),
		removed: true,
	};
}
