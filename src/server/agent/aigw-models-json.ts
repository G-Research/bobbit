import { applyEdits, findNodeAtLocation, getNodeValue, modify, parse, parseTree, type Node as JsoncNode, type ParseError } from "jsonc-parser";

export const AIGW_MANAGED_MARKER = {
	kind: "aigw-publication",
	version: 1,
} as const;

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

function propertyValue(property: JsoncNode): JsoncNode | undefined {
	return property.children?.[1];
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

function inspectGatewayProvider(source: string, providerName: string): { root: JsoncNode; provider?: JsoncNode } {
	const root = parseDocument(source);
	const providerProperties = objectProperties(root, "providers");
	if (providerProperties.length > 1) {
		throw new AigwModelsJsonOwnershipError("models.json has duplicate providers keys; refusing ambiguous gateway publication");
	}
	const providers = providerProperties[0] ? propertyValue(providerProperties[0]) : undefined;
	if (providers && providers.type !== "object") {
		throw new AigwModelsJsonOwnershipError("models.json providers is not an object; refusing gateway publication");
	}
	const matches = objectProperties(providers, providerName);
	if (matches.length > 1) {
		throw new AigwModelsJsonOwnershipError(`models.json has duplicate providers.${providerName} keys; refusing ambiguous gateway publication`);
	}
	return { root, provider: matches[0] ? propertyValue(matches[0]) : undefined };
}

/**
 * Insert or refresh a named non-AIGW gateway provider without reserializing the
 * document. A pre-existing unmarked provider is always user-owned, even if a
 * stale preference previously claimed its name.
 */
export function publishManagedGatewayProvider(source: string | undefined, providerName: string, generatedProvider: Record<string, unknown>): string {
	let text = source ?? "{}\n";
	const formatting = formattingFor(text);
	const state = inspectGatewayProvider(text, providerName);
	const generated = { ...generatedProvider, "x-bobbit-managed": AIGW_MANAGED_MARKER };

	if (!state.provider) return setValue(text, ["providers", providerName], generated, formatting);
	if (!isManagedAigw(state.provider)) {
		throw new AigwModelsJsonOwnershipError(
			`models.json already contains an unmarked providers.${providerName} block; it is user-owned and was not changed`,
		);
	}
	assertAigwFieldsUnambiguous(state.provider);
	for (const key of ["baseUrl", "apiKey", "api", "models"] as const) {
		text = setValue(text, ["providers", providerName, key], generatedProvider[key], formatting);
	}
	const headers = generatedProvider.headers as Record<string, unknown> | undefined;
	const reparsed = inspectGatewayProvider(text, providerName);
	const headersNode = findNodeAtLocation(reparsed.root, ["providers", providerName, "headers"]);
	if (headersNode && headersNode.type !== "object") text = setValue(text, ["providers", providerName, "headers"], {}, formatting);
	for (const [name, value] of Object.entries(headers ?? {})) {
		text = setValue(text, ["providers", providerName, "headers", name], value, formatting);
	}
	text = setValue(text, ["providers", providerName, "x-bobbit-managed", "kind"], AIGW_MANAGED_MARKER.kind, formatting);
	return setValue(text, ["providers", providerName, "x-bobbit-managed", "version"], AIGW_MANAGED_MARKER.version, formatting);
}

/** Remove only a named provider carrying Bobbit's publication marker. */
export function removeManagedGatewayProvider(source: string, providerName: string): { text: string; removed: boolean } {
	const state = inspectGatewayProvider(source, providerName);
	if (!state.provider || !isManagedAigw(state.provider)) return { text: source, removed: false };
	assertAigwFieldsUnambiguous(state.provider);
	return {
		text: setValue(source, ["providers", providerName], undefined, formattingFor(source)),
		removed: true,
	};
}
