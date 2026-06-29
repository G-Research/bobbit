import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";
import { McpClient } from "../mcp/mcp-client.js";
import type { MarketplaceSource } from "./marketplace-source-store.js";
import { isSafeMcpListName, isValidMcpServerName, mcpGeneratedPackNameForId } from "./pack-contributions.js";
import type { PackManifest } from "./pack-types.js";

const DEFAULT_GATEWAY_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_GATEWAY_MAX_BODY_BYTES = 1024 * 1024;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HTTP_TRANSPORT_TYPES = new Set(["http", "streamable-http"]);

export interface GatewayConnection {
	server: "gr" | "gr-write";
	url: string;
	headers?: Record<string, string>;
}

export interface GatewayOperation {
	name: string;
	label?: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpGatewayProvider {
	id: string;
	label?: string;
	description?: string;
	version?: string;
	read: GatewayConnection;
	write?: GatewayConnection;
	operations?: GatewayOperation[];
	fingerprint: string;
}

export interface McpGatewaySkippedEntry {
	id?: string;
	name?: string;
	reason: string;
}

export interface McpGatewayParseResult {
	providers: McpGatewayProvider[];
	skipped: McpGatewaySkippedEntry[];
}

export interface FetchMcpGatewayOptions {
	timeoutMs?: number;
	maxBodyBytes?: number;
	fetchFn?: typeof fetch;
	discoveryMode?: "mcp" | "catalogue";
}

export type McpGatewayBrowsePack = PackManifest & {
	dirName: string;
	hasTools: boolean;
	virtual: true;
	sourceType: "mcp-gateway";
	gatewayProviderId: string;
	serverName: "gr";
	descriptions?: { mcp?: Record<string, string> };
	mcp: Array<Record<string, unknown>>;
	mcpServers: Array<Record<string, unknown>>;
	mcpGatewayDiagnostics?: { skippedEntries: McpGatewaySkippedEntry[] };
};

export interface MaterializeGatewayProviderPackOptions {
	sourceUrl?: string;
	sourceId?: string;
	sourceName?: string;
	materializedAt?: string;
}

export class McpGatewayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpGatewayError";
	}
}

export function isMcpGatewaySource(source: MarketplaceSource): boolean {
	return (source as { type?: unknown }).type === "mcp-gateway";
}

export function isLegacyMcpRegistrySource(source: MarketplaceSource): boolean {
	return (source as { type?: unknown }).type === "mcp-registry";
}

export async function fetchMcpGateway(source: MarketplaceSource, opts?: FetchMcpGatewayOptions): Promise<McpGatewayProvider[]> {
	return (await fetchMcpGatewayWithDiagnostics(source, opts)).providers;
}

export async function fetchMcpGatewayWithDiagnostics(source: MarketplaceSource, opts: FetchMcpGatewayOptions = {}): Promise<McpGatewayParseResult> {
	if (!isMcpGatewaySource(source)) throw new McpGatewayError(`source is not an MCP gateway: ${source.id}`);
	if (source.ref) throw new McpGatewayError("mcp-gateway sources do not support ref");
	validateHttpUrl(source.url, "gateway source URL");
	const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_GATEWAY_MAX_BODY_BYTES;
	if (!Number.isFinite(maxBodyBytes) || maxBodyBytes < 1) throw new McpGatewayError("gateway max body size must be positive");
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATEWAY_FETCH_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new McpGatewayError("gateway fetch timeout must be positive");

	if (opts.discoveryMode === "catalogue") {
		return fetchMcpGatewayCatalogueWithDiagnostics(source.url, { ...opts, maxBodyBytes, timeoutMs });
	}
	return fetchMcpGatewayViaProtocol(source.url, timeoutMs);
}

export function candidateGatewayCatalogueUrls(sourceUrl: string): string[] {
	const source = validateHttpUrl(sourceUrl, "gateway source URL");
	source.hash = "";
	return [source.toString().replace(/\/+$/, "")];
}

async function fetchMcpGatewayViaProtocol(sourceUrl: string, timeoutMs: number): Promise<McpGatewayParseResult> {
	const client = new McpClient("mcp-gateway-discovery");
	try {
		try {
			await withGatewayTimeout(client.connect({ url: sourceUrl }), timeoutMs, `gateway MCP initialize timed out after ${timeoutMs}ms`);
		} catch (err) {
			throw new McpGatewayError(`gateway MCP initialize failed: ${errorMessage(err)}`);
		}
		let tools: unknown[];
		try {
			tools = await withGatewayTimeout(client.listTools(), timeoutMs, `gateway MCP tools/list timed out after ${timeoutMs}ms`);
		} catch (err) {
			throw new McpGatewayError(`gateway MCP tools/list failed: ${errorMessage(err)}`);
		}
		return parseMcpGatewayDocument({ tools }, sourceUrl);
	} finally {
		await client.disconnect().catch(() => undefined);
	}
}

