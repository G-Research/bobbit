import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import type { McpServerConfig } from "../mcp/mcp-types.js";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";
import type { BrowsePack } from "./marketplace-install.js";
import type { MarketplaceSource } from "./marketplace-source-store.js";
import { isSafeBasename, isValidPackName } from "./pack-manifest.js";
import type { PackManifest } from "./pack-types.js";

const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
// Registry ids become schema-2 `contents.mcp` list names, so they must satisfy
// pack-contributions' MCP_LIST_NAME_RE length limit as well as pack-dir safety.
const MAX_REGISTRY_INSTALL_ID_LENGTH = 64;
const DEFAULT_REGISTRY_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_REGISTRY_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_SOURCE_URL = "https://registry.modelcontextprotocol.io/v0/servers";
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const NPM_VERSION_SPEC_RE = /^(?:[vV]?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?|[~^][vV]?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?|(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}|[A-Za-z][A-Za-z0-9._+-]{0,127})$/;
const WINDOWS_SHELL_UNSAFE_ARG_RE = /[\x00-\x1F\x7F&|<>^%"'`!()]/;
const SAFE_PLACEHOLDER_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export interface McpRegistryStdioTransport {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpRegistryHttpTransport {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

export type McpRegistryTransport = McpRegistryStdioTransport | McpRegistryHttpTransport;

export interface OfficialRepository {
	url?: string;
	source?: string;
	id?: string;
	[key: string]: unknown;
}

export interface McpRegistryServer {
	id: string;
	sourceKey: string;
	officialName: string;
	name: string;
	label?: string;
	description?: string;
	version?: string;
	homepage?: string;
	license?: string;
	repository?: OfficialRepository;
	registryMeta?: Record<string, unknown>;
	serverMeta?: Record<string, unknown>;
	transport: McpRegistryTransport;
	/** Exact runtime config produced from transport. */
	config: McpServerConfig;
	/** Stable hash over runtime config and catalogue metadata used for update detection. */
	fingerprint: string;
}

export interface McpRegistrySkippedEntry {
	id?: string;
	name?: string;
	reason: string;
}

export interface McpRegistryParseResult {
	servers: McpRegistryServer[];
	skipped: McpRegistrySkippedEntry[];
}

export interface FetchMcpRegistryOptions {
	timeoutMs?: number;
	maxBodyBytes?: number;
	fetchFn?: typeof fetch;
}

export type McpRegistryBrowsePack = BrowsePack & {
	virtual: true;
	sourceType: "mcp-registry";
	registryId: string;
	serverName: string;
};

export interface MaterializeRegistryPackOptions {
	sourceUrl?: string;
	materializedAt?: string;
}

interface Candidate {
	variant: string;
	transport: McpRegistryTransport;
	config: McpServerConfig;
	descriptor: Record<string, unknown>;
}

interface NormalizedOfficialMetadata {
	officialName: string;
	label?: string;
	description?: string;
	version?: string;
	homepage?: string;
	license?: string;
	repository?: OfficialRepository;
	registryMeta?: Record<string, unknown>;
	serverMeta?: Record<string, unknown>;
}

export class McpRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpRegistryError";
	}
}

export function isMcpRegistrySource(source: MarketplaceSource): boolean {
	return source.type === "mcp-registry";
}

export async function fetchMcpRegistry(source: MarketplaceSource, opts?: FetchMcpRegistryOptions): Promise<McpRegistryServer[]> {
	return (await fetchMcpRegistryWithDiagnostics(source, opts)).servers;
}

export async function fetchMcpRegistryWithDiagnostics(source: MarketplaceSource, opts: FetchMcpRegistryOptions = {}): Promise<McpRegistryParseResult> {
	if (!isMcpRegistrySource(source)) throw new McpRegistryError(`source is not an MCP registry: ${source.id}`);
	if (source.ref) throw new McpRegistryError("mcp-registry sources do not support ref");
	let url: URL;
	try {
		url = new URL(source.url);
	} catch {
		throw new McpRegistryError(`invalid registry URL: ${source.url}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new McpRegistryError("mcp-registry source URL must use http or https");
	}
	const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_REGISTRY_MAX_BODY_BYTES;
	if (!Number.isFinite(maxBodyBytes) || maxBodyBytes < 1) throw new McpRegistryError("registry max body size must be positive");
	const timeoutMs = opts.timeoutMs ?? DEFAULT_REGISTRY_FETCH_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new McpRegistryError("registry fetch timeout must be positive");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await (opts.fetchFn ?? fetch)(url, { headers: { accept: "application/json" }, signal: controller.signal });
		if (!response.ok) throw new McpRegistryError(`registry fetch failed: HTTP ${response.status}`);
		const declaredLength = response.headers.get("content-length");
		if (declaredLength !== null) {
			const length = Number(declaredLength);
			if (!Number.isFinite(length) || length < 0) throw new McpRegistryError(`registry response has invalid Content-Length: ${declaredLength}`);
			if (length > maxBodyBytes) throw new McpRegistryError(`registry response Content-Length ${length} exceeds limit ${maxBodyBytes}`);
		}
		let body: unknown;
		try {
			body = JSON.parse(await readResponseTextBounded(response, maxBodyBytes));
		} catch (err) {
			if (err instanceof McpRegistryError) throw err;
			if (controller.signal.aborted) throw new McpRegistryError(`registry fetch timed out after ${timeoutMs}ms`);
			throw new McpRegistryError(`registry response is not valid JSON: ${String(err)}`);
		}
		return parseMcpRegistryDocument(body, source.url);
	} catch (err) {
		if (err instanceof McpRegistryError) throw err;
		if (controller.signal.aborted) throw new McpRegistryError(`registry fetch timed out after ${timeoutMs}ms`);
		throw new McpRegistryError(`registry fetch failed: ${String(err)}`);
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
				throw new McpRegistryError(`registry response body exceeds limit ${maxBytes}`);
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

export function parseMcpRegistryDocument(raw: unknown, sourceUrl = DEFAULT_SOURCE_URL): McpRegistryParseResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new McpRegistryError("registry document must be a JSON object");
	}
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion === 1) throw unsupportedFormatError();
	if (!Array.isArray(doc.servers)) throw unsupportedFormatError();
	for (const entry of doc.servers) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("server" in entry) || !(entry as Record<string, unknown>).server || typeof (entry as Record<string, unknown>).server !== "object" || Array.isArray((entry as Record<string, unknown>).server)) {
			throw unsupportedFormatError();
		}
	}

	const servers: McpRegistryServer[] = [];
	const skipped: McpRegistrySkippedEntry[] = [];
	const seenIds = new Set<string>();
	const seenNames = new Map<string, string>();
	for (const entry of doc.servers) {
		let normalized: McpRegistryServer[];
		try {
			const result = normalizeOfficialEntry(entry, sourceUrl);
			normalized = result.servers;
			skipped.push(...result.skipped);
		} catch (err) {
			const server = (entry as Record<string, unknown>).server as Record<string, unknown>;
			skipped.push({
				name: typeof server.name === "string" ? server.name : undefined,
				reason: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		for (const server of normalized) {
			if (seenIds.has(server.id)) {
				skipped.push({ id: server.id, name: server.officialName, reason: `duplicate registry id: ${server.id}` });
				continue;
			}
			const configFingerprint = stableStringify(server.config);
			const priorConfigFingerprint = seenNames.get(server.name);
			if (priorConfigFingerprint && priorConfigFingerprint !== configFingerprint) {
				skipped.push({ id: server.id, name: server.officialName, reason: `duplicate runtime server name with different config: ${server.name}` });
				continue;
			}
			seenIds.add(server.id);
			seenNames.set(server.name, configFingerprint);
			servers.push(server);
		}
	}
	return { servers, skipped };
}

function unsupportedFormatError(): McpRegistryError {
	return new McpRegistryError("unsupported MCP registry format: expected official MCP Registry API response with servers[].server");
}

export function registryServerToVirtualPack(server: McpRegistryServer): McpRegistryBrowsePack {
	const packName = registryPackName(server.id);
	if (!isValidPackName(packName)) throw new McpRegistryError(`generated pack name is unsafe: ${packName}`);
	const mcpEntry = registryServerToMcpWire(server);
	return {
		schema: 2,
		name: packName,
		description: server.description || server.label || `${server.officialName} MCP server`,
		version: server.version || "0.0.0",
		homepage: server.homepage,
		contents: { roles: [], tools: [], skills: [], entrypoints: [], mcp: [server.id] },
		dirName: packName,
		hasTools: false,
		virtual: true,
		sourceType: "mcp-registry",
		registryId: server.id,
		serverName: server.name,
		mcp: [mcpEntry],
		mcpServers: [mcpEntry],
	};
}

function registryServerToMcpWire(server: McpRegistryServer): Record<string, unknown> {
	const base: Record<string, unknown> = {
		ref: server.id,
		listName: server.id,
		serverName: server.name,
		transport: server.transport.type,
	};
	if (server.label) base.label = server.label;
	if (server.description) base.description = server.description;
	if (server.transport.type === "stdio") {
		base.command = server.transport.command;
		if (server.transport.args) base.args = server.transport.args;
		if (server.transport.cwd) base.cwd = server.transport.cwd;
		if (server.transport.env) base.env = Object.keys(server.transport.env);
	} else {
		base.url = server.transport.url;
		if (server.transport.headers) base.headers = Object.keys(server.transport.headers);
	}
	return base;
}

export function materializeRegistryPack(server: McpRegistryServer, destOrStagingDir: string, opts: MaterializeRegistryPackOptions = {}): PackManifest {
	const root = path.resolve(destOrStagingDir);
	const manifest = registryServerToVirtualPack(server);
	fs.mkdirSync(root, { recursive: true });
	const mcpDir = path.join(root, "mcp");
	const packYamlPath = path.join(root, "pack.yaml");
	const mcpYamlPath = path.join(mcpDir, `${server.id}.yaml`);
	const metaPath = path.join(root, ".pack-meta.yaml");
	for (const target of [packYamlPath, mcpDir, mcpYamlPath, metaPath]) {
		if (!isPackPathWithinRoot(root, target)) throw new McpRegistryError(`materialized path escapes pack root: ${target}`);
	}
	fs.mkdirSync(mcpDir, { recursive: true });
	if (server.transport.type === "stdio" && server.transport.cwd) {
		const cwdDir = path.resolve(root, server.transport.cwd);
		if (!isPackPathWithinRoot(root, cwdDir)) throw new McpRegistryError(`materialized cwd escapes pack root: ${server.transport.cwd}`);
		fs.mkdirSync(cwdDir, { recursive: true });
	}
	fs.writeFileSync(packYamlPath, stringify(stripUndefined({
		schema: 2,
		name: manifest.name,
		description: manifest.description,
		version: manifest.version,
		homepage: manifest.homepage,
		contents: manifest.contents,
	})), "utf-8");
	fs.writeFileSync(mcpYamlPath, stringify(stripUndefined({
		server: server.name,
		label: server.label,
		description: server.description,
		transport: server.transport,
	})), "utf-8");
	fs.writeFileSync(metaPath, stringify(stripUndefined({
		sourceType: "mcp-registry",
		sourceUrl: opts.sourceUrl,
		sourceKey: server.sourceKey,
		registryId: server.id,
		registryName: server.name,
		officialName: server.officialName,
		registryVersion: server.version,
		registryFingerprint: server.fingerprint,
		materializedAt: opts.materializedAt || new Date().toISOString(),
		label: server.label,
		description: server.description,
		homepage: server.homepage,
		license: server.license,
		repository: server.repository,
		registryMeta: server.registryMeta,
		serverMeta: server.serverMeta,
	})), "utf-8");
	return manifest;
}

export function registryPackNameForId(id: string): string {
	return `mcp-${id}`;
}

function registryPackName(id: string): string {
	return registryPackNameForId(id);
}

export function officialRegistrySourceKey(sourceUrl: string): string {
	return crypto.createHash("sha256").update(canonicalSourceUrl(sourceUrl)).digest("hex").slice(0, 9);
}

export function officialRegistryInstallId(input: { officialName: string; version?: string; sourceUrl: string; variant?: string }): string {
	const sourceKey = officialRegistrySourceKey(input.sourceUrl);
	const parts = [input.officialName, input.version, input.variant].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
	const human = slugify(parts.join("-"));
	let id = `${human}-${sourceKey}`;
	if (isSafeInstallId(id)) return id;
	const hash = crypto.createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 8);
	const maxHuman = Math.max(8, MAX_REGISTRY_INSTALL_ID_LENGTH - sourceKey.length - hash.length - 2);
	id = `${truncateSlug(human, maxHuman)}-${hash}-${sourceKey}`;
	if (!isSafeInstallId(id)) throw new McpRegistryError(`generated registry install id is unsafe: ${id}`);
	return id;
}

export function officialRegistryRuntimeName(input: { officialName: string; version?: string; sourceUrl: string; installId: string }): string {
	const suffix = crypto.createHash("sha256").update(`${input.installId}:${canonicalSourceUrl(input.sourceUrl)}`).digest("hex").slice(0, 8);
	const base = slugify([input.officialName, input.version].filter(Boolean).join("-"));
	const runtime = `${truncateSlug(base, 63 - suffix.length - 1)}-${suffix}`;
	if (!MCP_SERVER_NAME_RE.test(runtime)) throw new McpRegistryError(`generated runtime server name is unsafe: ${runtime}`);
	return runtime;
}

function normalizeOfficialEntry(entry: unknown, sourceUrl: string): { servers: McpRegistryServer[]; skipped: McpRegistrySkippedEntry[] } {
	const wrapper = entry as Record<string, unknown>;
	const serverRaw = wrapper.server as Record<string, unknown>;
	const metadata = normalizeOfficialMetadata(serverRaw, wrapper);
	const candidates: Candidate[] = [];
	const skipped: McpRegistrySkippedEntry[] = [];

	const remotes = serverRaw.remotes === undefined ? [] : asArray(serverRaw.remotes, "remotes");
	remotes.forEach((remote, index) => {
		try {
			candidates.push(candidateFromRemote(remote, index));
		} catch (err) {
			const variant = `remote-${index + 1}`;
			skipped.push({
				id: officialRegistryInstallId({ officialName: metadata.officialName, version: metadata.version, sourceUrl, variant }),
				name: metadata.officialName,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	});

	const packages = serverRaw.packages === undefined ? [] : asArray(serverRaw.packages, "packages");
	packages.forEach((pkg, index) => {
		try {
			candidates.push(candidateFromPackage(pkg, index));
		} catch (err) {
			const variant = packageVariant(pkg, index);
			skipped.push({
				id: officialRegistryInstallId({ officialName: metadata.officialName, version: metadata.version, sourceUrl, variant }),
				name: metadata.officialName,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	});

	if (candidates.length === 0 && skipped.length === 0) {
		skipped.push({ name: metadata.officialName, reason: "official registry server has no remotes[] or packages[] candidates" });
	}

	const sourceKey = officialRegistrySourceKey(sourceUrl);
	const servers = candidates.map((candidate) => {
		const id = officialRegistryInstallId({ officialName: metadata.officialName, version: metadata.version, sourceUrl, variant: candidate.variant });
		const packName = registryPackName(id);
		if (!isValidPackName(packName)) throw new McpRegistryError(`generated pack name is unsafe: ${packName}`);
		const name = officialRegistryRuntimeName({ officialName: metadata.officialName, version: metadata.version, sourceUrl, installId: id });
		const server: McpRegistryServer = {
			id,
			sourceKey,
			officialName: metadata.officialName,
			name,
			label: metadata.label,
			description: metadata.description,
			version: metadata.version,
			homepage: metadata.homepage,
			license: metadata.license,
			repository: metadata.repository,
			registryMeta: metadata.registryMeta,
			serverMeta: metadata.serverMeta,
			transport: candidate.transport,
			config: candidate.config,
			fingerprint: "",
		};
		server.fingerprint = fingerprintRegistryServer(server, sourceUrl, candidate.descriptor);
		return server;
	});
	return { servers, skipped };
}

function normalizeOfficialMetadata(server: Record<string, unknown>, wrapper: Record<string, unknown>): NormalizedOfficialMetadata {
	const officialName = requiredNonEmptyString(server.name, "official server name");
	const repository = normalizeRepository(server.repository);
	return {
		officialName,
		label: optionalNonEmptyString(server.title, "official server title"),
		description: optionalNonEmptyString(server.description, "official server description"),
		version: optionalNonEmptyString(server.version, "official server version"),
		homepage: optionalNonEmptyString(server.websiteUrl, "official server websiteUrl") || optionalNonEmptyString(repository?.url, "official server repository.url"),
		license: normalizeLicense(server.license),
		repository,
		registryMeta: normalizeMeta(wrapper._meta, "registry _meta"),
		serverMeta: normalizeMeta(server._meta, "server _meta"),
	};
}

function candidateFromRemote(raw: unknown, index: number): Candidate {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRegistryError("remote entry must be an object");
	const remote = raw as Record<string, unknown>;
	const type = typeof remote.type === "string" ? remote.type.trim() : "";
	if (type !== "streamable-http") throw new McpRegistryError(`unsupported remote transport: ${type || String(remote.type)} (Bobbit currently supports streamable-http)`);
	if (hasPromptOrVariableMarker(remote)) throw new McpRegistryError("remote variables/prompts are not supported; Marketplace registry installs require concrete remote settings");
	if (typeof remote.url !== "string" || !remote.url.trim()) throw new McpRegistryError("remote url is required for streamable-http transport");
	if (hasTemplateMarker(remote.url)) throw new McpRegistryError("remote url contains variables/templates; Marketplace registry installs require a concrete URL");
	const url = normalizeHttpUrl(remote.url);
	const headers = normalizeRemoteHeaders(remote.headers);
	const transport: McpRegistryHttpTransport = { type: "http", url };
	if (headers) transport.headers = headers;
	const config: McpServerConfig = { url };
	if (headers) config.headers = headers;
	return { variant: `remote-${index + 1}`, transport, config, descriptor: { kind: "remote", index, type, url, headers: headers ? Object.keys(headers).sort() : [] } };
}

function candidateFromPackage(raw: unknown, index: number): Candidate {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRegistryError("package entry must be an object");
	const pkg = raw as Record<string, unknown>;
	const registryType = typeof pkg.registryType === "string" ? pkg.registryType.trim().toLowerCase() : "";
	if (registryType !== "npm") throw new McpRegistryError(`unsupported package registryType: ${registryType || String(pkg.registryType)} (supported: npm)`);
	const transportRaw = pkg.transport;
	if (!transportRaw || typeof transportRaw !== "object" || Array.isArray(transportRaw) || (transportRaw as Record<string, unknown>).type !== "stdio") {
		throw new McpRegistryError("unsupported package transport: Bobbit currently supports npm packages with stdio transport");
	}
	if (pkg.runtimeHint !== undefined && pkg.runtimeHint !== "npx") throw new McpRegistryError(`unsupported npm runtimeHint: ${String(pkg.runtimeHint)} (supported: npx)`);
	if (Array.isArray(pkg.runtimeArguments) ? pkg.runtimeArguments.length > 0 : pkg.runtimeArguments !== undefined) throw new McpRegistryError("runtimeArguments are not supported for Marketplace registry installs yet");
	const identifier = requiredNonEmptyString(pkg.identifier, "npm package identifier");
	if (!NPM_PACKAGE_RE.test(identifier)) throw new McpRegistryError(`npm package identifier is invalid: ${identifier}`);
	const version = optionalNonEmptyString(pkg.version, "npm package version");
	if (version) validateNpmVersionSpec(version);
	const identifierWithVersion = version ? `${identifier}@${version}` : identifier;
	const packageArgs = normalizePackageArguments(pkg.packageArguments);
	const env = normalizePackageEnvironment(pkg.environmentVariables);
	const transport: McpRegistryStdioTransport = { type: "stdio", command: "npx", args: ["-y", identifierWithVersion, ...packageArgs] };
	if (env) transport.env = env;
	const config: McpServerConfig = { command: transport.command, args: transport.args };
	if (env) config.env = env;
	return { variant: packageVariant(pkg, index), transport, config, descriptor: { kind: "package", index, registryType, identifier, version, args: packageArgs, env: env ? Object.keys(env).sort() : [] } };
}

function normalizeRemoteHeaders(raw: unknown): Record<string, string> | undefined {
	if (raw === undefined) return undefined;
	const out: Record<string, string> = {};
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new McpRegistryError("remote headers must be concrete string values or descriptors with literal values");
			const header = entry as Record<string, unknown>;
			const name = requiredNonEmptyString(header.name, "remote header name");
			validateHeaderName(name, "remote header");
			if (hasPromptOrVariableMarker(header)) throw new McpRegistryError(`remote ${name} header requires a user-supplied value; Marketplace registry installs do not prompt for header values yet`);
			if (typeof header.value !== "string") throw new McpRegistryError(`remote ${name} header requires a user-supplied value; Marketplace registry installs do not prompt for header values yet`);
			if (hasTemplateMarker(header.value)) throw new McpRegistryError(`remote ${name} header contains variables/templates; Marketplace registry installs require concrete header values`);
			out[name] = header.value;
		}
	} else if (raw && typeof raw === "object") {
		for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
			validateHeaderName(name, "remote header");
			if (typeof value === "string") {
				if (hasTemplateMarker(value)) throw new McpRegistryError(`remote ${name} header contains variables/templates; Marketplace registry installs require concrete header values`);
				out[name] = value;
				continue;
			}
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const descriptor = value as Record<string, unknown>;
				if (hasPromptOrVariableMarker(descriptor)) throw new McpRegistryError(`remote ${name} header requires a user-supplied value; Marketplace registry installs do not prompt for header values yet`);
				if (typeof descriptor.value === "string") {
					if (hasTemplateMarker(descriptor.value)) throw new McpRegistryError(`remote ${name} header contains variables/templates; Marketplace registry installs require concrete header values`);
					out[name] = descriptor.value;
					continue;
				}
			}
			throw new McpRegistryError(`remote ${name} header requires a user-supplied value; Marketplace registry installs do not prompt for header values yet`);
		}
	} else {
		throw new McpRegistryError("remote headers must be an object or array");
	}
	return Object.keys(out).length ? out : undefined;
}

function normalizePackageArguments(raw: unknown): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new McpRegistryError("packageArguments must be an array; only fixed value arguments are supported");
	const args: string[] = [];
	for (const item of raw) {
		if (typeof item === "string") {
			if (item.includes("${")) throw variablePackageArgumentsError();
			validateFixedPackageArgString(item, "packageArguments value");
			args.push(item);
			continue;
		}
		if (!item || typeof item !== "object" || Array.isArray(item)) throw variablePackageArgumentsError();
		const arg = item as Record<string, unknown>;
		if (hasPromptOrVariableMarker(arg)) throw variablePackageArgumentsError();
		const value = arg.value ?? arg.default;
		if (value === undefined) throw variablePackageArgumentsError();
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw variablePackageArgumentsError();
		const stringValue = String(value);
		if (stringValue.includes("${")) throw variablePackageArgumentsError();
		validateFixedPackageArgString(stringValue, "packageArguments value");
		const name = optionalNonEmptyString(arg.name, "package argument name");
		if (name) {
			validateCliArgName(name);
			if (value === true) args.push(name);
			else if (value !== false) args.push(name, stringValue);
		} else if (value !== false) {
			args.push(stringValue);
		}
	}
	return args;
}

function variablePackageArgumentsError(): McpRegistryError {
	return new McpRegistryError("packageArguments contain variables/prompts; only fixed value arguments are supported");
}

function normalizePackageEnvironment(raw: unknown): Record<string, string> | undefined {
	if (raw === undefined) return undefined;
	const env: Record<string, string> = {};
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new McpRegistryError("environmentVariables entries must be objects");
			const entry = item as Record<string, unknown>;
			const name = requiredNonEmptyString(entry.name, "environment variable name");
			validateEnvName(name);
			if (hasPromptOrVariableMarker(entry)) throw new McpRegistryError(`environment variable ${name} contains variables/prompts; only literal defaults or whole-value \${NAME} placeholders are supported`);
			const value = entry.default ?? entry.value;
			if (typeof value !== "string") throw new McpRegistryError(`environment variable ${name} requires a default or safe placeholder value`);
			if ((entry.isSecret === true || entry.secret === true) && !SAFE_PLACEHOLDER_RE.test(value)) throw new McpRegistryError(`environment variable ${name} is secret and must use a safe placeholder value`);
			if (hasTemplateMarker(value, { allowWholeEnvPlaceholder: true })) throw new McpRegistryError(`environment variable ${name} contains variables/templates; use a literal value or a whole-value \${NAME} placeholder`);
			env[name] = value;
		}
	} else if (raw && typeof raw === "object") {
		for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
			validateEnvName(name);
			if (value && typeof value === "object" && !Array.isArray(value) && hasPromptOrVariableMarker(value as Record<string, unknown>)) throw new McpRegistryError(`environment variable ${name} contains variables/prompts; only literal defaults or whole-value \${NAME} placeholders are supported`);
			if (typeof value !== "string") throw new McpRegistryError(`environment variable ${name} requires a string value`);
			if (hasTemplateMarker(value, { allowWholeEnvPlaceholder: true })) throw new McpRegistryError(`environment variable ${name} contains variables/templates; use a literal value or a whole-value \${NAME} placeholder`);
			env[name] = value;
		}
	} else {
		throw new McpRegistryError("environmentVariables must be an array or object");
	}
	return Object.keys(env).length ? env : undefined;
}

function hasPromptOrVariableMarker(arg: Record<string, unknown>): boolean {
	if (arg.variables !== undefined || arg.variable !== undefined || arg.prompt !== undefined || arg.prompts !== undefined || arg.valueHint !== undefined) return true;
	if (arg.isRequired === true && arg.value === undefined && arg.default === undefined) return true;
	return false;
}

function hasTemplateMarker(value: string, opts: { allowWholeEnvPlaceholder?: boolean } = {}): boolean {
	if (opts.allowWholeEnvPlaceholder && SAFE_PLACEHOLDER_RE.test(value)) return false;
	return value.includes("${") || /\{[^}]+\}/.test(value) || value.includes("}");
}

function packageVariant(pkg: unknown, index: number): string {
	const identifier = pkg && typeof pkg === "object" && !Array.isArray(pkg) && typeof (pkg as Record<string, unknown>).identifier === "string" ? (pkg as Record<string, unknown>).identifier as string : "";
	const identifierSlug = identifier ? slugify(identifier) : "";
	return identifierSlug ? `npm-${identifierSlug}` : `npm-${index + 1}`;
}

function canonicalSourceUrl(sourceUrl: string): string {
	try {
		const url = new URL(sourceUrl);
		url.hash = "";
		url.protocol = url.protocol.toLowerCase();
		url.hostname = url.hostname.toLowerCase();
		return url.toString();
	} catch {
		return sourceUrl.trim();
	}
}

function slugify(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	return slug || "server";
}

function truncateSlug(slug: string, maxLength: number): string {
	if (slug.length <= maxLength) return slug;
	return slug.slice(0, maxLength).replace(/-+$/g, "") || "server";
}

function isSafeInstallId(id: string): boolean {
	return id.length <= MAX_REGISTRY_INSTALL_ID_LENGTH && isSafeBasename(id) && isValidPackName(registryPackNameForId(id));
}

function normalizeHttpUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new McpRegistryError(`http transport url is invalid: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new McpRegistryError("http transport url must use http or https");
	if (url.username || url.password) throw new McpRegistryError("http transport url must not include credentials");
	if (url.hash) throw new McpRegistryError("http transport url must not include a fragment");
	return url.toString();
}

function asArray(raw: unknown, label: string): unknown[] {
	if (!Array.isArray(raw)) throw new McpRegistryError(`official registry ${label} must be an array`);
	return raw;
}

function requiredNonEmptyString(raw: unknown, label: string): string {
	if (typeof raw !== "string" || !raw.trim()) throw new McpRegistryError(`${label} is required`);
	return raw.trim();
}

function optionalNonEmptyString(raw: unknown, label: string): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "string" || !raw.trim()) throw new McpRegistryError(`${label} must be a non-empty string`);
	return raw.trim();
}

function normalizeRepository(raw: unknown): OfficialRepository | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRegistryError("official server repository must be an object");
	return raw as OfficialRepository;
}

