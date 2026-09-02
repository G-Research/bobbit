import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bobbitStateDir } from "../bobbit-dir.js";

/** Schema for content-addressed, winner-filtered tool extension adapters. */
export const TOOL_EXTENSION_ADAPTER_SCHEMA_VERSION = 1;
/** Spawn environment containing adapter id -> runtime target URL mappings. */
export const TOOL_EXTENSION_TARGETS_ENV = "BOBBIT_TOOL_EXTENSION_TARGETS";
/** State directory whose children are immutable content-addressed adapters. */
export const TOOL_EXTENSION_ADAPTER_STATE_DIR = "tool-extension-activation";
export const TOOL_EXTENSION_ADAPTER_MANIFEST = "manifest.json";
export const TOOL_EXTENSION_ADAPTER_ENTRY = "extension.ts";

export interface CapturedToolExtensionTarget {
	/** Native physical path retained for the runtime import URL. */
	physicalPath: string;
	/** Separator-normalized, platform-case-normalized identity of physicalPath. */
	targetIdentity: string;
}

export interface ToolExtensionTargetPlan {
	/** Lexical extension path used to report the first encountered alias. */
	targetPath: string;
	/** Canonical target captured while the plan is grouped, when available. */
	capturedTarget?: CapturedToolExtensionTarget;
	/** Encounter-ordered path aliases resolving to the same physical target. */
	targetAliases?: string[];
	/** Exact winning catalogue names assigned to this extension, in encounter order. */
	allowedToolNames: string[];
}

export interface ToolExtensionAdapterManifest {
	schemaVersion: number;
	adapterId: string;
	targetIdentity: string;
	targetAliases: string[];
	allowedToolNames: string[];
	generatedSourceSha256: string;
}

export interface MaterializedToolExtensionAdapter {
	adapterPath: string;
	adapterId: string;
	targetUrl: string;
	manifest: ToolExtensionAdapterManifest;
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined) return JSON.stringify(value ?? null);
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function identityForPhysicalPath(physicalPath: string): string {
	const normalized = process.platform === "win32" ? physicalPath.toLowerCase() : physicalPath;
	return normalized.replaceAll("\\", "/");
}

/** Resolve an extension path once, retaining both executable spelling and comparison identity. */
export function captureToolExtensionTarget(targetPath: string): CapturedToolExtensionTarget {
	const physicalPath = fs.realpathSync.native(path.resolve(targetPath));
	return { physicalPath, targetIdentity: identityForPhysicalPath(physicalPath) };
}

/** Stable identity used to group aliases that resolve to the same physical extension file. */
export function toolExtensionTargetIdentity(target: string | CapturedToolExtensionTarget): string {
	return typeof target === "string"
		? captureToolExtensionTarget(target).targetIdentity
		: target.targetIdentity;
}

