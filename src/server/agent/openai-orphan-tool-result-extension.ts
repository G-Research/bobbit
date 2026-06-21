import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

export interface OpenAiOrphanToolResultGuardResult {
	payload: unknown;
	dropped: number;
	changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFunctionCallItem(item: unknown): item is { type: "function_call"; call_id: string } {
	return isRecord(item) && item.type === "function_call" && typeof item.call_id === "string";
}

function isFunctionCallOutputItem(item: unknown): item is { type: "function_call_output"; call_id?: unknown } {
	return isRecord(item) && item.type === "function_call_output";
}

/**
 * Drop OpenAI Responses `function_call_output` items that do not have a prior
 * matching `function_call` in the same payload input array.
 */
export function dropOrphanFunctionCallOutputsFromPayload(payload: unknown): OpenAiOrphanToolResultGuardResult {
	if (!isRecord(payload) || !Array.isArray(payload.input)) {
		return { payload, dropped: 0, changed: false };
	}

	if (!payload.input.some(isFunctionCallOutputItem)) {
		return { payload, dropped: 0, changed: false };
	}

	const seenCallIds = new Set<string>();
	const filteredInput: unknown[] = [];
	let dropped = 0;

	for (const item of payload.input) {
		if (isFunctionCallItem(item)) {
			seenCallIds.add(item.call_id);
			filteredInput.push(item);
			continue;
		}

		if (isFunctionCallOutputItem(item)) {
			const callId = item.call_id;
			if (typeof callId !== "string" || !seenCallIds.has(callId)) {
				dropped++;
				continue;
			}
		}

		filteredInput.push(item);
	}

	if (dropped === 0) {
		return { payload, dropped: 0, changed: false };
	}

	return {
		payload: { ...payload, input: filteredInput },
		dropped,
		changed: true,
	};
}

export function generateOpenAiOrphanToolResultExtension(): string {
	return `function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isFunctionCallItem(item) {
  return isRecord(item) && item.type === "function_call" && typeof item.call_id === "string";
}

function isFunctionCallOutputItem(item) {
  return isRecord(item) && item.type === "function_call_output";
}

function dropOrphanFunctionCallOutputsFromPayload(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.input)) {
    return { payload, dropped: 0, changed: false };
  }

  if (!payload.input.some(isFunctionCallOutputItem)) {
    return { payload, dropped: 0, changed: false };
  }

  const seenCallIds = new Set();
  const filteredInput = [];
  let dropped = 0;

  for (const item of payload.input) {
    if (isFunctionCallItem(item)) {
      seenCallIds.add(item.call_id);
      filteredInput.push(item);
      continue;
    }

    if (isFunctionCallOutputItem(item)) {
      const callId = item.call_id;
      if (typeof callId !== "string" || !seenCallIds.has(callId)) {
        dropped++;
        continue;
      }
    }

    filteredInput.push(item);
  }

  if (dropped === 0) {
    return { payload, dropped: 0, changed: false };
  }

  return {
    payload: { ...payload, input: filteredInput },
    dropped,
    changed: true,
  };
}

export default function(pi) {
  pi.on("before_provider_request", (event) => {
    const result = dropOrphanFunctionCallOutputsFromPayload(event && event.payload);
    if (!result.changed) return undefined;
    console.warn("[bobbit-openai-orphan-guard] Dropped " + result.dropped + " orphan function_call_output item(s)");
    return result.payload;
  });
}
`;
}

let cachedCode: string | undefined;
let cachedPath: string | undefined;

/** Write the OpenAI Responses orphan-output guard extension and return its path. */
export function writeOpenAiOrphanToolResultExtension(): string | undefined {
	if (!cachedCode) cachedCode = generateOpenAiOrphanToolResultExtension();
	if (cachedPath) {
		try {
			if (fs.readFileSync(cachedPath, "utf-8") === cachedCode) return cachedPath;
		} catch { /* missing/unreadable — fall through to rewrite */ }
		cachedPath = undefined;
	}

	try {
		// `tool-guard` is already bind-mounted into sandbox containers, so keeping
		// this generated guard below it makes `--extension` work for sandboxed and
		// host sessions without broadening the mounted Bobbit state surface.
		const baseDir = path.join(bobbitStateDir(), "tool-guard", "openai-orphan-tool-result");
		const hash = createHash("sha256").update(cachedCode).digest("hex").slice(0, 12);
		const extDir = path.join(baseDir, hash);
		fs.mkdirSync(extDir, { recursive: true });

		const filePath = path.join(extDir, "extension.ts");
		try {
			if (fs.readFileSync(filePath, "utf-8") === cachedCode) {
				cachedPath = filePath;
				return filePath;
			}
		} catch { /* file does not exist yet */ }
		fs.writeFileSync(filePath, cachedCode, "utf-8");
		cachedPath = filePath;
		return filePath;
	} catch {
		// Non-fatal: session setup should not fail because a defensive provider
		// preflight guard could not be written.
		return undefined;
	}
}

export function resetOpenAiOrphanToolResultExtensionCache(): void {
	cachedCode = undefined;
	cachedPath = undefined;
}
