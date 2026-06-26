export default function activate(pi: any) {
	pi.tool({ name: "pi_scope_a_only", description: "Only installed for project A." }, async () => "project-a-only");
	pi.tool({ name: "pi_scope_shared", description: "Shared runtime name from project A." }, async () => "project-a-shared");
}