function normalizeLicense(raw: unknown): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "string") return raw.trim() || undefined;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const license = raw as Record<string, unknown>;
		return optionalNonEmptyString(license.name, "official server license.name") || optionalNonEmptyString(license.id, "official server license.id");
	}
	throw new McpRegistryError("official server license must be a string or object");
}

function normalizeMeta(raw: unknown, label: string): Record<string, unknown> | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRegistryError(`${label} must be an object`);
	return raw as Record<string, unknown>;
}

function validateHeaderName(name: string, label: string): void {
	if (!HEADER_NAME_RE.test(name)) throw new McpRegistryError(`${label} contains an invalid key`);
}

function validateEnvName(name: string): void {
	if (!ENV_NAME_RE.test(name)) throw new McpRegistryError(`environment variable name is invalid: ${name}`);
}

function validateNpmVersionSpec(version: string): void {
	if (!NPM_VERSION_SPEC_RE.test(version) || WINDOWS_SHELL_UNSAFE_ARG_RE.test(version) || /\s/.test(version)) {
		throw new McpRegistryError("npm package version is invalid: only safe npm versions, dist-tags, or specs without Windows shell metacharacters are supported");
	}
}

function validateCliArgName(name: string): void {
	if (/\s/.test(name)) throw new McpRegistryError("package argument name must not contain whitespace");
	validateFixedPackageArgString(name, "package argument name");
}

function validateFixedPackageArgString(value: string, label: string): void {
	if (WINDOWS_SHELL_UNSAFE_ARG_RE.test(value)) {
		throw new McpRegistryError(`${label} contains unsafe Windows shell metacharacters or control characters; only fixed cmd-safe package arguments are supported`);
	}
}

function fingerprintRegistryServer(server: Omit<McpRegistryServer, "fingerprint">, sourceUrl: string, candidate: Record<string, unknown>): string {
	return crypto.createHash("sha256").update(stableStringify({
		sourceUrl: canonicalSourceUrl(sourceUrl),
		sourceKey: server.sourceKey,
		id: server.id,
		officialName: server.officialName,
		name: server.name,
		label: server.label,
		description: server.description,
		version: server.version,
		homepage: server.homepage,
		license: server.license,
		repository: server.repository,
		registryMeta: server.registryMeta,
		serverMeta: server.serverMeta,
		candidate,
		config: server.config,
	})).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function stripUndefined<T>(value: T): T {
	if (Array.isArray(value)) return value.map(stripUndefined) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (item !== undefined) out[key] = stripUndefined(item);
		}
		return out as T;
	}
	return value;
}
