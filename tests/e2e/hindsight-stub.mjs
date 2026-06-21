/**
 * In-process Hindsight stub — a deterministic, network-free fake of the Hindsight
 * HTTP API used by the Hindsight memory pack (EP G2 / external mode).
 *
 * Reused by every later Hindsight goal: the client unit test
 * (tests/hindsight-client.test.ts), the provider unit test, and the API E2E
 * (tests/e2e/hindsight-external.spec.ts) all drive this same stub so the wire
 * contract is exercised end-to-end without a real server.
 */
import http from "node:http";

/**
 * @typedef {Object} RecordedCall
 * @property {string} method
 * @property {string} path
 * @property {string|undefined} bank
 * @property {string|undefined} namespace
 * @property {any} body
 * @property {Record<string,string|string[]>} headers
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

function operationId(prefix = "op") {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Does a seeded memory's tags satisfy the request's tags + tags_match?
 *  Mirrors the real Hindsight recall semantics (openapi.json): `any`/`all` are the
 *  NON-strict variants that INCLUDE untagged/global memories; `any_strict`/
 *  `all_strict` EXCLUDE them. Within tagged memories, `all`/`all_strict` require
 *  every requested tag; `any`/`any_strict` require at least one. */
function tagsMatch(memTags, reqTags, mode) {
	if (!reqTags || reqTags.length === 0) return true;
	const have = new Set(memTags ?? []);
	// Untagged/global memory: included by the non-strict modes, excluded by `_strict`.
	if (have.size === 0) return mode !== "any_strict" && mode !== "all_strict";
	if (mode === "all" || mode === "all_strict") {
		return reqTags.every((t) => have.has(t));
	}
	return reqTags.some((t) => have.has(t));
}

function clone(x) {
	return x === undefined ? undefined : structuredClone(x);
}

