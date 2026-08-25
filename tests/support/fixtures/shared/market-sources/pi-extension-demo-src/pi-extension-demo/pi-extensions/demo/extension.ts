type DemoInput = { message?: string; suffix?: string };

export default function activate(pi: any) {
	pi.tool({
		name: "pi_demo_echo",
		description: "Echoes a message from the marketplace pi extension fixture.",
		inputSchema: {
			type: "object",
			properties: {
				message: { type: "string" },
				suffix: { type: "string" },
			},
		},
	}, async (input: DemoInput = {}) => {
		const message = input.message || "hello from pi extension";
		const suffix = input.suffix || "";
		return { ok: true, echoed: `${message}${suffix}`, source: "pi-extension-demo" };
	});
}