async function fetchMcpGatewayCatalogueWithDiagnostics(sourceUrl: string, opts: Required<Pick<FetchMcpGatewayOptions, "timeoutMs" | "maxBodyBytes">> & FetchMcpGatewayOptions): Promise<McpGatewayParseResult> {
	const errors: string[] = [];
	for (const candidate of candidateGatewayCatalogueUrls(sourceUrl)) {
		try {
			const raw = await fetchCandidateJson(candidate, opts);
			return parseMcpGatewayDocument(raw, sourceUrl);
		} catch (err) {
			errors.push(`${candidate}: ${errorMessage(err)}`);
		}
	}
	throw new McpGatewayError(`gateway catalogue fetch failed: ${errors.join("; ")}`);
}

async function withGatewayTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new McpGatewayError(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function fetchCandidateJson(url: string, opts: Required<Pick<FetchMcpGatewayOptions, "timeoutMs" | "maxBodyBytes">> & FetchMcpGatewayOptions): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
	try {
		const response = await (opts.fetchFn ?? fetch)(url, { headers: { accept: "application/json" }, signal: controller.signal });
		if (!response.ok) throw new McpGatewayError(`gateway fetch failed: HTTP ${response.status}`);
		const declaredLength = response.headers.get("content-length");
		if (declaredLength !== null) {
			const length = Number(declaredLength);
			if (!Number.isFinite(length) || length < 0) throw new McpGatewayError(`gateway response has invalid Content-Length: ${declaredLength}`);
			if (length > opts.maxBodyBytes) throw new McpGatewayError(`gateway response Content-Length ${length} exceeds limit ${opts.maxBodyBytes}`);
		}
		try {
			return JSON.parse(await readResponseTextBounded(response, opts.maxBodyBytes));
		} catch (err) {
			if (err instanceof McpGatewayError) throw err;
			if (controller.signal.aborted) throw new McpGatewayError(`gateway fetch timed out after ${opts.timeoutMs}ms`);
			throw new McpGatewayError(`gateway response is not valid JSON: ${String(err)}`);
		}
	} catch (err) {
		if (err instanceof McpGatewayError) throw err;
		if (controller.signal.aborted) throw new McpGatewayError(`gateway fetch timed out after ${opts.timeoutMs}ms`);
		throw new McpGatewayError(`gateway fetch failed: ${String(err)}`);
	} finally {
		clearTimeout(timeout);
	}
}