export function startHindsightStub({ port = 0 } = {}) {
	/** @type {RecordedCall[]} */
	const calls = [];
	let healthy = true;
	/** When set, recall responds with this HTTP error: { status, detail }. Models the
	 *  data plane's 500-token "Query too long" 400 so the soft-skip can be exercised. */
	let recallError = null;
	let llmHealthy = true;
	/** bank → seeded/retained memory records */
	const seeded = new Map();
	/** bank → retained item records */
	const retainedByBank = new Map();
	/** bank → last-applied bank-config `updates` (mission PATCH) */
	const bankConfigByBank = new Map();
	/** bank → mental model id → model */
	const mentalModelsByBank = new Map();
	/** bank → directive id → directive */
	const directivesByBank = new Map();
	/** bank → operations */
	const operationsByBank = new Map();
	/** known bank ids (ensured / seeded / retained) */
	const banks = new Set();

	function bankMap(map, bank) {
		const existing = map.get(bank);
		if (existing) return existing;
		const created = new Map();
		map.set(bank, created);
		return created;
	}

	function opList(bank) {
		let list = operationsByBank.get(bank);
		if (!list) {
			list = [];
			operationsByBank.set(bank, list);
		}
		return list;
	}

	function addOperation(bank, type, status = "queued") {
		const op = { id: operationId(type), type, status, created_at: new Date().toISOString() };
		opList(bank).push(op);
		return op;
	}

	function memoryList(bank) {
		return seeded.get(bank) ?? [];
	}

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

		// PATCH /v1/{ns}/banks/{bank}/config  — update_bank_config (mission steering)
		if (method === "PATCH" && bank && segs[4] === "config" && segs.length === 5) {
			banks.add(bank);
			const updates = (body && typeof body === "object" && body.updates) || {};
			bankConfigByBank.set(bank, { ...(bankConfigByBank.get(bank) ?? {}), ...updates });
			return send(res, 200, { bank_id: bank, config: bankConfigByBank.get(bank) });
		}

		// POST /v1/{ns}/banks/{bank}/health/llm
		if (method === "POST" && bank && segs[4] === "health" && segs[5] === "llm") {
			if (!healthy) return send(res, 503, { detail: "unhealthy" });
			return send(res, 200, {
				ok: llmHealthy,
				retain: { ok: llmHealthy },
				consolidation: { ok: llmHealthy },
				reflect: { ok: llmHealthy },
			});
		}

		// Operations
		if (bank && segs[4] === "operations") {
			if (method === "GET" && segs.length === 5) return send(res, 200, { operations: opList(bank) });
			const opId = segs[5] ? decodeURIComponent(segs[5]) : undefined;
			if (method === "POST" && opId && segs[6] === "retry") {
				const op = opList(bank).find((x) => x.id === opId) ?? { id: opId };
				op.status = "queued";
				return send(res, 200, op);
			}
			if (method === "DELETE" && opId && segs.length === 6) {
				operationsByBank.set(bank, opList(bank).filter((x) => x.id !== opId));
				return send(res, 200, { ok: true });
			}
		}

		// Directives
		if (bank && segs[4] === "directives") {
			const directives = bankMap(directivesByBank, bank);
			if (method === "GET" && segs.length === 5) return send(res, 200, { directives: [...directives.values()] });
			if (method === "POST" && segs.length === 5) {
				const id = body?.id ?? `dir-${Math.random().toString(36).slice(2, 8)}`;
				const directive = { id, ...body };
				directives.set(id, directive);
				return send(res, 200, directive);
			}
			const id = segs[5] ? decodeURIComponent(segs[5]) : undefined;
			if (method === "PATCH" && id && directives.has(id)) {
				const directive = { ...directives.get(id), ...body };
				directives.set(id, directive);
				return send(res, 200, directive);
			}
			if (method === "DELETE" && id) {
				directives.delete(id);
				return send(res, 200, { ok: true });
			}
			if (id) return send(res, 404, { detail: "directive not found" });
		}

		// Mental models
		if (bank && segs[4] === "mental-models") {
			const models = bankMap(mentalModelsByBank, bank);
			if (method === "GET" && segs.length === 5) return send(res, 200, { mental_models: [...models.values()] });
			if (method === "POST" && segs.length === 5) {
				const id = body?.id ?? `model-${Math.random().toString(36).slice(2, 8)}`;
				if (models.has(id)) return send(res, 409, { detail: "mental model already exists" });
				const op = addOperation(bank, "mental-model-create");
				const model = {
					id,
					name: body?.name,
					source_query: body?.source_query,
					tags: body?.tags ?? [],
					max_tokens: body?.max_tokens,
					trigger: body?.trigger,
					content: body?.content ?? "",
					last_refreshed_at: null,
					is_stale: false,
					operation_id: op.id,
				};
				models.set(id, model);
				return send(res, 200, { mental_model_id: id, operation_id: op.id });
			}
			const id = segs[5] ? decodeURIComponent(segs[5]) : undefined;
			if (method === "GET" && id && segs.length === 6) {
				const model = models.get(id);
				return model ? send(res, 200, model) : send(res, 404, { detail: "mental model not found" });
			}
			if (method === "PATCH" && id && segs.length === 6) {
				const model = models.get(id);
				if (!model) return send(res, 404, { detail: "mental model not found" });
				const next = { ...model, ...body };
				models.set(id, next);
				return send(res, 200, next);
			}
			if (method === "DELETE" && id && segs.length === 6) {
				models.delete(id);
				return send(res, 200, { ok: true });
			}
			if (method === "POST" && id && segs[6] === "refresh") {
				const model = models.get(id);
				if (!model) return send(res, 404, { detail: "mental model not found" });
				const op = addOperation(bank, "mental-model-refresh");
				model.last_refreshed_at = new Date().toISOString();
				model.is_stale = false;
				model.operation_id = op.id;
				return send(res, 200, { operation_id: op.id });
			}
			if (method === "POST" && id && segs[6] === "clear") {
				const model = models.get(id);
				if (!model) return send(res, 404, { detail: "mental model not found" });
				const op = addOperation(bank, "mental-model-clear");
				model.content = "";
				model.operation_id = op.id;
				return send(res, 200, { operation_id: op.id });
			}
			if (method === "GET" && id && segs[6] === "history") {
				return send(res, 200, { history: [{ id, event: "created" }] });
			}
		}

		// POST /v1/{ns}/banks/{bank}/memories/recall  — recall_memories
		if (method === "POST" && bank && segs[4] === "memories" && segs[5] === "recall") {
			if (!healthy) return send(res, 503, { detail: "unhealthy" });
			if (recallError) return send(res, recallError.status, { detail: recallError.detail });
			const reqTags = body?.tags;
			const mode = body?.tags_match;
			const results = memoryList(bank)
				.filter((m) => m.state !== "invalidated")
				.filter((m) => tagsMatch(m.tags, reqTags, mode))
				.map((m) => ({
					id: m.id ?? `mem-${Math.random().toString(36).slice(2, 8)}`,
					text: m.text ?? m.content,
					...(m.score !== undefined ? { score: m.score } : {}),
					...(m.tags ? { tags: m.tags } : {}),
					...(m.document_id ? { document_id: m.document_id } : {}),
					...(m.entities ? { entities: m.entities } : {}),
					...(m.metadata ? { metadata: m.metadata } : {}),
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
			const mem = seeded.get(bank) ?? [];
			for (const it of items) {
				const record = { ...clone(it), async: isAsync, id: it.id ?? it.document_id ?? `ret-${Math.random().toString(36).slice(2, 8)}`, text: it.content };
				if (it.document_id && it.update_mode === "replace") {
					const idx = list.findIndex((x) => x.document_id === it.document_id);
					if (idx >= 0) list[idx] = record;
					else list.push(record);
					const memIdx = mem.findIndex((x) => x.document_id === it.document_id);
					if (memIdx >= 0) mem[memIdx] = record;
					else mem.push(record);
				} else {
					list.push(record);
					mem.push(record);
				}
			}
			retainedByBank.set(bank, list);
			seeded.set(bank, mem);
			return send(res, 200, {
				success: true,
				bank_id: bank,
				items_count: items.length,
				async: isAsync,
			});
		}

		// Memory curation/history/observations
		if (bank && segs[4] === "memories" && segs[5] && segs[5] !== "recall") {
			const id = decodeURIComponent(segs[5]);
			const mem = memoryList(bank);
			const idx = mem.findIndex((m) => (m.id ?? m.document_id) === id);
			if (method === "PATCH" && segs.length === 6) {
				if (idx < 0) return send(res, 404, { detail: "memory not found" });
				mem[idx] = { ...mem[idx], ...body };
				seeded.set(bank, mem);
				return send(res, 200, mem[idx]);
			}
			if (method === "GET" && segs[6] === "history") return send(res, 200, { history: idx >= 0 ? [{ id, state: mem[idx].state ?? "active" }] : [] });
			if (method === "DELETE" && segs[6] === "observations") return send(res, 200, { ok: true });
		}

		// POST /v1/{ns}/banks/{bank}/reflect  — reflect
		if (method === "POST" && bank && segs[4] === "reflect") {
			if (!healthy) return send(res, 503, { detail: "unhealthy" });
			const response = { text: `Reflection on: ${body?.query ?? ""}` };
			if (body?.response_schema) {
				response.structured_output = { ok: true, schema: body.response_schema };
			}
			return send(res, 200, response);
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
				setLlmHealthy(ok) {
					llmHealthy = ok;
				},
				setRecallError(err) {
					recallError = err ?? null;
				},
				seedMemories(bank, mem) {
					banks.add(bank);
					seeded.set(bank, [...(seeded.get(bank) ?? []), ...clone(mem)]);
				},
				seedMentalModel(bank, model) {
					banks.add(bank);
					bankMap(mentalModelsByBank, bank).set(model.id, clone(model));
				},
				seedDirective(bank, directive) {
					banks.add(bank);
					bankMap(directivesByBank, bank).set(directive.id, clone(directive));
				},
				retained(bank) {
					if (bank) return clone(retainedByBank.get(bank) ?? []);
					return clone([...retainedByBank.values()].flat());
				},
				recalledTypes(bank) {
					return calls
						.filter((c) => c.bank === bank && c.path.endsWith("/memories/recall"))
						.map((c) => c.body?.types)
						.reverse();
				},
				mentalModels(bank) {
					return clone([...(mentalModelsByBank.get(bank)?.values() ?? [])]);
				},
				directives(bank) {
					return clone([...(directivesByBank.get(bank)?.values() ?? [])]);
				},
				operations(bank) {
					return clone(opList(bank));
				},
				bankConfig(bank) {
					return bankConfigByBank.get(bank) ?? null;
				},
				close() {
					return new Promise((res) => server.close(() => res()));
				},
			});
		});
	});
}
