import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { createJiti } from "jiti/static";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

interface ManifestEntry {
	extensionPath: string;
	selectedToolNames: readonly string[];
	allowedToolNames: readonly string[];
	builtinToolNames?: readonly string[];
}
interface WorkerData {
	cwd: string;
	env: Record<string, string>;
	manifest: readonly ManifestEntry[];
}

const port = parentPort;
if (!port) throw new Error("Claude SDK extension worker requires parentPort");
const config = workerData as WorkerData;
// WorkerOptions.env replaces inheritance. Retain this assignment solely for
// test workers whose host does not propagate worker env values.
Object.assign(process.env, config.env);
// Node deliberately forbids process.chdir() in worker threads. Pi builtins use
// process.cwd() at registration and execution, so bind that public read-only
// process view to the selected session directory without changing the host cwd.
Object.defineProperty(process, "cwd", { value: () => config.cwd, configurable: false });

const tools = new Map<string, ToolDefinition>();
const controllers = new Map<number, AbortController>();
const entriesByPath = new Map<string, ManifestEntry>();
const allowedOwners = new Map<string, string>();
for (const entry of config.manifest) {
	const extensionPath = path.resolve(entry.extensionPath);
	if (entriesByPath.has(extensionPath)) throw new Error("Claude SDK manifest contains duplicate extension paths");
	entriesByPath.set(extensionPath, entry);
	for (const name of entry.allowedToolNames) {
		const lower = name.toLowerCase();
		if (!lower || allowedOwners.has(lower)) throw new Error("Claude SDK manifest contains duplicate allowed tool names");
		allowedOwners.set(lower, extensionPath);
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

async function initialize(): Promise<readonly { name: string; inputSchema: Record<string, unknown> }[]> {
	const jiti = createJiti(import.meta.url, { interopDefault: true, tryNative: false });
	let loadingPath = "";
	const api = new Proxy({
		registerTool(definition: ToolDefinition) {
			const name = typeof definition?.name === "string" ? definition.name.toLowerCase() : "";
			if (!name || allowedOwners.get(name) !== loadingPath || tools.has(name)) {
				throw new Error("Claude SDK extension registered an unexpected or duplicate tool");
			}
			tools.set(name, definition);
		},
	}, {
		get(target, property) {
			if (property in target) return Reflect.get(target, property);
			return () => { throw new Error("Extension host capability is unavailable during Claude SDK preflight"); };
		},
	}) as unknown as ExtensionAPI;
	for (const entry of config.manifest) {
		loadingPath = path.resolve(entry.extensionPath);
		const factory = await jiti.import(loadingPath, { default: true }) as unknown;
		if (typeof factory !== "function") throw new Error("Claude SDK extension has no default factory");
		await factory(api);
	}
	const schemas: Array<{ name: string; inputSchema: Record<string, unknown> }> = [];
	for (const entry of config.manifest) {
		for (const selected of entry.selectedToolNames) {
			const tool = tools.get(selected.toLowerCase());
			if (!tool) throw new Error("Claude SDK extension manifest has missing selected registration");
			schemas.push({ name: selected.toLowerCase(), inputSchema: plainTypeBoxSchema(tool.parameters) });
		}
	}
	if (schemas.length !== new Set(schemas.map(schema => schema.name)).size) throw new Error("Claude SDK extension schema collision");
	return schemas;
}

void initialize().then(
	schemas => port.postMessage({ type: "ready", schemas }),
	() => port.postMessage({ type: "startup-error" }),
);

port.on("message", async (message: any) => {
	if (message?.type === "cancel" && typeof message.id === "number") {
		controllers.get(message.id)?.abort();
		return;
	}
	if (message?.type !== "invoke" || typeof message.id !== "number" || typeof message.name !== "string") return;
	const tool = tools.get(message.name.toLowerCase());
	if (!tool) {
		port.postMessage({ type: "result", id: message.id, error: "unavailable" });
		return;
	}
	const controller = new AbortController();
	controllers.set(message.id, controller);
	try {
		const result = await tool.execute(message.toolUseId, message.args ?? {}, controller.signal, undefined, extensionContext(controller.signal, controller));
		port.postMessage({ type: "result", id: message.id, result });
	} catch {
		port.postMessage({ type: "result", id: message.id, error: "failed" });
	} finally {
		controllers.delete(message.id);
	}
});
