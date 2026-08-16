import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { createJiti } from "jiti/static";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

interface ManifestEntry {
	extensionPath: string;
	selectedToolNames: readonly string[];
	requiredToolNames?: readonly string[];
	allowedToolNames: readonly string[];
	builtinToolNames?: readonly string[];
}
interface WorkerData {
	cwd: string;
	env: Record<string, string>;
	manifest: readonly ManifestEntry[];
}

const port = parentPort;
let config: WorkerData;
const PROTOCOL_PREFIX = "BOBBIT_SDK_DISPATCH:";

function emit(message: unknown): void {
	if (port) port.postMessage(message);
	else process.stdout.write(`${PROTOCOL_PREFIX}${JSON.stringify(message)}\n`);
}

function configure(value: WorkerData): void {
	if (!value || typeof value.cwd !== "string" || !value.env || !Array.isArray(value.manifest)) throw new Error("Claude SDK extension worker received invalid configuration");
	config = value;
	// WorkerOptions.env replaces inheritance. Retain this assignment solely for
	// test workers whose host does not propagate worker env values.
	Object.assign(process.env, config.env);
	// Node deliberately forbids process.chdir() in worker threads. Pi builtins use
	// process.cwd() at registration and execution, so bind that public read-only
	// process view to the selected session directory without changing the host cwd.
	if (port) Object.defineProperty(process, "cwd", { value: () => config.cwd, configurable: false });
	else process.chdir(config.cwd);
}

if (port) configure(workerData as WorkerData);

const tools = new Map<string, ToolDefinition>();
const controllers = new Map<number, AbortController>();
const entriesByPath = new Map<string, ManifestEntry>();
// Some tools have two trusted conditional providers (for example goal-team
// and child-team implementations). Accept either named provider, but reject an
// actual duplicate registration below so no call can be substituted or owned
// twice in one session.
const allowedOwners = new Map<string, Set<string>>();

function validateManifest(): void {
	for (const entry of config.manifest) {
		const extensionPath = path.resolve(entry.extensionPath);
		if (entriesByPath.has(extensionPath)) throw new Error("Claude SDK manifest contains duplicate extension paths");
		entriesByPath.set(extensionPath, entry);
		for (const name of entry.allowedToolNames) {
			const lower = name.toLowerCase();
			if (!lower) throw new Error("Claude SDK manifest contains an invalid allowed tool name");
			const owners = allowedOwners.get(lower) ?? new Set<string>();
			owners.add(extensionPath);
			allowedOwners.set(lower, owners);
		}
	}
}

/** An inert ExtensionContext: tool handlers receive their cwd and cancellation signal but no host controls. */
function extensionContext(signal: AbortSignal, controller: AbortController): ExtensionContext {
	const unsupported = () => { throw new Error("Extension host capability is unavailable in the Claude SDK runtime"); };
	const ui = new Proxy({}, { get: () => unsupported }) as ExtensionContext["ui"];
	const unavailable = new Proxy({}, { get: () => unsupported });
	return {
		ui,
		mode: "rpc",
		hasUI: false,
		cwd: config.cwd,
		sessionManager: unavailable as ExtensionContext["sessionManager"],
		modelRegistry: unavailable as ExtensionContext["modelRegistry"],
		scopedModels: [],
		model: undefined,
		isIdle: () => true,
		isProjectTrusted: () => false,
		signal,
		abort: () => controller.abort(),
		hasPendingMessages: () => false,
		shutdown: unsupported,
		getContextUsage: () => undefined,
		compact: unsupported,
		getSystemPrompt: () => "",
	};
}

