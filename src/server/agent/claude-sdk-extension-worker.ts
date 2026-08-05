import { parentPort, workerData } from "node:worker_threads";
import { createJiti } from "jiti/static";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

interface WorkerData {
	cwd: string;
	env: Record<string, string>;
	extensionPaths: string[];
}

const port = parentPort;
if (!port) throw new Error("Claude SDK extension worker requires parentPort");
const config = workerData as WorkerData;
// A Worker has its own environment object.  This assignment is isolated from
// the gateway and other sessions; never perform this in the parent process.
Object.assign(process.env, config.env);
process.chdir(config.cwd);

const tools = new Map<string, ToolDefinition>();
const controllers = new Map<number, AbortController>();

async function initialize(): Promise<void> {
	const jiti = createJiti(import.meta.url, { interopDefault: true, tryNative: false });
	// ExtensionAPI is public.  Tool registration is the only extension-platform
	// capability invoked by the SDK adapter; lifecycle/UI registrations are inert
	// because this worker executes one already-authorized SDK tool call at a time.
	const api = new Proxy({
		registerTool(tool: ToolDefinition<any, any, any>) { tools.set(tool.name.toLowerCase(), tool); },
	}, { get(target, property) { return property in target ? Reflect.get(target, property) : () => undefined; } }) as unknown as ExtensionAPI;
	for (const extensionPath of config.extensionPaths) {
		const factory = await jiti.import(extensionPath, { default: true }) as unknown;
		if (typeof factory !== "function") throw new Error(`Extension ${extensionPath} has no default factory`);
		await factory(api);
	}
}

void initialize().then(
	() => port.postMessage({ type: "ready" }),
	error => port.postMessage({ type: "startup-error", error: error instanceof Error ? error.message : String(error) }),
);

port.on("message", async (message: any) => {
	if (message?.type === "cancel" && typeof message.id === "number") {
		controllers.get(message.id)?.abort();
		return;
	}
	if (message?.type !== "invoke" || typeof message.id !== "number" || typeof message.name !== "string") return;
	const tool = tools.get(message.name.toLowerCase());
	if (!tool) {
		port.postMessage({ type: "result", id: message.id, error: `No registered Bobbit extension tool for ${message.name}` });
		return;
	}
	const controller = new AbortController();
	controllers.set(message.id, controller);
	try {
		const result = await tool.execute(message.toolUseId, message.args ?? {}, controller.signal, undefined, undefined as never);
		port.postMessage({ type: "result", id: message.id, result });
	} catch (error) {
		port.postMessage({ type: "result", id: message.id, error: error instanceof Error ? error.message : String(error) });
	} finally {
		controllers.delete(message.id);
	}
});
