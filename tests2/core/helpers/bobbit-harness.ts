/**
 * Shared harness for the bobbit gateway-tool suite tests.
 *
 * Loads the real extension factory with a stub `pi` that captures every
 * `registerTool({...})` call, and provides a `fetch` stub that records the
 * outgoing requests. Not a test file — lives under helpers/ (a SUPPORT_DIR),
 * so guard-v2 ignores it for orphan detection.
 */
import factory, { BOBBIT_OPERATIONS } from "../../../defaults/tools/bobbit/extension.ts";

export { BOBBIT_OPERATIONS };

export interface CapturedTool {
	name: string;
	description?: string;
	parameters?: any;
	execute: (id: string, params: any) => Promise<any>;
}

/** Call the extension factory with a capturing stub `pi`; returns tools by name. */
export function loadBobbitTools(): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const pi: any = {
		registerTool(def: any) {
			tools.set(def.name, {
				name: def.name,
				description: def.description,
				parameters: def.parameters,
				execute: def.execute.bind(def),
			});
		},
		on() {},
	};
	factory(pi);
	return tools;
}

export interface FetchCall {
	url: string;
	method: string;
	body: any;
}

export interface StubResponse {
	status?: number;
	body?: unknown;
	/** Raw response text; overrides `body`. Use "" for 204/empty. */
	text?: string;
}

/**
 * Replace `globalThis.fetch` with a recording stub. Returns the mutable call
 * log. `impl` maps each request to a response; defaults to `200 {ok:true}`.
 * (guardProcessEnv restores globalThis.fetch after the file.)
 */
export function stubFetch(impl?: (url: string, init: any) => StubResponse): FetchCall[] {
	const calls: FetchCall[] = [];
	globalThis.fetch = (async (url: any, init: any) => {
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
		calls.push({ url: String(url), method, body });
		const r = impl ? impl(String(url), init) : {};
		const status = r.status ?? 200;
		const text = r.text !== undefined ? r.text : r.body !== undefined ? JSON.stringify(r.body) : JSON.stringify({ ok: true });
		return {
			ok: status >= 200 && status < 300,
			status,
			async text() {
				return text;
			},
		} as any;
	}) as any;
	return calls;
}

/** Extract the literal `operation` union values from a captured tool's schema. */
export function operationUnion(tool: CapturedTool): string[] {
	const op = tool.parameters?.properties?.operation;
	const variants: any[] = op?.anyOf ?? op?.oneOf ?? [];
	return variants.map((v) => v.const).filter((c) => typeof c === "string");
}
