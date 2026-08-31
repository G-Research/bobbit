import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiFetch } from "../e2e-setup.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_SOURCE = path.resolve(__dirname, "..", "..", "fixtures", "packs");
const PACK_NAME = "provider-demo";

type CleanupStage = () => Promise<void>;

export interface ProviderDemoFixture {
	setDisabled(providers: string[]): Promise<void>;
	dispose(): Promise<void>;
}

async function expectStatus(response: Response, expected: number, operation: string): Promise<string> {
	const text = await response.text();
	if (response.status !== expected) {
		throw new Error(`${operation} expected ${expected}, got ${response.status}: ${text}`);
	}
	return text;
}

async function runCleanup(stages: readonly CleanupStage[], message: string): Promise<void> {
	const errors: unknown[] = [];
	for (const stage of stages) {
		try {
			await stage();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}

async function setDisabled(providers: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { providers } }),
	});
	await expectStatus(response, 200, "activate provider-demo");
}

async function uninstall(): Promise<void> {
	const response = await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME }),
	});
	await expectStatus(response, 204, "uninstall provider-demo");
}

async function deleteSource(sourceId: string): Promise<void> {
	const response = await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
	await expectStatus(response, 204, "delete provider-demo source");
}

/** Install the provider-demo pack through the marketplace resolver lifecycle. */
export async function installProviderDemoFixture(initialDisabled: string[]): Promise<ProviderDemoFixture> {
	let sourceId: string | undefined;
	let installed = false;
	let activated = false;
	try {
		const add = await apiFetch("/api/marketplace/sources", {
			method: "POST",
			body: JSON.stringify({ url: FIXTURE_SOURCE }),
		});
		const addText = await add.text();
		if (add.status === 409) {
			const sources = await apiFetch("/api/marketplace/sources");
			const sourcesText = await expectStatus(sources, 200, "list provider-demo sources");
			const existing = (JSON.parse(sourcesText).sources ?? []).find(
				(source: { id?: unknown; url?: unknown }) => source.url === FIXTURE_SOURCE,
			);
			if (typeof existing?.id !== "string") {
				throw new Error(`provider-demo source conflict did not match exact fixture URL: ${addText}`);
			}
			sourceId = existing.id;
		} else {
			if (add.status !== 201) {
				throw new Error(`add provider-demo source expected 201, got ${add.status}: ${addText}`);
			}
			const parsed = JSON.parse(addText) as { source?: { id?: unknown } };
			if (typeof parsed.source?.id !== "string") throw new Error("add provider-demo source returned no source id");
			sourceId = parsed.source.id;
		}
		const install = await apiFetch("/api/marketplace/install", {
			method: "POST",
			body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "server" }),
		});
		await expectStatus(install, 201, "install provider-demo");
		installed = true;
		await setDisabled(initialDisabled);
		activated = true;
	} catch (setupError) {
		const cleanupErrors: unknown[] = [];
		try {
			await runCleanup([
				...(activated ? [() => setDisabled([])] : []),
				...(installed ? [uninstall] : []),
				...(sourceId ? [() => deleteSource(sourceId!)] : []),
			], "provider-demo partial setup cleanup failed");
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		if (cleanupErrors.length) {
			throw new AggregateError([setupError, ...cleanupErrors], "provider-demo setup and cleanup failed");
		}
		throw setupError;
	}
	const ownedSourceId = sourceId!;
	return {
		setDisabled,
		async dispose(): Promise<void> {
			await runCleanup([
				() => setDisabled([]),
				uninstall,
				() => deleteSource(ownedSourceId),
			], "provider-demo fixture cleanup failed");
		},
	};
}
