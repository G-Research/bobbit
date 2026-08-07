import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.HINDSIGHT_FIXTURE_PORT || 8888);
const dataDir = process.env.HINDSIGHT_FIXTURE_DATA_DIR || "/data";
const unhealthy = process.env.HINDSIGHT_FIXTURE_UNHEALTHY === "1";
const dataFile = join(dataDir, "banks.json");
const loadId = randomUUID();

async function readBody(request) {
	let raw = "";
	for await (const chunk of request) raw += chunk;
	try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

async function database() {
	try { return JSON.parse(await readFile(dataFile, "utf8")); }
	catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") return { banks: {} };
		throw error;
	}
}

async function save(value) {
	await mkdir(dataDir, { recursive: true });
	await writeFile(dataFile, JSON.stringify(value), "utf8");
}

function response(reply, status, body) {
	reply.writeHead(status, { "content-type": "application/json" });
	reply.end(JSON.stringify(body));
}

function bankPath(pathname) {
	const match = /^\/v1\/([^/]+)\/banks\/([^/]+)(?:\/(.*))?$/.exec(pathname);
	if (!match) return undefined;
	return { namespace: decodeURIComponent(match[1]), bank: decodeURIComponent(match[2]), tail: match[3] || "" };
}

const server = createServer(async (request, reply) => {
	try {
		const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
		if (url.pathname === "/health") return response(reply, unhealthy ? 503 : 200, { status: unhealthy ? "unhealthy" : "ok" });
		if (url.pathname === "/__fixture/diagnostics") return response(reply, 200, { processId: process.pid, loadId, resident: true });
		if (url.pathname === "/__fixture/export" && request.method === "GET") return response(reply, 200, await database());
		if (url.pathname === "/__fixture/import" && request.method === "POST") {
			const imported = await readBody(request);
			if (!imported || typeof imported !== "object" || Array.isArray(imported) || !imported.banks || typeof imported.banks !== "object") {
				return response(reply, 400, { error: "logical dump is invalid" });
			}
			await save(imported);
			return response(reply, 200, { imported: Object.keys(imported.banks).length });
		}
		const parsed = bankPath(url.pathname);
		if (!parsed) return response(reply, 404, { error: "not found" });
		const db = await database();
		db.banks[parsed.bank] ||= { memories: [] };
		if (request.method === "PUT" && !parsed.tail) {
			await save(db);
			return response(reply, 200, { bank_id: parsed.bank });
		}
		if (request.method === "POST" && parsed.tail === "memories") {
			const body = await readBody(request);
			const items = Array.isArray(body.items) ? body.items : [];
			for (const item of items) {
				if (typeof item?.content === "string") db.banks[parsed.bank].memories.push({ id: item.id || randomUUID(), text: item.content, tags: Array.isArray(item.tags) ? item.tags : [] });
			}
			await save(db);
			return response(reply, 200, { success: true, bank_id: parsed.bank, items_count: items.length });
		}
		if (request.method === "POST" && parsed.tail === "memories/recall") {
			const body = await readBody(request);
			const query = typeof body.query === "string" ? body.query.toLowerCase() : "";
			const results = db.banks[parsed.bank].memories.filter((memory) => memory.text.toLowerCase().includes(query)).map((memory) => ({ id: memory.id, text: memory.text, tags: memory.tags }));
			return response(reply, 200, { results });
		}
		if (request.method === "POST" && parsed.tail === "reflect") {
			const body = await readBody(request);
			return response(reply, 200, { text: `Reflection on: ${typeof body.query === "string" ? body.query : ""}`, load_id: loadId });
		}
		return response(reply, 404, { error: "not found" });
	} catch (error) {
		return response(reply, 500, { error: error instanceof Error ? error.message : String(error) });
	}
});

server.listen(port, "0.0.0.0");
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5_000).unref(); }
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
