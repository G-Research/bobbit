import fs from "node:fs";
import path from "node:path";

const PACK_ID = "pack-local-data";
const ENV_NAME = "BOBBIT_PACK_LOCAL_DATA_JSON";

type MarkerInput = { operation?: "read" | "write"; name?: string; content?: string };

function directory(): string {
	const raw = process.env[ENV_NAME];
	if (!raw) throw new Error(`${ENV_NAME} is unavailable`);
	const value = JSON.parse(raw)?.[PACK_ID];
	if (typeof value !== "string" || !value) throw new Error(`No local-data binding for ${PACK_ID}`);
	return value;
}

export default function activate(pi: any) {
	pi.tool({
		name: "pi_local_data_marker",
		description: "Read or write a fixed marker in this pack's project-local data directory.",
		inputSchema: {
			type: "object",
			properties: {
				operation: { type: "string", enum: ["read", "write"] },
				name: { type: "string", enum: ["pi-marker.txt", "container-marker.txt", "host-marker.txt", "ordinary-marker.txt"] },
				content: { type: "string" },
			},
		},
	}, (input: MarkerInput = {}) => {
		const root = directory();
		const name = input.name || "pi-marker.txt";
		const file = path.join(root, name);
		if (input.operation === "read") {
			return { directory: root, name, content: fs.readFileSync(file, "utf8") };
		}
		const content = input.content || "written-by-pi";
		fs.writeFileSync(file, content, "utf8");
		return { directory: root, name, content };
	});
}
