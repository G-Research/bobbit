# Focused transcript reads
`read_session` avoids loading unrelated transcript data into agent context: use `operation="list"`, choose one zero-based message/result index, then use `operation="inspect"` for that exact target.
List output bounds text and tool arguments and omits result bodies/signatures; exact result excerpts support `offset`/`limit` continuation.
Direct REST/UI calls to `GET /api/sessions/:id/transcript` without `operation` keep the legacy query aliases and behavior; see [REST API](rest-api.md#transcript-reader-and-read_session).
