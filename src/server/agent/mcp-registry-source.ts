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
const WINDOWS_DEVICE_NAMES = new Set(["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);
const TOP_KEYS = new Set(["schemaVersion", "generatedAt", "servers"]);
const SERVER_KEYS = new Set(["id", "name", "label", "description", "version", "homepage", "license", "publisher", "transport"]);
const STDIO_KEYS = new Set(["type", "command", "args", "env", "cwd"]);
const HTTP_KEYS = new Set(["type", "url", "headers"]);

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

export interface McpRegistryServer {
	id: string;
	name: string;
	label?: string;
	description?: string;
	version?: string;
	homepage?: string;
	license?: string;
	publisher?: string;
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

export class McpRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpRegistryError";
	}
}

export function isMcpRegistrySource(source: MarketplaceSource): boolean {
	return source.type === "mcp-registry";
}

export async function fetchMcpRegistry(source: MarketplaceSource): Promise<McpRegistryServer[]> {
	return (await fetchMcpRegistryWithDiagnostics(source)).servers;
}

export async function fetchMcpRegistryWithDiagnostics(source: MarketplaceSource): Promise<McpRegistryParseResult> {
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
	const response = await fetch(url, { headers: { accept: "application/json" } });
	if (!response.ok) throw new McpRegistryError(`registry fetch failed: HTTP ${response.status}`);
	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		throw new McpRegistryError(`registry response is not valid JSON: ${String(err)}`);
	}
	return parseMcpRegistryDocument(body);
}

export function parseMcpRegistryDocument(raw: unknown): McpRegistryParseResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new McpRegistryError("registry document must be a JSON object");
	}
	const doc = raw as Record<string, unknown>;
	for (const key of Object.keys(doc)) {
		if (!TOP_KEYS.has(key)) throw new McpRegistryError(`registry document has unknown key: ${key}`);
	}
	if (doc.schemaVersion !== 1) throw new McpRegistryError("registry document must declare schemaVersion: 1");
	if (!Array.isArray(doc.servers)) throw new McpRegistryError("registry document must include servers[]");

	const servers: McpRegistryServer[] = [];
	const skipped: McpRegistrySkippedEntry[] = [];
	const seenIds = new Set<string>();
	const seenNames = new Map<string, string>();
	for (const entry of doc.servers) {
		let server: McpRegistryServer;
		try {
			server = normalizeRegistryServer(entry);
		} catch (err) {
			const e = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
			skipped.push({
				id: typeof e.id === "string" ? e.id : undefined,
				name: typeof e.name === "string" ? e.name : undefined,
				reason: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		if (seenIds.has(server.id)) {
			skipped.push({ id: server.id, name: server.name, reason: `duplicate registry id: ${server.id}` });
			continue;
		}
		const configFingerprint = stableStringify(server.config);
		const priorConfigFingerprint = seenNames.get(server.name);
		if (priorConfigFingerprint && priorConfigFingerprint !== configFingerprint) {
			skipped.push({ id: server.id, name: server.name, reason: `duplicate runtime server name with different config: ${server.name}` });
			continue;
		}
		seenIds.add(server.id);
		seenNames.set(server.name, configFingerprint);
		servers.push(server);
	}
	return { servers, skipped };
}

export function registryServerToVirtualPack(server: McpRegistryServer): McpRegistryBrowsePack {
	const packName = registryPackName(server.id);
	if (!isValidPackName(packName)) throw new McpRegistryError(`generated pack name is unsafe: ${packName}`);
	return {
		schema: 2,
		name: packName,
		description: server.description || server.label || `${server.name} MCP server`,
		version: server.version || "0.0.0",
		homepage: server.homepage,
		contents: { roles: [], tools: [], skills: [], entrypoints: [], mcp: [server.id] },
		dirName: packName,
		hasTools: false,
		virtual: true,
		sourceType: "mcp-registry",
		registryId: server.id,
		serverName: server.name,
	};
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
		registryId: server.id,
		registryName: server.name,
		registryVersion: server.version,
		registryFingerprint: server.fingerprint,
		materializedAt: opts.materializedAt || new Date().toISOString(),
		label: server.label,
		description: server.description,
		homepage: server.homepage,
		license: server.license,
		publisher: server.publisher,
	})), "utf-8");
	return manifest;
}

function normalizeRegistryServer(raw: unknown): McpRegistryServer {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRegistryError("registry server entry must be an object");
	const r = raw as Record<string, unknown>;
	for (const key of Object.keys(r)) {
		if (!SERVER_KEYS.has(key)) throw new McpRegistryError(`registry server has unknown key: ${key}`);
	}
	const id = normalizeRegistryId(r.id);
	const packName = registryPackName(id);
	if (!isValidPackName(packName)) throw new McpRegistryError(`generated pack name is unsafe: ${packName}`);
	const name = normalizeServerName(r.name);
	const { transport, config } = normalizeTransport(r.transport);
	const server: McpRegistryServer = {
		id,
		name,
		transport,
		config,
		fingerprint: "",
	};
	for (const key of ["label", "description", "version", "homepage", "license", "publisher"] as const) {
		if (r[key] !== undefined) {
			if (typeof r[key] !== "string" || !(r[key] as string).trim()) throw new McpRegistryError(`registry server ${key} must be a non-empty string`);
			(server as unknown as Record<string, string>)[key] = (r[key] as string).trim();
		}
	}
	server.fingerprint = fingerprintRegistryServer(server);
	return server;
}

