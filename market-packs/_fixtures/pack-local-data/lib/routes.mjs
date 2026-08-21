import fs from "node:fs";
import path from "node:path";

const MARKERS = ["ordinary-marker.txt", "pi-marker.txt", "host-marker.txt", "container-marker.txt"];

function directory(ctx) {
	if (!ctx.host?.capabilities?.has?.("localData") || !ctx.host.localData) {
		throw new Error("host.localData capability is unavailable");
	}
	return ctx.host.localData.directory();
}

function readMarkers(root) {
	return Object.fromEntries(MARKERS.map((name) => {
		const file = path.join(root, name);
		return [name, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null];
	}));
}

export const routes = {
	async snapshot(ctx) {
		const root = directory(ctx);
		return { directory: root, markers: readMarkers(root) };
	},
	async write(ctx, req) {
		const root = directory(ctx);
		const name = typeof req?.body?.name === "string" && MARKERS.includes(req.body.name)
			? req.body.name
			: "host-marker.txt";
		const content = typeof req?.body?.content === "string" ? req.body.content : "written-by-route";
		fs.writeFileSync(path.join(root, name), content, "utf8");
		return { directory: root, name, content };
	},
};
