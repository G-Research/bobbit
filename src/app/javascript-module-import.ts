// Runtime import helper for pack-contributed browser modules.
//
// Browser UI imports fetched ESM bytes through a Blob URL so the request can stay
// bearer-authenticated and Vite does not pre-bundle a runtime URL. Vitest's
// vite-node executor, however, cannot resolve happy-dom's blob:nodedata:* URLs;
// in Node-backed tests we import the same bytes through a data: URL instead.

function isNodeRuntime(): boolean {
	const proc = (globalThis as unknown as { process?: { versions?: { node?: string } } }).process;
	return typeof proc?.versions?.node === "string";
}

/** Import already-fetched JavaScript module bytes. */
export async function importJavaScriptModuleBlob(blob: Blob): Promise<unknown> {
	const moduleBlob = blob.slice(0, blob.size, "text/javascript");
	if (isNodeRuntime()) {
		const source = await moduleBlob.text();
		const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
		return import(/* @vite-ignore */ url);
	}

	const objUrl = URL.createObjectURL(moduleBlob);
	try {
		return await import(/* @vite-ignore */ objUrl);
	} finally {
		URL.revokeObjectURL(objUrl);
	}
}