function plainTypeBoxSchema(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Claude SDK extension registered an invalid TypeBox schema");
	// TypeBox schemas are JSON Schema values plus symbol metadata. Structured clone
	// cannot carry symbols, and the Agent SDK only needs the exact JSON Schema form.
	return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

let startupDiagnostic = "initializing";

function extensionDiagnosticName(extensionPath: string): string {
	return `${path.basename(path.dirname(extensionPath))}.${path.basename(extensionPath)}`;
}

async function initialize(): Promise<{ schemas: readonly { name: string; inputSchema: Record<string, unknown> }[]; omittedConditional: readonly string[] }> {
	validateManifest();
	const jiti = createJiti(process.cwd(), { interopDefault: true, tryNative: false });
	let loadingPath = "";
	const noOp = () => undefined;
	const api = new Proxy({
		registerTool(definition: ToolDefinition) {
			const name = typeof definition?.name === "string" ? definition.name.toLowerCase() : "";
			if (!name || !allowedOwners.get(name)?.has(loadingPath) || tools.has(name)) {
				startupDiagnostic = `rejected:${extensionDiagnosticName(loadingPath)}:${name || "unnamed"}`;
				throw new Error("Claude SDK extension registered an unexpected or duplicate tool");
			}
			tools.set(name, definition);
		},
		// Extension factories commonly subscribe to lifecycle events while defining
		// tools. The SDK worker owns no Pi lifecycle, so every non-tool API is inert
		// during preflight rather than becoming an accidental startup dependency.
		on: noOp,
		once: noOp,
		off: noOp,
		emit: noOp,
	}, {
		get(target, property) {
			if (property in target) return Reflect.get(target, property);
			return noOp;
		},
	}) as unknown as ExtensionAPI;
	for (const entry of config.manifest) {
		loadingPath = path.resolve(entry.extensionPath);
		startupDiagnostic = `loading:${extensionDiagnosticName(loadingPath)}`;
		let factory: unknown;
		try {
			factory = await jiti.import(loadingPath, { default: true }) as unknown;
		} catch {
			throw new Error("Claude SDK extension preflight could not load its trusted factory");
		}
		if (typeof factory !== "function") throw new Error("Claude SDK extension has no default factory");
		startupDiagnostic = `registering:${extensionDiagnosticName(loadingPath)}`;
		try {
			await factory(api);
		} catch {
			throw new Error("Claude SDK extension preflight rejected a registration");
		}
	}
	const schemas: Array<{ name: string; inputSchema: Record<string, unknown> }> = [];
	const omittedConditional: string[] = [];
	for (const entry of config.manifest) {
		const selected = new Set(entry.selectedToolNames.map(name => name.toLowerCase()));
		for (const required of entry.requiredToolNames ?? []) {
			if (!selected.has(required.toLowerCase()) || !tools.has(required.toLowerCase())) {
				throw new Error("Claude SDK extension manifest has missing required registration");
			}
		}
		// A trusted extension can intentionally omit tools for this session (for
		// example, team-lead tools outside a goal). Surface only registrations the
		// selected owner actually made; never substitute a sibling registration.
		for (const name of selected) {
			const tool = tools.get(name);
			if (tool) schemas.push({ name, inputSchema: plainTypeBoxSchema(tool.parameters) });
			else omittedConditional.push(name);
		}
	}
	if (schemas.length !== new Set(schemas.map(schema => schema.name)).size) throw new Error("Claude SDK extension schema collision");
	return { schemas, omittedConditional };
}

async function handleMessage(message: any): Promise<void> {
	if (message?.type === "cancel" && typeof message.id === "number") {
		controllers.get(message.id)?.abort();
		return;
	}
	if (message?.type !== "invoke" || typeof message.id !== "number" || typeof message.name !== "string") return;
	const tool = tools.get(message.name.toLowerCase());
	if (!tool) {
		emit({ type: "result", id: message.id, error: "unavailable" });
		return;
	}
	// SDK Zod shapes guide the model, but TypeBox remains the authority for the
	// trusted extension's exact schema. Never let malformed SDK arguments enter
	// an extension handler.
	if (!Value.Check(tool.parameters as unknown as TSchema, message.args ?? {})) {
		emit({ type: "result", id: message.id, error: "invalid-arguments" });
		return;
	}
	const controller = new AbortController();
	controllers.set(message.id, controller);
	try {
		const result = await tool.execute(message.toolUseId, message.args ?? {}, controller.signal, undefined, extensionContext(controller.signal, controller));
		emit({ type: "result", id: message.id, result });
	} catch {
		emit({ type: "result", id: message.id, error: "failed" });
	} finally {
		controllers.delete(message.id);
	}
}

function start(): void {
	void initialize().then(
		({ schemas, omittedConditional }) => emit({ type: "ready", schemas, omittedConditional }),
		() => emit({ type: "startup-error", diagnostic: startupDiagnostic.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 160) }),
	);
}

if (port) {
	start();
	port.on("message", message => { void handleMessage(message); });
} else {
	let input = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", chunk => {
		input += chunk;
		const lines = input.split("\n");
		input = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith(PROTOCOL_PREFIX)) continue;
			try {
				const message = JSON.parse(line.slice(PROTOCOL_PREFIX.length));
				if (message?.type === "init") {
					configure(message as WorkerData);
					start();
				} else void handleMessage(message);
			} catch {
				emit({ type: "startup-error", diagnostic: "invalid-protocol" });
			}
		}
	});
}
