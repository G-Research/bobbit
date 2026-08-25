/**
 * In-process Hindsight stub — a deterministic, network-free fake of the Hindsight
 * HTTP API used by the Hindsight memory pack (EP G2 / external mode).
 *
 * Reused by every later Hindsight goal: the client unit test
 * (tests/hindsight-client.test.ts), the provider unit test, and the API E2E
 * (tests/e2e/hindsight-external.spec.ts) all drive this same stub so the wire
 * contract is exercised end-to-end without a real server.
 *
 * Canned JSON matches the upstream `openapi.json` response shapes (Hindsight
 * 0.8.x). See docs/design/hindsight-pack-external.md §4.
 *
 *   startHindsightStub({ port = 0 }) → {
 *     url,                       // base url, e.g. http://127.0.0.1:54321
 *     calls,                     // RecordedCall[] (method, path, bank, namespace, body, headers)
 *     setHealthy(ok),            // false ⇒ /health 503 and recall/retain 503
 *     seedMemories(bank, mem[]), // seed recall results (filtered by tags + tags_match)
 *     retained(bank?),           // recorded retained items { content, tags, async }
 *     close(),                   // shut the server down
 *   }
 */
import http from "node:http";

/**
 * @typedef {Object} RecordedCall
 * @property {string} method
 * @property {string} path
 * @property {string|undefined} bank
 * @property {string|undefined} namespace
 * @property {any} body
 * @property {Record<string,string>} headers
 */

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!raw) return resolve(undefined);
			try {
				resolve(JSON.parse(raw));
			} catch {
				resolve(raw);
			}
		});
	});
}

function send(res, status, body) {
	const payload = body === undefined ? "" : JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(payload);
}

/** Does a seeded memory's tags satisfy the request's tags + tags_match? */
function tagsMatch(memTags, reqTags, mode) {
	if (!reqTags || reqTags.length === 0) return true;
	const have = new Set(memTags ?? []);
	// "all"/"all_strict" ⇒ every requested tag present; otherwise (any/any_strict) ⇒ at least one.
	if (mode === "all" || mode === "all_strict") {
		return reqTags.every((t) => have.has(t));
	}
	return reqTags.some((t) => have.has(t));
}

export function startHindsightStub({ port = 0 } = {}) {
	/** @type {RecordedCall[]} */
	const calls = [];
	let healthy = true;
	/** bank → seeded memory records */
	const seeded = new Map();
	/** bank → retained item records */
	const retainedByBank = new Map();
	/** known bank ids (ensured / seeded / retained) */
	const banks = new Set();

	const server = http.createServer(async (req, res) => {
		const method = req.method ?? "GET";
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const pathname = url.pathname;
		const body = await readBody(req);

		// Parse namespace + bank from /v1/{ns}/banks[/{bank}[/...]]
		let namespace;
		let bank;
		const segs = pathname.split("/").filter(Boolean); // ["v1","default","banks","bobbit",...]
		if (segs[0] === "v1" && segs[2] === "banks") {
			namespace = decodeURIComponent(segs[1]);
			if (segs[3]) bank = decodeURIComponent(segs[3]);
		}

		calls.push({ method, path: pathname, bank, namespace, body, headers: { ...req.headers } });

		// GET /health
		if (pathname === "/health" && method === "GET") {
			return healthy ? send(res, 200, { status: "ok" }) : send(res, 503, { status: "unhealthy" });
		}

		// GET /v1/{ns}/banks  — list banks
		if (method === "GET" && segs[0] === "v1" && segs[2] === "banks" && segs.length === 3) {
			return send(res, 200, { banks: [...banks].map((b) => ({ bank_id: b })) });
		}

		// PUT /v1/{ns}/banks/{bank}  — create_or_update_bank
		if (method === "PUT" && bank && segs.length === 4) {
			banks.add(bank);
			return send(res, 200, { bank_id: bank, name: bank });
		}

		// POST /v1/{ns}/banks/{bank}/memories/recall  — recall_memories
		if (method === "POST" && bank && segs[4] === "memories" && segs[5] === "recall") {
			if (!healthy) return send(res, 503, { detail: "unhealthy" });
			const reqTags = body?.tags;
			const mode = body?.tags_match;
			const mem = seeded.get(bank) ?? [];
			const results = mem
				.filter((m) => tagsMatch(m.tags, reqTags, mode))
				.map((m) => ({
					id: m.id ?? `mem-${Math.random().toString(36).slice(2, 8)}`,
					text: m.text,
					...(m.score !== undefined ? { score: m.score } : {}),
					...(m.tags ? { tags: m.tags } : {}),
				}));
			return send(res, 200, { results });
		}

		// POST /v1/{ns}/banks/{bank}/memories  — retain_memories
		if (method === "POST" && bank && segs[4] === "memories" && segs.length === 5) {
			if (!healthy) return send(res, 503, { detail: "unhealthy" });
			banks.add(bank);
			const items = Array.isArray(body?.items) ? body.items : [];
			const isAsync = body?.async === true;
			const list = retainedByBank.get(bank) ?? [];
			for (const it of items) {
				list.push({ content: it.content, tags: it.tags ?? [], async: isAsync });
			}
			retainedByBank.set(bank, list);
			return send(res, 200, {
				success: true,
				bank_id: bank,
				items_count: items.length,
				async: isAsync,
			});
		}

		// POST /v1/{ns}/banks/{bank}/reflect  — reflect
		if (method === "POST" && bank && segs[4] === "reflect") {
			if (!healthy) return send(res, 503, { detail: "unhealthy" });
			return send(res, 200, { text: `Reflection on: ${body?.query ?? ""}` });
		}

		return send(res, 404, { detail: `no stub route for ${method} ${pathname}` });
	});

	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			const addr = server.address();
			const actualPort = typeof addr === "object" && addr ? addr.port : port;
			resolve({
				url: `http://127.0.0.1:${actualPort}`,
				calls,
				setHealthy(ok) {
					healthy = ok;
				},
				seedMemories(bank, mem) {
					banks.add(bank);
					seeded.set(bank, [...(seeded.get(bank) ?? []), ...mem]);
				},
				retained(bank) {
					if (bank) return [...(retainedByBank.get(bank) ?? [])];
					return [...retainedByBank.values()].flat();
				},
				close() {
					return new Promise((res) => server.close(() => res()));
				},
			});
		});
	});
}
