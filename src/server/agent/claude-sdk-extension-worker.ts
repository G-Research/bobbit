import { parentPort, workerData } from "node:worker_threads";
import { createJiti } from "jiti/static";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

interface ManifestEntry {
	extensionPath: string;
	expectedToolNames: readonly string[];
}
interface WorkerData {
	cwd: string;
	env: Record<string, string>;
	manifest: readonly ManifestEntry[];
}

const port = parentPort;
if (!port) throw new Error("Claude SDK extension worker requires parentPort");
const config = workerData as WorkerData;
// WorkerOptions.env already replaced inheritance. Retain this assignment solely
// for test workers whose host does not propagate worker env values.
Object.assign(process.env, config.env);
process.chdir(config.cwd);

const tools = new Map<string, ToolDefinition>();
const controllers = new Map<number, AbortController>();
const expected = new Map<string, string>();
for (const entry of config.manifest) {
	for (const name of entry.expectedToolNames) {
		const lower = name.toLowerCase();
		if (expected.has(lower)) throw new Error("Claude SDK manifest contains duplicate tool names");
		expected.set(lower, entry.extensionPath);
	}
}

async function initialize(): Promise<void> {
	const jiti = createJiti(import.meta.url, { interopDefault: true, tryNative: false });
	let loadingPath = "";
	const context = Object.freeze({ cwd: config.cwd });
	const api = new Proxy({
		registerTool(tool: ToolDefinition<any, any, any>) {
			const name = typeof tool?.name === "string" ? tool.name.toLowerCase() : "";
			if (!name || expected.get(name) !== loadingPath || tools.has(name)) {
				throw new Error("Claude SDK extension registered an unexpected or duplicate tool");
			}
			tools.set(name, tool);
		},
		getContext: () => context,
	}, { get(target, property) { return property in target ? Reflect.get(target, property) : () => undefined; } }) as unknown as ExtensionAPI;
	for (const entry of config.manifest) {
		loadingPath = entry.extensionPath;
		const factory = await jiti.import(entry.extensionPath, { default: true }) as unknown;
		if (typeof factory !== "function") throw new Error("Claude SDK extension has no default factory");
		await factory(api);
	}
	if (tools.size !== expected.size || [...expected.keys()].some(name => !tools.has(name))) {
		throw new Error("Claude SDK extension manifest has missing tool registrations");
	}
}

void initialize().then(
	() => port.postMessage({ type: "ready" }),
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
		// Pi's public ExtensionContext contract is intentionally minimal here; tools
		// that resolve workspace-relative files receive the selected session cwd.
		const result = await tool.execute(message.toolUseId, message.args ?? {}, controller.signal, undefined, { cwd: config.cwd } as never);
		port.postMessage({ type: "result", id: message.id, result });
	} catch {
		port.postMessage({ type: "result", id: message.id, error: "failed" });
	} finally {
		controllers.delete(message.id);
	}
});
