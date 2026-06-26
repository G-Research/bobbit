export default function activate(pi: any) {
	pi.tool({ name: "pi_scope_b_only", description: "Only installed for project B." }, async () => "project-b-only");
	pi.tool({ name: "pi_scope_shared", description: "Shared runtime name from project B." }, async () => "project-b-shared");
}
