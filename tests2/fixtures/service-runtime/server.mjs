import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.SERVICE_RUNTIME_PORT || process.env.PORT || 8888);
// Local runner contract: this receives 127.0.0.1 after all authored values.
// Docker/Compose omit it and retain the container-appropriate wildcard default.
const host = process.env.SERVICE_RUNTIME_HOST || "0.0.0.0";
const dataDir = process.env.SERVICE_RUNTIME_DATA_DIR || "/data";
const unhealthy = process.env.SERVICE_RUNTIME_UNHEALTHY === "1";
const dataFile = join(dataDir, "records.json");

async function records() {
	try {
		return JSON.parse(await readFile(dataFile, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") return {};
		throw error;
	}
}

async function json(request) {
	let body = "";
	for await (const chunk of request) body += chunk;
	return JSON.parse(body || "{}");
}

function reply(response, status, body) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
		if (url.pathname === "/health") {
			const address = server.address();
			reply(response, unhealthy ? 503 : 200, { status: unhealthy ? "unhealthy" : "ok", listener: typeof address === "object" && address ? address.address : undefined });
			return;
		}
		if (url.pathname === "/retain" && request.method === "POST") {
			const { key, value } = await json(request);
			if (typeof key !== "string" || typeof value !== "string") {
				reply(response, 400, { error: "key and value must be strings" });
				return;
			}
			const current = await records();
			current[key] = value;
			await mkdir(dataDir, { recursive: true });
			await writeFile(dataFile, JSON.stringify(current), "utf8");
			reply(response, 200, { retained: key });
			return;
		}
		if (url.pathname === "/recall" && request.method === "GET") {
			const key = url.searchParams.get("key");
			const current = await records();
			reply(response, 200, { value: key ? current[key] : undefined });
			return;
		}
		reply(response, 404, { error: "not found" });
	} catch (error) {
		reply(response, 500, { error: error instanceof Error ? error.message : String(error) });
	}
});

server.listen(port, host);

function shutdown() {
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
