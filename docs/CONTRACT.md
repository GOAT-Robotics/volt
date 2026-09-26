# Volt — internal build contract

Stack: Next.js 16 (App Router, Turbopack, async `params`/`searchParams`), React 19, Tailwind v4 (tokens in `src/app/globals.css`),
Prisma 6 + SQLite (`prisma/schema.prisma`), Auth.js v5 (Entra ID + dev credentials login when `AUTH_DEV_LOGIN=true`), zod 4.

## Conventions
- Server helpers: `src/lib/session.ts` (`requireCtx()` for pages, `apiCtx()` for routes, `loadProject`, `can`, `HttpError`),
  `src/lib/versioning.ts` (`loadVersion`, `nextLabel`, `docHash`, `reindexVersion`, `sha256`), `src/lib/audit.ts` (`audit()`),
  `src/lib/notify.ts` (`notify()`), `src/lib/api.ts` (`route()` wrapper + `body(req, zodSchema)`), `src/lib/roles.ts`, `src/lib/settings.ts`,
  `src/lib/db.ts` (`db`, `J.parse`).
- Route handlers: `export const GET = route<{ id: string }>(async (req, { params }) => { const { id } = await params; ... return {...} })`.
- UI kit: `src/components/ui/{button,input,dialog,menu,misc,status}.tsx` (Button, Input, Textarea, Field, NativeSelect, Dialog/DialogContent/DialogFooter,
  Menu*, ContextMenu*, Tip, Popover*, Tabs*, Switch, Checkbox, Badge, Avatar, Card/CardHeader, Empty, Spinner, Table, Kbd, StatusBadge).
  App pages live under `src/app/(app)/…` and get the sidebar shell automatically; use `PageHeader` from `src/components/shell/AppShell.tsx`.
  Style: compact, clean (text-xs body, text-sm/base headings), tokens: bg-bg/bg-panel/bg-panel-2, text-fg/text-muted/text-subtle, border-border, accent.
  Toasts: `import { toast } from "sonner"`. Client fetch helper: `api()` in `src/lib/fetcher.ts`.
- Core (isomorphic, do NOT modify): `src/core/model.ts` (Doc model), `doc.ts` (`newDoc`, `newPage`), `qet/*` (`importQet`, `exportQet`, `parseElmt`, `serializeElmt`),
  `render/*` (`drawPage`, `drawElement`, `pageToSvg`, `exportPdf`, `SvgPainter`, `approxMeasure`, `CanvasPainter`), `diff.ts`, `validate.ts`, `numbering.ts`, `blocks.ts`, `stable-json.ts`.
- The diagram editor (`src/editor/**`, route `src/app/(editor)/projects/[projectId]/v/[versionId]`) is owned by the lead — don't edit it.
- Editor deep link: `/projects/{pid}/v/{vid}?page={pageId}&el={elementId}` focuses an element.
- Version statuses: DRAFT, IN_REVIEW, CHANGES_REQUESTED, APPROVED, REJECTED, SIGNED, RELEASED, SUPERSEDED, WITHDRAWN. Editable only in DRAFT/CHANGES_REQUESTED.
- Library element ids used in docs: `lib:{libraryElementId}@{revision}` with `def.source = { libraryElementId, revision, status }`.
- Dev servers: never use the default `.next`. Run with a private dist dir + port, e.g.
  `NEXT_DIST_DIR=.next-w PORT=3101 npx next dev -p 3101` (agent W) or `NEXT_DIST_DIR=.next-l npx next dev -p 3102` (agent L).
  Dev login: POST form on `/login` (email/name) — Playwright can sign in via the login page. Chromium at /opt/pw-browsers.
  Do not run `next build` (lead does integration builds).

## API used by the editor (must match exactly)
| Method & path | Request | Response |
|---|---|---|
| GET `/api/library/elements?q&scope=all\|org\|mine\|approved&kind=ELEMENT\|BLOCK&limit` | | `{ items: LibItem[] }` — LibItem = `{ id, kind, name, category, prefix, tags: string[], visibility: "PRIVATE"\|"SHARED"\|"ORG", status, revision, ownerName?, libraryName?, updatedAt?, description? }`. scope=all → everything the user may see (own + shared-with-me + ORG that is PUBLISHED/APPROVED); org → visibility ORG; approved → status APPROVED; mine → owner = me |
| GET `/api/library/elements/{id}?rev=N` | | `{ id, kind, name, category, prefix, revision, status, visibility, content, meta, description, tags }` (content = .elmt XML or block JSON string; `rev` selects a stored revision) |
| GET `/api/library/elements/{id}/preview.svg?rev=N` | | `image/svg+xml` symbol preview (immutable cache when rev given) |
| POST `/api/library/elements` | `{ name, category, prefix, visibility, content, description }` | `{ id, revision }` |
| POST `/api/library/blocks` | `{ name, description, category, visibility, content: BlockContent }` | `{ id, revision }` |
| POST `/api/library/import` | multipart `files` (.elmt / .zip; filename may carry a relative path → category) | `{ created, skipped, errors: string[] }` (into the user's personal library, PRIVATE) |
| GET `/api/library/status?ids=a,b` | | `{ items: Record<id, { revision, status } \| null> }` |
| GET `/api/versions/{id}/doc` | | `{ doc, label, status, docRev }` (exists) |
| PUT/POST `/api/versions/{id}/doc` | `{ doc, baseRev }` | `{ rev }` / 409 (exists) |
| GET `/api/versions/{id}/comments` | | `{ comments: { id, pageId, anchor, parentId, body, status, author: { id, name }, createdAt }[] }` |
| POST `/api/versions/{id}/comments` | `{ body, pageId?, anchor?, parentId?, mentions?: userId[] }` | `{ comment }` |
| PATCH `/api/comments/{id}` | `{ status: OPEN\|RESOLVED\|REJECTED\|REOPENED }` | `{ comment }` |
| GET `/api/users?q&role=review` | | `{ users: { id, name, email }[] }` |
| GET `/api/groups?q` | | `{ groups: { id /* Entra group id */, name }[] }` |
| GET `/api/versions/{id}/review` | | `{ review: null \| { id, status, dueDate, instructions, sequential, submittedBy, assignments: { id, order, userName, groupName, decision, reason, decidedAt, decidedByName }[] }, canDecide: boolean, blockers: string[] }` |
| POST `/api/reviews/{id}/decision` | `{ decision: APPROVED\|REJECTED\|CHANGES_REQUESTED, reason }` | `{ ok, versionStatus }` |
| GET `/api/projects/{id}/versions` | | `{ versions: { id, label, status, summary, createdAt, createdBy, parentLabel }[] }` (newest first) |
| POST `/api/projects/{id}/versions` | `{ parentId, summary, description?, ticket? }` | `{ id, label }` |
| POST `/api/versions/{id}/submit` | `{ reviewers: ({ userId } \| { groupId, groupName })[], dueDate, instructions, sequential }` | `{ reviewId }` |
| POST `/api/projects/{id}/attachments` | multipart `file, ownerType, ownerId` | `{ id }` |
| GET `/api/workspace/policy` | | `{ approval: ApprovalPolicy }` |
| GET `/api/projects/{id}/import-report` | | `{ report: CompatReport }` or 404 |
| POST `/api/versions/{id}/export-log` | `{ format, pages, markup }` | `{ ok }` (audit `project.export`) |
| GET `/api/style-templates/default` | | `{ id, name, version, styles }` |
| GET `/api/notifications` / POST `{ ids? , all? }` | | `{ items, unread }` / `{ ok }` |