function lexicalPathIdentity(targetPath: string): string {
	const resolved = path.resolve(targetPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function addAllowedToolName(plan: ToolExtensionTargetPlan, canonicalName: string): void {
	if (!plan.allowedToolNames.some((name) => name.toLowerCase() === canonicalName.toLowerCase())) {
		plan.allowedToolNames.push(canonicalName);
	}
}

/**
 * Add one winning tool to a physical-target plan. Repeated lexical paths reuse
 * the plan's capture; a new lexical alias is resolved once to prove identity.
 */
export function planToolExtensionTarget(
	plans: Map<string, ToolExtensionTargetPlan>,
	targetPath: string,
	canonicalName: string,
): void {
	const alias = path.resolve(targetPath);
	const aliasIdentity = lexicalPathIdentity(alias);
	for (const plan of plans.values()) {
		if ([plan.targetPath, ...(plan.targetAliases ?? [])].some((candidate) => lexicalPathIdentity(candidate) === aliasIdentity)) {
			addAllowedToolName(plan, canonicalName);
			return;
		}
	}

	const capturedTarget = captureToolExtensionTarget(alias);
	let plan = plans.get(toolExtensionTargetIdentity(capturedTarget));
	if (!plan) {
		plan = { targetPath: alias, capturedTarget, targetAliases: [alias], allowedToolNames: [] };
		plans.set(capturedTarget.targetIdentity, plan);
	} else if (!plan.targetAliases?.some((candidate) => lexicalPathIdentity(candidate) === aliasIdentity)) {
		plan.targetAliases = [...(plan.targetAliases ?? []), alias];
	}
	addAllowedToolName(plan, canonicalName);
}

function adapterSource(adapterId: string): string {
	return `const __bobbitAdapterId = ${JSON.stringify(adapterId)};
const __bobbitTargetsEnv = ${JSON.stringify(TOOL_EXTENSION_TARGETS_ENV)};
const __bobbitRawTargets = process.env[__bobbitTargetsEnv];
if (!__bobbitRawTargets) throw new Error("Missing " + __bobbitTargetsEnv + " for filtered tool extension adapter " + __bobbitAdapterId);
let __bobbitTargets;
try { __bobbitTargets = JSON.parse(__bobbitRawTargets); }
catch { throw new Error("Invalid " + __bobbitTargetsEnv + " JSON for filtered tool extension adapter " + __bobbitAdapterId); }
const __bobbitTarget = __bobbitTargets && __bobbitTargets[__bobbitAdapterId];
if (typeof __bobbitTarget !== "string" || __bobbitTarget.length === 0) throw new Error("Missing target mapping for filtered tool extension adapter " + __bobbitAdapterId);
const __bobbitModule = await import(__bobbitTarget);
const __bobbitFactory = __bobbitModule && __bobbitModule.default;
if (typeof __bobbitFactory !== "function") throw new Error("Tool extension target does not export a default factory for adapter " + __bobbitAdapterId);
const __bobbitAllowed = new Set(${JSON.stringify([])});
export default function __bobbitFilteredToolExtension(pi) {
  const __bobbitProxy = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") return (definition) => {
        const name = definition && definition.name;
        if (typeof name === "string" && __bobbitAllowed.has(name.toLowerCase())) return target.registerTool(definition);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return __bobbitFactory(__bobbitProxy);
}
`;
}

function sourceWithAllowedNames(adapterId: string, allowedToolNames: readonly string[]): string {
	const source = adapterSource(adapterId);
	const normalizedNames = allowedToolNames.map((name) => name.toLowerCase());
	return source.replace(
		`const __bobbitAllowed = new Set(${JSON.stringify([])});`,
		`const __bobbitAllowed = new Set(${JSON.stringify(normalizedNames)});`,
	);
}

function validatePublishedAdapter(
	directory: string,
	source: string,
	manifestJson: string,
): void {
	const publishedSource = fs.readFileSync(path.join(directory, TOOL_EXTENSION_ADAPTER_ENTRY), "utf-8");
	const publishedManifest = fs.readFileSync(path.join(directory, TOOL_EXTENSION_ADAPTER_MANIFEST), "utf-8");
	if (publishedSource !== source || publishedManifest !== manifestJson) {
		throw new Error(`content-addressed adapter validation failed at ${directory}`);
	}
}

/**
 * Atomically publish one immutable adapter. No process cache is retained: every
 * call validates the content-addressed artifact it returns.
 */
export function materializeToolExtensionAdapter(plan: ToolExtensionTargetPlan): MaterializedToolExtensionAdapter {
	const capturedTarget = plan.capturedTarget ?? captureToolExtensionTarget(plan.targetPath);
	plan.capturedTarget ??= capturedTarget;
	const expectedIdentity = identityForPhysicalPath(capturedTarget.physicalPath);
	if (capturedTarget.targetIdentity !== expectedIdentity) {
		throw new Error(`captured tool extension target identity does not match physical path: ${capturedTarget.physicalPath}`);
	}
	const targetIdentity = toolExtensionTargetIdentity(capturedTarget);
	const targetAliases: string[] = [];
	const seenAliases = new Set<string>();
	for (const alias of [plan.targetPath, ...(plan.targetAliases ?? [])]) {
		const resolved = path.resolve(alias);
		const identity = lexicalPathIdentity(resolved);
		if (seenAliases.has(identity)) continue;
		seenAliases.add(identity);
		targetAliases.push(resolved);
	}
	const allowedToolNames: string[] = [];
	const seen = new Set<string>();
	for (const name of plan.allowedToolNames) {
		const identity = name.toLowerCase();
		if (seen.has(identity)) continue;
		seen.add(identity);
		allowedToolNames.push(name);
	}
	const adapterId = sha256(stableStringify({
		schemaVersion: TOOL_EXTENSION_ADAPTER_SCHEMA_VERSION,
		targetIdentity,
		targetAliases,
		allowedToolNames: allowedToolNames.map((name) => name.toLowerCase()),
	}));
	const source = sourceWithAllowedNames(adapterId, allowedToolNames);
	const manifest: ToolExtensionAdapterManifest = {
		schemaVersion: TOOL_EXTENSION_ADAPTER_SCHEMA_VERSION,
		adapterId,
		targetIdentity,
		targetAliases,
		allowedToolNames,
		generatedSourceSha256: sha256(source),
	};
	const manifestJson = `${stableStringify(manifest)}\n`;
	const contentHash = sha256(`${manifestJson}\0${source}`);
	const baseDir = path.join(bobbitStateDir(), TOOL_EXTENSION_ADAPTER_STATE_DIR);
	const directory = path.join(baseDir, contentHash);
	const adapterPath = path.join(directory, TOOL_EXTENSION_ADAPTER_ENTRY);

	try {
		validatePublishedAdapter(directory, source, manifestJson);
	} catch {
		fs.mkdirSync(baseDir, { recursive: true });
		const temporary = fs.mkdtempSync(path.join(baseDir, `.${contentHash}.tmp-`));
		try {
			fs.writeFileSync(path.join(temporary, TOOL_EXTENSION_ADAPTER_ENTRY), source, "utf-8");
			fs.writeFileSync(path.join(temporary, TOOL_EXTENSION_ADAPTER_MANIFEST), manifestJson, "utf-8");
			try {
				fs.renameSync(temporary, directory);
			} catch (error) {
				// Another activation may have atomically published the same immutable
				// content. Accept only an exact validated winner.
				try {
					validatePublishedAdapter(directory, source, manifestJson);
				} catch {
					throw error;
				}
			}
		} finally {
			fs.rmSync(temporary, { recursive: true, force: true });
		}
		validatePublishedAdapter(directory, source, manifestJson);
	}

	return {
		adapterPath,
		adapterId,
		targetUrl: pathToFileURL(capturedTarget.physicalPath).href,
		manifest,
	};
}