function registryPackName(id: string): string {
	return `mcp-${id}`;
}

function normalizeRegistryId(raw: unknown): string {
	if (typeof raw !== "string") throw new McpRegistryError("registry server id is required");
	const id = raw.trim();
	if (id.length < 1 || id.length > 64) throw new McpRegistryError("registry server id length must be 1-64");
	if (!isSafeBasename(id) || id === "." || id === ".." || id.startsWith(".")) throw new McpRegistryError(`registry server id is not a safe basename: ${JSON.stringify(raw)}`);
	if (WINDOWS_DEVICE_NAMES.has(id.split(".")[0].toUpperCase())) throw new McpRegistryError(`registry server id uses a Windows device name: ${id}`);
	return id;
}

function normalizeServerName(raw: unknown): string {
	if (typeof raw !== "string") throw new McpRegistryError("registry server name is required");
	const name = raw.trim();
	if (!MCP_SERVER_NAME_RE.test(name) || name.includes("__") || name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") {
		throw new McpRegistryError(`registry server name is unsafe: ${JSON.stringify(raw)}`);
	}
	if (name.replace(/[^A-Za-z0-9]+/g, "").length === 0) throw new McpRegistryError(`registry server name normalizes to an empty tool name: ${name}`);
	return name;
}

function normalizeTransport(raw: unknown): { transport: McpRegistryTransport; config: McpServerConfig } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRegistryError("transport is required");
	const t = raw as Record<string, unknown>;
	if (t.type === "stdio") {
		for (const key of Object.keys(t)) if (!STDIO_KEYS.has(key)) throw new McpRegistryError(`stdio transport has unknown key: ${key}`);
		if (typeof t.command !== "string" || !t.command.trim()) throw new McpRegistryError("stdio transport command is required");
		const transport: McpRegistryStdioTransport = { type: "stdio", command: t.command.trim() };
		const args = optionalStringArray(t.args, "stdio transport args");
		if (args) transport.args = args;
		const env = optionalStringRecord(t.env, "stdio transport env");
		if (env) transport.env = env;
		if (t.cwd !== undefined) transport.cwd = normalizeRelativeCwd(t.cwd);
		const config: McpServerConfig = { command: transport.command };
		if (transport.args) config.args = transport.args;
		if (transport.env) config.env = transport.env;
		if (transport.cwd) config.cwd = transport.cwd;
		return { transport, config };
	}
	if (t.type === "http") {
		for (const key of Object.keys(t)) if (!HTTP_KEYS.has(key)) throw new McpRegistryError(`http transport has unknown key: ${key}`);
		if (typeof t.url !== "string" || !t.url.trim()) throw new McpRegistryError("http transport url is required");
		const url = normalizeHttpUrl(t.url);
		const headers = optionalStringRecord(t.headers, "http transport headers");
		const transport: McpRegistryHttpTransport = { type: "http", url };
		if (headers) transport.headers = headers;
		const config: McpServerConfig = { url };
		if (headers) config.headers = headers;
		return { transport, config };
	}
	throw new McpRegistryError(`unsupported transport type: ${String(t.type)}`);
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

function normalizeRelativeCwd(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) throw new McpRegistryError("stdio transport cwd must be a non-empty string");
	const cwd = raw.trim();
	if (cwd.includes("\0") || cwd.includes("..") || path.isAbsolute(cwd) || /^[A-Za-z]:[\\/]/.test(cwd) || /^[a-z][a-z0-9+.-]*:/i.test(cwd)) {
		throw new McpRegistryError(`stdio transport cwd must be relative and contained: ${JSON.stringify(raw)}`);
	}
	const normalized = path.posix.normalize(cwd.replace(/\\/g, "/"));
	if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) throw new McpRegistryError(`stdio transport cwd escapes pack root: ${raw}`);
	return normalized;
}

function optionalStringArray(raw: unknown, label: string): string[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) throw new McpRegistryError(`${label} must be an array of strings`);
	return raw.map((item) => {
		if (typeof item !== "string") throw new McpRegistryError(`${label} must be an array of strings`);
		return item;
	});
}

function optionalStringRecord(raw: unknown, label: string): Record<string, string> | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRegistryError(`${label} must be an object of string values`);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!key || key.includes("\0") || key.includes("\n") || key.includes("\r")) throw new McpRegistryError(`${label} contains an invalid key`);
		if (typeof value !== "string") throw new McpRegistryError(`${label} values must be strings`);
		out[key] = value;
	}
	return out;
}

function fingerprintRegistryServer(server: Omit<McpRegistryServer, "fingerprint">): string {
	return crypto.createHash("sha256").update(stableStringify({
		id: server.id,
		name: server.name,
		label: server.label,
		description: server.description,
		version: server.version,
		homepage: server.homepage,
		license: server.license,
		publisher: server.publisher,
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
