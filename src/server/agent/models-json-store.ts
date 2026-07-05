import fs from "node:fs";
import path from "node:path";

import { globalAgentDir } from "../bobbit-dir.js";
import { atomicWriteJsonSync } from "./atomic-json.js";

export type ModelsJsonData = Record<string, any>;

let modelsJsonQueue: Promise<void> = Promise.resolve();

export function getModelsJsonPath(): string {
	return path.join(globalAgentDir(), "models.json");
}

export function readModelsJson(logPrefix = "[models-json]"): ModelsJsonData {
	const p = getModelsJsonPath();
	try {
		if (fs.existsSync(p)) {
			return JSON.parse(fs.readFileSync(p, "utf-8"));
		}
	} catch (err) {
		console.error(`${logPrefix} Failed to read models.json:`, err);
	}
	return { providers: {} };
}

export function replaceModelsJson(data: ModelsJsonData, opts: { logPrefix?: string; debugOnly?: boolean } = {}): void {
	const p = getModelsJsonPath();
	atomicWriteJsonSync(p, data);
	const prefix = opts.logPrefix ?? "[models-json]";
	if (!opts.debugOnly || process.env.BOBBIT_DEBUG) {
		console.log(`${prefix} Wrote models.json to ${p}`);
	}
}

export async function updateModelsJson<T>(
	update: (data: ModelsJsonData) => T | Promise<T>,
	opts: {
		logPrefix?: string;
		debugOnly?: boolean;
		write?: (result: T, data: ModelsJsonData) => boolean;
	} = {},
): Promise<T> {
	const run = async (): Promise<T> => {
		const data = readModelsJson(opts.logPrefix);
		const result = await update(data);
		const shouldWrite = opts.write ? opts.write(result, data) : true;
		if (shouldWrite) replaceModelsJson(data, opts);
		return result;
	};

	const next = modelsJsonQueue.then(run, run);
	modelsJsonQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}