async function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new McpGatewayError(`gateway response body exceeds limit ${maxBytes}`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

export function parseMcpGatewayDocument(raw: unknown, sourceUrl: string): McpGatewayParseResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw unsupportedFormatError();
	}
	const { entries, version } = gatewayProviderEntries(raw as Record<string, unknown>);
	const providers: McpGatewayProvider[] = [];
	const skipped: McpGatewaySkippedEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		let provider: McpGatewayProvider;
		try {
			provider = normalizeProvider(entry, sourceUrl, version);
		} catch (err) {
			const obj = isPlainObject(entry) ? entry : undefined;
			skipped.push({
				id: obj ? firstString(obj, ["id", "provider", "name", "namespace", "subNamespace"]) : undefined,
				name: obj ? firstString(obj, ["label", "title", "displayName"]) : undefined,
				reason: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		if (seen.has(provider.id)) {
			skipped.push({ id: provider.id, name: provider.label, reason: `duplicate gateway provider id: ${provider.id}` });
			continue;
		}
		seen.add(provider.id);
		providers.push(provider);
	}
	return { providers, skipped };
}

function unsupportedFormatError(): McpGatewayError {
	return new McpGatewayError("unsupported MCP gateway catalogue format: expected providers[] or tools[]");
}

function gatewayProviderEntries(doc: Record<string, unknown>): { entries: unknown[]; version?: string } {
	const version = firstString(doc, ["version", "catalogueVersion", "catalogVersion"]);
	if (Array.isArray(doc.providers)) return { entries: doc.providers, version };
	if (isPlainObject(doc.data) && Array.isArray(doc.data.providers)) return { entries: doc.data.providers, version: firstString(doc.data, ["version", "catalogueVersion", "catalogVersion"]) ?? version };
	if (Array.isArray(doc.tools)) return { entries: providerEntriesFromTools(doc.tools), version };
	throw unsupportedFormatError();
}

function providerEntriesFromTools(tools: unknown[]): unknown[] {
	const grouped = new Map<string, Record<string, unknown> & { tools: unknown[] }>();
	const entries: unknown[] = [];
	for (const tool of tools) {
		if (!isPlainObject(tool)) {
			entries.push(tool);
			continue;
		}
		const explicitId = firstString(tool, ["provider", "namespace", "subNamespace"]);
		const name = firstString(tool, ["name", "id", "operation"]);
		const id = explicitId ?? (name?.includes("__") ? name.split("__", 1)[0] : undefined);
		if (!id) {
			entries.push(tool);
			continue;
		}
		let entry = grouped.get(id);
		if (!entry) {
			entry = {
				id,
				label: firstString(tool, ["providerLabel", "providerTitle", "providerDisplayName", "label", "title", "displayName"]),
				description: firstString(tool, ["providerDescription", "description"]),
				tools: [],
			};
			grouped.set(id, entry);
		}
		entry.tools.push({ ...tool, provider: id });
	}
	entries.push(...grouped.values());
	return entries;
}

function normalizeProvider(raw: unknown, sourceUrl: string, catalogueVersion?: string): McpGatewayProvider {
	if (!isPlainObject(raw)) throw new McpGatewayError("provider entry must be a JSON object");
	const id = firstString(raw, ["id", "provider", "name", "namespace", "subNamespace"]);
	if (!id) throw new McpGatewayError("provider id is required");
	if (!isSafeMcpListName(id) || !isValidMcpServerName(id)) throw new McpGatewayError(`unsafe gateway provider id: ${id}`);
	try {
		mcpGeneratedPackNameForId(id);
	} catch (err) {
		throw new McpGatewayError(err instanceof Error ? err.message : String(err));
	}
	const writeListName = `${id}-write`;
	const label = firstString(raw, ["label", "title", "displayName"]);
	const description = firstString(raw, ["description"]);
	const version = firstString(raw, ["version", "catalogueVersion", "catalogVersion"]) ?? catalogueVersion;
	const read = normalizeReadConnection(raw, sourceUrl);
	const write = normalizeWriteConnection(raw);
	if (write && !isSafeMcpListName(writeListName)) throw new McpGatewayError(`generated write MCP listName is unsafe: ${writeListName}`);
	const operations = normalizeOperations(raw);
	const fingerprintInput = stripUndefined({ id, label, description, version, read, write, operations });
	return {
		id,
		label,
		description,
		version,
		read,
		write,
		operations,
		fingerprint: crypto.createHash("sha256").update(stableStringify(fingerprintInput)).digest("hex"),
	};
}

function normalizeReadConnection(raw: Record<string, unknown>, sourceUrl: string): GatewayConnection {
	const readObj = isPlainObject(raw.read) ? raw.read : undefined;
	const transportObj = isPlainObject((readObj ?? raw).transport) ? ((readObj ?? raw).transport as Record<string, unknown>) : undefined;
	validateDeclaredTransport(readObj ?? raw, "read transport");
	const urlValue = firstString(readObj ?? {}, ["url", "endpoint", "mcpUrl"])
		?? firstString(transportObj ?? {}, ["url", "endpoint", "mcpUrl"])
		?? (typeof raw.read === "string" && raw.read.trim().length > 0 ? raw.read.trim() : undefined)
		?? firstString(raw, ["readUrl", "readEndpoint", "url", "endpoint"])
		?? sourceUrl;
	const url = validateHttpUrl(urlValue, "read gateway URL").toString();
	const headers = normalizeHeaders((readObj?.headers ?? transportObj?.headers ?? raw.headers), "read headers");
	return stripUndefined({ server: "gr" as const, url, headers });
}

function normalizeWriteConnection(raw: Record<string, unknown>): GatewayConnection | undefined {
	const writeRaw = raw.write;
	const writeObj = isPlainObject(writeRaw) ? writeRaw : undefined;
	const transportObj = isPlainObject((writeObj ?? {}).transport) ? (writeObj?.transport as Record<string, unknown>) : undefined;
	const writeUrl = firstString(writeObj ?? {}, ["url", "endpoint", "mcpUrl"])
		?? firstString(transportObj ?? {}, ["url", "endpoint", "mcpUrl"])
		?? (typeof writeRaw === "string" && writeRaw.trim().length > 0 ? writeRaw.trim() : undefined)
		?? firstString(raw, ["writeUrl", "writeEndpoint"]);
	const wantsWrite = writeRaw !== undefined || firstBool(isPlainObject(raw.capabilities) ? raw.capabilities : {}, ["write"]) === true || (firstBool(raw, ["readOnly"]) === false && writeUrl !== undefined);
	if (!writeUrl) {
		if (wantsWrite && (writeRaw === true || firstBool(isPlainObject(raw.capabilities) ? raw.capabilities : {}, ["write"]) === true || firstBool(raw, ["readOnly"]) === false)) return undefined;
		return undefined;
	}
	validateDeclaredTransport(writeObj ?? raw, "write transport");
	const url = validateHttpUrl(writeUrl, "write gateway URL").toString();
	const headers = normalizeHeaders((writeObj?.headers ?? transportObj?.headers ?? raw.writeHeaders), "write headers");
	return stripUndefined({ server: "gr-write" as const, url, headers });
}

function validateDeclaredTransport(raw: Record<string, unknown>, where: string): void {
	const transport = raw.transport;
	if (transport === undefined) return;
	const type = typeof transport === "string" ? transport : isPlainObject(transport) ? firstString(transport, ["type"]) : undefined;
	if (!type) throw new McpGatewayError(`${where} is malformed`);
	if (!HTTP_TRANSPORT_TYPES.has(type)) throw new McpGatewayError(`unsupported ${where}: ${type}`);
}

function normalizeOperations(raw: Record<string, unknown>): GatewayOperation[] | undefined {
	const list = Array.isArray(raw.operations) ? raw.operations : Array.isArray(raw.tools) ? raw.tools : undefined;
	if (!list) return undefined;
	const operations: GatewayOperation[] = [];
	for (const item of list) {
		if (!isPlainObject(item)) continue;
		let name = firstString(item, ["operation", "name", "id"]);
		const provider = firstString(item, ["provider", "namespace", "subNamespace"]);
		if (name && provider && name.startsWith(`${provider}__`)) name = name.slice(provider.length + 2);
		if (!name) continue;
		operations.push(stripUndefined({ name, label: firstString(item, ["label", "title", "displayName"]), description: firstString(item, ["description"]), inputSchema: item.inputSchema }));
	}
	return operations.length > 0 ? operations : undefined;
}

function normalizeHeaders(raw: unknown, where: string): Record<string, string> | undefined {
	if (raw === undefined) return undefined;
	if (!isPlainObject(raw)) throw new McpGatewayError(`${where} must be an object`);
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!HEADER_NAME_RE.test(name)) throw new McpGatewayError(`${where} contains invalid header name: ${name}`);
		if (typeof value === "string") {
			headers[name] = value;
			continue;
		}
		if (isPlainObject(value) && (value.secret === true || value.isSecret === true)) throw new McpGatewayError(`${where} header ${name} is marked secret`);
		throw new McpGatewayError(`${where} header ${name} must be a concrete string`);
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export function gatewayProviderToVirtualPack(provider: McpGatewayProvider): McpGatewayBrowsePack {
	const packName = gatewayPackNameForProvider(provider.id);
	const mcpEntries = providerMcpWireEntries(provider);
	const contentsMcp = mcpEntries.map((entry) => entry.ref as string);
	const mcpDescriptions: Record<string, string> = {};
	if (provider.description) {
		mcpDescriptions[provider.id] = provider.description;
		if (provider.write) mcpDescriptions[`${provider.id}-write`] = writeDescription(provider);
	}
	return {
		schema: 2,
		name: packName,
		description: provider.description || provider.label || `${provider.id} MCP gateway provider`,
		version: provider.version || "0.0.0",
		contents: { roles: [], tools: [], skills: [], entrypoints: [], mcp: contentsMcp },
		dirName: packName,
		hasTools: false,
		virtual: true,
		sourceType: "mcp-gateway",
		gatewayProviderId: provider.id,
		serverName: "gr",
		descriptions: Object.keys(mcpDescriptions).length > 0 ? { mcp: mcpDescriptions } : undefined,
		mcp: mcpEntries,
		mcpServers: mcpEntries,
	};
}

function providerMcpWireEntries(provider: McpGatewayProvider): Array<Record<string, unknown>> {
	const entries: Array<Record<string, unknown>> = [connectionToMcpWire(provider, provider.id, provider.read)];
	if (provider.write) entries.push(connectionToMcpWire(provider, `${provider.id}-write`, provider.write));
	return entries;
}

function connectionToMcpWire(provider: McpGatewayProvider, listName: string, connection: GatewayConnection): Record<string, unknown> {
	return stripUndefined({
		ref: listName,
		listName,
		serverName: connection.server,
		subNamespace: provider.id,
		label: listName.endsWith("-write") ? writeLabel(provider) : provider.label,
		description: listName.endsWith("-write") ? writeDescription(provider) : provider.description,
		transport: "http",
		url: connection.url,
		headers: connection.headers ? Object.keys(connection.headers) : undefined,
		operations: provider.operations,
	});
}

export function materializeGatewayProviderPack(provider: McpGatewayProvider, destOrStagingDir: string, opts: MaterializeGatewayProviderPackOptions = {}): PackManifest {
	const root = path.resolve(destOrStagingDir);
	const manifest = gatewayProviderToVirtualPack(provider);
	fs.mkdirSync(root, { recursive: true });
	const mcpDir = path.join(root, "mcp");
	const packYamlPath = path.join(root, "pack.yaml");
	const readMcpPath = path.join(mcpDir, `${provider.id}.yaml`);
	const metaPath = path.join(root, ".pack-meta.yaml");
	const targets = [packYamlPath, mcpDir, readMcpPath, metaPath];
	let writeMcpPath: string | undefined;
	if (provider.write) {
		writeMcpPath = path.join(mcpDir, `${provider.id}-write.yaml`);
		targets.push(writeMcpPath);
	}
	for (const target of targets) {
		if (!isPackPathWithinRoot(root, target)) throw new McpGatewayError(`materialized path escapes pack root: ${target}`);
	}
	fs.mkdirSync(mcpDir, { recursive: true });
	fs.writeFileSync(packYamlPath, stringify(stripUndefined({
		schema: 2,
		name: manifest.name,
		description: manifest.description,
		version: manifest.version,
		contents: manifest.contents,
	})), "utf-8");
	fs.writeFileSync(readMcpPath, stringify(mcpContributionYaml(provider, provider.id, provider.read)), "utf-8");
	if (provider.write && writeMcpPath) {
		fs.writeFileSync(writeMcpPath, stringify(mcpContributionYaml(provider, `${provider.id}-write`, provider.write)), "utf-8");
	}
	const gatewayOperations = provider.operations && provider.operations.length > 0
		? Object.fromEntries(providerMcpWireEntries(provider).map((entry) => [entry.listName as string, provider.operations]))
		: undefined;
	fs.writeFileSync(metaPath, stringify(stripUndefined({
		sourceType: "mcp-gateway",
		sourceUrl: opts.sourceUrl,
		sourceId: opts.sourceId,
		sourceName: opts.sourceName,
		gatewayProviderId: provider.id,
		gatewayFingerprint: provider.fingerprint,
		gatewayVersion: provider.version,
		gatewayOperations,
		materializedAt: opts.materializedAt || new Date().toISOString(),
		label: provider.label,
		description: provider.description,
	})), "utf-8");
	return manifest;
}

function mcpContributionYaml(provider: McpGatewayProvider, listName: string, connection: GatewayConnection): Record<string, unknown> {
	return stripUndefined({
		server: connection.server,
		subNamespace: provider.id,
		label: listName.endsWith("-write") ? writeLabel(provider) : provider.label,
		description: listName.endsWith("-write") ? writeDescription(provider) : provider.description,
		transport: stripUndefined({ type: "http", url: connection.url, headers: connection.headers }),
	});
}

export function gatewayPackNameForProvider(providerId: string): string {
	try {
		return mcpGeneratedPackNameForId(providerId);
	} catch (err) {
		throw new McpGatewayError(err instanceof Error ? err.message : String(err));
	}
}

function writeLabel(provider: McpGatewayProvider): string {
	return `${provider.label || provider.id} write`;
}

function writeDescription(provider: McpGatewayProvider): string {
	return provider.description ? `${provider.description} (write-capable)` : `${provider.label || provider.id} write-capable tools`;
}

function validateHttpUrl(value: string, where: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new McpGatewayError(`invalid ${where}: ${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new McpGatewayError(`${where} must use http or https`);
	if (url.username || url.password) throw new McpGatewayError(`${where} must not contain credentials`);
	if (url.hash) throw new McpGatewayError(`${where} must not contain a fragment`);
	return url;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function firstBool(obj: Record<string, unknown>, keys: string[]): boolean | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripUndefined<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => stripUndefined(item)) as T;
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (child !== undefined) out[key] = stripUndefined(child);
	}
	return out as T;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}
