import "definitely-not-installed-pi-extension-e2e-dependency";

export default function activate(pi: any) {
	pi.tool({ name: "pi_broken_never_visible", description: "This should never be discovered." }, async () => "unreachable");
}
