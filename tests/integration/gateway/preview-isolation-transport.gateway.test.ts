import http from "node:http";

import { expect, test } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { PREVIEW_COOKIE_NAME } from "../../../src/server/auth/cookie.js";

interface HttpResult {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

function request(
	baseURL: string,
	path: string,
	options: { method?: string; headers?: http.OutgoingHttpHeaders } = {},
): Promise<HttpResult> {
	const target = new URL(baseURL);
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: "127.0.0.1",
			port: Number(target.port),
			path,
			method: options.method ?? "GET",
			headers: { Host: target.host, ...options.headers },
		}, response => {
			const chunks: Buffer[] = [];
			response.on("data", chunk => chunks.push(Buffer.from(chunk)));
			response.on("end", () => resolve({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		req.once("error", reject);
		req.end();
	});
}

function previewCookie(headers: http.IncomingHttpHeaders): string {
	const serialized = Array.isArray(headers["set-cookie"])
		? headers["set-cookie"].find(value => value.startsWith(`${PREVIEW_COOKIE_NAME}=`))
		: headers["set-cookie"];
	const pair = serialized?.split(";", 1)[0];
	expect(pair).toMatch(new RegExp(`^${PREVIEW_COOKIE_NAME}=`));
	return pair!;
}

test("keeps credentialed null-origin CORS inside the authenticated preview route", async ({ gateway, scope }) => {
	const session = await scope.createSession({});
	const mounted = await gateway.api(`/api/preview/mount?sessionId=${session.id}`, {
		method: "POST",
		body: JSON.stringify({ html: "<!doctype html><svg><title>isolated</title></svg>", workspaceTab: false }),
	});
	const mountBody = await mounted.text();
	expect(mounted.status, mountBody).toBe(200);
	const previewPath = (JSON.parse(mountBody) as { url: string }).url;

	const initial = await request(gateway.baseURL, previewPath, {
		headers: {
			Authorization: `Bearer ${gateway.token}`,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Dest": "iframe",
		},
	});
	expect(initial.status, initial.body).toBe(200);
	expect(initial.headers["content-security-policy"]).toContain("sandbox allow-scripts");
	expect(initial.headers["content-security-policy"]).not.toContain("allow-same-origin");
	const capability = previewCookie(initial.headers);

	const opaqueHeaders = {
		Origin: "null",
		Cookie: capability,
		"Sec-Fetch-Site": "cross-site",
		"Sec-Fetch-Mode": "cors",
		"Sec-Fetch-Dest": "empty",
	};
	const resource = await request(gateway.baseURL, previewPath, { headers: opaqueHeaders });
	expect(resource.status, resource.body).toBe(200);
	expect(resource.headers["access-control-allow-origin"]).toBe("null");
	expect(resource.headers["access-control-allow-credentials"]).toBe("true");
	expect(String(resource.headers.vary).toLowerCase().split(/\s*,\s*/)).toContain("origin");

	const { Cookie: _capability, ...uncredentialedHeaders } = opaqueHeaders;
	const uncredentialed = await request(gateway.baseURL, previewPath, {
		headers: uncredentialedHeaders,
	});
	expect(uncredentialed.status).toBe(403);
	expect(uncredentialed.headers["access-control-allow-origin"]).toBeUndefined();
	expect(uncredentialed.headers["access-control-allow-credentials"]).toBeUndefined();

	const invalidCapability = await request(gateway.baseURL, previewPath, {
		headers: { ...opaqueHeaders, Cookie: `${PREVIEW_COOKIE_NAME}=invalid` },
	});
	expect(invalidCapability.status).toBe(401);
	expect(invalidCapability.headers["access-control-allow-origin"]).toBeUndefined();
	expect(invalidCapability.headers["access-control-allow-credentials"]).toBeUndefined();

	const api = await request(gateway.baseURL, "/api/health", {
		headers: {
			Authorization: `Bearer ${gateway.token}`,
			Origin: new URL(gateway.baseURL).origin,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
			"Sec-Fetch-Dest": "empty",
		},
	});
	expect(api.status, api.body).toBe(200);
	expect(api.headers["access-control-allow-credentials"]).toBeUndefined();
});
