# Browser-uploaded attachments

Browser uploads let a user give the current coding agent a send-time file snapshot without first placing that file in the workspace. The browser supplies these bytes; a [binary `@` reference](at-mention-file-references.md#delivery-kinds) instead snapshots its bytes from the workspace resolver. After that distinct source capture, both enter the same authoritative, session-owned immutable document admission and use the same model-only pointer and policy-enabled bounded-tool delivery. Text `@` references remain `<file-reference>` blocks, and image references remain model image inputs.

Sharing this downstream document path does not merge the input limits. `@` scanning and resolution keep their authenticated-text, candidate, target, and delivery bounds; browser-supplied attachments keep the count, per-file, serialized-send, and durable session-quota limits documented below.

The design keeps three concerns separate:

- **Model context** identifies every document and may include a short text excerpt.
- **Presentation** keeps the chat bubble equal to what the user typed and shows attachment tiles.
- **Byte access** uses an opaque pointer and a bounded agent tool instead of putting document base64 in the prompt.

This separation gives the agent useful immediate context while keeping large or binary files out of model text and user-facing prompt copies.

## Selection and browser classification

The composer file picker accepts any file by default. `MessageEditor.acceptedTypes` remains an optional host integration restriction; a host may set an HTML `accept` value without changing the unrestricted default. File selection, drag-and-drop, and image paste share the existing count and per-file limits.

The browser loader handles files as follows:

1. PDF, DOCX, and PPTX files retain their specialized extraction and preview behavior. If specialized processing fails, the file remains attachable as a generic document.
2. Browser-declared image MIME types retain the existing image path. Images are sent as model image inputs and are not copied into uploaded-document storage.
3. Every other file is decoded with a fatal UTF-8 decoder and checked for binary-looking control characters. This byte-based test works for extensionless and unknown-extension text even when MIME metadata is absent or unhelpful.
4. Invalid UTF-8, NUL-containing data, and data with a high density of control characters remain binary documents. Bobbit retains their exact bytes rather than reporting an unsupported type.

The gateway never trusts client-provided `extractedText`. It recognizes specialized files first: PDF by extension, MIME type, or signature, and DOCX/PPTX by extension or MIME type. A recognized specialized file that cannot be parsed safely remains pointer-only; it does not fall through to generic text detection. Files not recognized as specialized use the exact admitted bytes for UTF-8 classification, independent of filename and MIME metadata.

## Authoritative prompt admission

`SessionManager` admits uploads before it creates a reliable queue row, display envelope, or model RPC. Admission is atomic: malformed metadata, mismatched sizes, invalid base64, duplicate identities, quota failure, or persistence failure rejects the prompt without dispatching it or leaving a visible queue carrier.

For each accepted document, the gateway:

1. decodes and validates the exact bytes;
2. derives text again from those bytes, including bounded PDF, DOCX, and PPTX extraction;
3. writes an immutable occurrence snapshot and manifest under Bobbit state;
4. returns an opaque `bobbit-attachment:v1:...` pointer; and
5. appends a `<user-attachment>` block to the model-facing prompt.

A readable document block contains escaped filename, MIME type, byte size, pointer, and a leading excerpt:

```xml
<user-attachment filename="notes.txt" mime-type="text/plain" size-bytes="1234" pointer="bobbit-attachment:v1:...">
<leading-excerpt>
first part of the admitted file
</leading-excerpt>
[EXCERPT TRUNCATED: more content is available. Read the immutable attachment at pointer "bobbit-attachment:v1:..." for the remainder.]
</user-attachment>
```

A binary document uses the same metadata block but embeds no content:

```xml
<user-attachment filename="firmware.opaque" mime-type="application/octet-stream" size-bytes="4096" pointer="bobbit-attachment:v1:...">
Binary content is not embedded in the prompt. Read the immutable attachment at pointer "bobbit-attachment:v1:...".
</user-attachment>
```

Excerpt accounting uses UTF-8 bytes as conservative token units. The current defaults are 2,048 units per file and 8,192 units across one prompt, defined by `UPLOADED_ATTACHMENT_PER_FILE_TOKEN_BUDGET` and `UPLOADED_ATTACHMENT_AGGREGATE_TOKEN_BUDGET`. Iteration is Unicode-safe and never splits a scalar value. Metadata and excerpt markup are escaped before insertion, and truncation is always explicit.

The server retains at most 3 KiB of derived text per document manifest before the smaller model-context budgets are applied. Specialized extractors also bound pages, ZIP entries, expanded OOXML data, and text nodes; malformed or suspicious specialized files fall back to pointer-only delivery rather than trusting browser extraction.

## Visible text and reliable delivery

The model-facing text is intentionally different from the displayed prompt. A generalized display envelope records:

- the exact model text used for dispatch;
- the original composer text;
- the prompt occurrence ID; and
- safe attachment tile metadata (`id`, kind, basename, MIME type, size, and an optional validated preview).

Document bytes, extracted text, and pointers do not enter outward attachment metadata. Queue and in-flight projections expose the original text and tile metadata, while the internal reliable row retains the model text needed for dispatch. The same projection boundary is used for live message events, restored history, title generation, and Copy Prompt.

Occurrence identity, rather than prompt text, associates the envelope with the Pi transcript row. This matters when two prompts have identical text: each occurrence keeps only its own attachments. An append-only transcript binding makes the association durable after Pi acknowledges the row; ambiguous or conflicting associations fail closed instead of borrowing another prompt's tiles.

Because admission happens before all reliable delivery paths, the immutable pointer and model context survive direct dispatch, queue persistence, gateway recovery, explicit retry, automatic retry, and browser reload. Recovery framing may wrap the model text, but it does not change the attachment pointer or leak the model-only context into presentation.

## Reading more with `session_attachment`

The first-party `session_attachment` tool provides read-only access to uploaded document snapshots owned by the current session. It must be available under the session's tool policy.

| Operation | Parameters | Result |
|---|---|---|
| `list` | `pointer` | Metadata for every document in the pointer's accepted prompt occurrence |
| `read` | `pointer`, optional `offset`, optional `length` | A byte-exact base64 range plus `bytesRead`, `nextOffset`, and `eof` |

`offset` defaults to zero. `length` defaults to and cannot exceed 65,536 bytes (`MAX_UPLOADED_ATTACHMENT_READ_BYTES`). Base64 exists only as bounded tool transport; the agent must decode it before interpreting UTF-8 or a binary format. Repeated reads advance with `nextOffset` until `eof`.

Example:

```text
session_attachment(operation="list", pointer="bobbit-attachment:v1:...")
session_attachment(operation="read", pointer="bobbit-attachment:v1:...", offset=0, length=65536)
```

The tool never accepts a filesystem path. Its pointer resolves the exact send-time snapshot, not a current workspace file or host path.

## Limits

The gateway authoritatively enforces these limits; composer defaults mirror the primary count, size, and serialized-frame limits.

| Boundary | Current limit | Reason |
|---|---:|---|
| Combined images and documents per prompt | 10 | Bounds UI, validation, and model payload work |
| Exact bytes per file | 20 MiB | Bounds decoding, persistence, and integrity verification |
| Exact document bytes per occurrence | 200 MiB | Bounds one immutable admission transaction |
| Serialized prompt frame | 200 MiB | Rejects base64-expanded sends before the WebSocket payload limit |
| Durable document bytes and previews per session | 1 GiB | Prevents unbounded retained session storage |
| Model excerpt per document | 2,048 UTF-8 byte units | Gives immediate context without flooding the prompt |
| Aggregate model excerpts per prompt | 8,192 UTF-8 byte units | Bounds multi-document context growth |
| Tool range response | 64 KiB | Keeps agent reads incremental and memory-bounded |

The serialized-frame guard includes text, image data, document data, previews, and extracted text as sent by the browser. Because base64 expands bytes, it can reject a group of files before their raw-byte totals reach the document occurrence limit. Document previews are also charged to the durable session quota.

Range reads verify a complete admission-bounded snapshot before returning the requested slice. The gateway permits only a small fixed number of concurrent full-snapshot read reservations; excess reads fail as busy and can be retried. This prevents many 64 KiB calls from causing unbounded full-file verification allocations.

## Security and storage boundaries

Attachment fields are untrusted client input. Admission validates plain-object shapes, exact field sets, canonical base64, decoded size, combined count, metadata bounds, safe opaque IDs, browser basenames, image/document correspondence, and aggregate limits. It rejects path separators and control characters in presentation filenames, so client metadata cannot disclose or manufacture a host path.

Snapshots are stored under hashed session and occurrence directories with random filename-safe keys. Pointers contain only those opaque hashes and keys; they contain no session UUID, occurrence text, filename, or storage path. Files and manifests are created with restrictive permissions and symlinks are rejected. Every read checks manifest shape, session ownership, file type and size, then hashes the complete opened snapshot before returning any range. This detects storage corruption and blob-only modification; an integrity failure returns no attachment bytes.

Tool requests require the private capability secret for the exact URL session and a live session whose policy still allows the tool. Sandboxed sessions additionally require attestation that the requesting session owns the exact isolated runtime. Session identity, lifecycle generation, runtime, sandbox state, container, capability, and tool policy are checked again immediately before response bytes are written. Termination, replacement, or revocation during a read therefore fails closed.

The Pi transcript used for recovery and history projection is separate from uploaded-attachment storage. A sandboxed session runtime mounts only its owner transcript root at Pi's standard container path. Gateway transcript reads and mutations run as fixed, bounded operations inside that exact registered runtime after fresh Docker attestation; archived or store-only access uses a short-lived isolated runtime. There is no shared project-container or container-path-to-host fallback, so missing runtime authority fails closed instead of risking a sibling transcript or a path-swap race.

Sandboxed per-session containers do not mount uploaded-attachment storage, so the bounded tool is their byte-access path. Direct, non-sandboxed agents instead run as the gateway's OS user in Bobbit's existing host-admin trust domain. Owner-only permissions, capability secrets, and digest verification do not isolate gateway state from hostile same-user code that can rewrite both a blob and its manifest. Use sandboxed per-session execution when adversarial isolation is required.

A prompt occurrence is idempotent: retrying the same occurrence with the same admitted content reuses its snapshot, while different content under that occurrence ID is a conflict. Persisted queue and sidecar records preserve the occurrence association across restart. Permanent session purge removes its uploaded snapshots, and startup recovery removes orphaned roots and incomplete temporary writes. Ordinary session retention keeps snapshots available so reload and delivery recovery can still resolve their pointers.

## Implementation and coverage map

Use these boundaries when changing the feature:

- Browser selection and loading: the message editor and attachment utility under `src/ui/`.
- UTF-8 classification and model context: `src/shared/uploaded-attachment-text.ts` and `src/shared/uploaded-attachment-context.ts`.
- Admission and outward presentation: the session manager, attachment display validator, and prompt display sidecar under `src/server/`.
- Snapshot persistence and specialized extraction: the uploaded attachment store and specialized document extractor under `src/server/agent/`.
- Agent tool and authorization: `src/server/uploaded-attachment-routes.ts` and `defaults/tools/attachments/`.

Pinning coverage lives in the uploaded-attachment unit suites, `tests/dom/attachment-upload.dom.test.ts`, `tests/dom/uploaded-attachment-binary-text-repro.dom.test.ts`, `tests/integration/gateway/uploaded-attachment-tool.gateway.test.ts`, sandbox security integration coverage, and the attachment journey in `tests/browser/journeys/misc.journey.spec.ts`. Test discovery is derived from these canonical paths and semantic suffixes.

## Related behavior

Attachment-only prompts still receive the synthetic model body described in [Image / attachment-only prompts](image-attachment-only-prompts.md). Uploaded-document context is appended after that normalization, while the displayed composer text remains empty.
