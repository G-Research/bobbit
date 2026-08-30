import fs from "node:fs";
import path from "node:path";

import { expect } from "../../../../tests2/integration/_e2e/in-process-harness.js";
import { base, readE2EToken } from "../../../../tests2/integration/_e2e/e2e-setup.js";

const SIGNED_COOKIE_VALUE = String.raw`v1\.[1-9]\d*\.[1-9]\d*\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`;

export function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

export function under(root: string, candidate: fs.PathLike): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(String(candidate)));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function onceAsync(finalize: () => Promise<void>): () => Promise<void> {
	let pending: Promise<void> | undefined;
	return () => pending ??= finalize();
}

export async function readPreviewEvents(response: Response, count: number): Promise<Array<Record<string, unknown>>> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("preview SSE response has no body");
	const decoder = new TextDecoder();
	let buffered = "";
	const events: Array<Record<string, unknown>> = [];
	while (events.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		const frames = buffered.split("\n\n");
		buffered = frames.pop() ?? "";
		for (const frame of frames) {
			if (!frame.startsWith("event: preview-changed\n")) continue;
			const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
			if (data) events.push(JSON.parse(data) as Record<string, unknown>);
			if (events.length === count) break;
		}
	}
	await reader.cancel();
	return events;
}

export async function mintCookie(): Promise<string> {
	const browserOrigin = new URL(base()).origin;
	const response = await fetch(`${base()}/api/health`, {
		headers: {
			Authorization: `Bearer ${readE2EToken()}`,
			Origin: browserOrigin,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
		},
	});
	expect(response.status).toBe(200);
	const setCookie = response.headers.get("set-cookie");
	expect(setCookie, "trusted browser auth should bootstrap a signed cookie").toBeTruthy();
	const match = String(setCookie).match(new RegExp(`bobbit_session=(${SIGNED_COOKIE_VALUE})(?:;|$)`));
	expect(match, `Set-Cookie did not include a signed bobbit_session: ${setCookie}`).not.toBeNull();
	return `bobbit_session=${match![1]}`;
}
