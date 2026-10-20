# Volt MCP server

Volt runs a [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude — or any
other assistant or IDE that speaks MCP — can open projects, review drawings, and fix wiring and
naming in working drafts, as the person who connected it.

- Endpoint: `POST /api/mcp` — Streamable HTTP, stateless JSON responses (protocol versions
  2025-06-18, 2025-03-26, 2024-11-05). No SSE stream, no session id.
- Auth: `Authorization: Bearer volt_pat_…` — a personal access token. Cookies are never accepted
  on this endpoint, so the same-origin check for other API routes does not apply to it.
- Code: `src/app/api/mcp/route.ts` (HTTP), `src/lib/mcp/protocol.ts` (JSON-RPC), `src/lib/mcp/tools.ts`
  (tools), `src/lib/mcp/doc.ts` (addressing and text views), `src/lib/mcp/edits.ts` (drawing changes),
  `src/lib/mcp/tokens.ts` (tokens). Tests: `src/lib/mcp/__tests__/edits.test.ts`.

## Connecting

Each person creates a token under **Connect AI** (sidebar): a name, access (*read and check* or
*read, comment and edit*), and an expiry. The token is shown once, with ready-made snippets:

```bash
# Claude Code
claude mcp add --transport http volt https://volt.example.com/api/mcp --header "Authorization: Bearer <token>"
```

```jsonc
// Cursor, .mcp.json and other clients that speak HTTP
{ "mcpServers": { "volt": { "type": "http", "url": "https://volt.example.com/api/mcp", "headers": { "Authorization": "Bearer <token>" } } } }

// Claude Desktop and other stdio-only clients, through mcp-remote (Node.js)
{ "mcpServers": { "volt": { "command": "npx", "args": ["-y", "mcp-remote", "https://volt.example.com/api/mcp", "--header", "Authorization:${VOLT_AUTH}"], "env": { "VOLT_AUTH": "Bearer <token>" } } } }
```

The address shown uses `APP_URL` (else `AUTH_URL`, else the request's host). Behind a proxy, the
MCP client must reach that address.

## Who can do what

An assistant works **as the token's owner**, in the token's workspace: the same workspace roles and
project memberships, checked by the same code as the web app (`loadProject`, `loadVersion`). On top:

| | Read & check token | Read, comment & edit token |
|---|---|---|
| Read projects, drawings, netlist, rule checks, pictures, comments, library | ✓ | ✓ |
| Comment, reply, resolve | – | ✓ (with the Comment permission) |
| Change working drafts, commit, start a version | – | ✓ (with the Edit permission, if the workspace allows assistant edits) |

- Changes only ever go into **working versions** (Draft, Changes requested). Versions in review,
  approved, signed, released or imported are refused; `start_new_version` makes a new draft.
- Assistants never approve, sign or release — there are no tools for it.
- Every change is applied like an editor change: when someone has the version open, through the
  live collaboration room (they see it at once, attributed to "Name (via token name)"); otherwise
  saved with the same optimistic revision check as an editor save.
- Every change is in the audit log as `mcp.edit` (tool, summary, token name); comments and commits
  carry `via: "mcp: <token name>"`.
- Administration → General → **AI assistants (MCP)**: turn the server off (every token is refused),
  or keep it read/check/comment only.
- Tokens: only the SHA-256 is stored; the owner (or a workspace admin) revokes them; they expire;
  a disabled account or an external partner past their end date stops every token at once; 300
  requests per minute per token.

## Tools

Read (`readOnlyHint`):

| Tool | |
|---|---|
| `list_projects`, `get_project` | projects, versions, variants, open reviews |
| `get_drawing` | start here: status, whether you may edit, pages, counts, numbering rules |
| `list_components`, `get_component` | references, cells, symbols, data, pins; a device's parts and what each pin connects to |
| `list_wires`, `get_netlist` | conductors with ids, numbers, ends, potential, colour, section; nets across sheets |
| `check_drawing` | electrical rule check + drawing validation (same as the AI reviewer) |
| `render_page` | PNG of a sheet (image content) |
| `list_comments`, `search_library` | review threads; library symbols for `place_component` |

Comment: `add_comment` (pinned to a component, wire or page), `reply_to_comment`, `set_comment_status`.

Edit: `rename_component` (all parts of the device, locked), `set_component_data`,
`renumber_components` (close gaps / by rules, `dry_run`), `number_wires` (`dry_run`), `set_wire`,
`connect_pins`, `delete_wires`, `place_component`, `move_component`, `delete_component`,
`commit_changes`, `start_new_version`.

Library: `create_component` draws a new symbol from shapes and pins (the same small drawing
language as Library → New element → *Describe or sketch (AI)*, `src/lib/library/ai-symbol.ts`),
returns a picture of it, and saves it to the person's personal library as a private draft
(`save: false` = picture only; `revise: <library_id>` = next revision of a component they created and
have not published). Place it with `place_component library_id=…`; publishing it to the
organization stays in Library, with its approval workflow.

Prompts: `review_drawing` (engineering review posted as comments) and `fix_naming`.

## Addresses

- **Version**: `DEMO-001` (the project's working version, else its newest), `DEMO-001@2`, or an id.
- **Page**: number in sheet order (`2`), title, or id. **Cell**: border column + row (`3C`).
- **Component**: reference `K1`; `K1@2` = the part on page 2; `#1a2b3c4d` = by id (any unique prefix
  of 6+ characters). Contacts without their own reference are listed as `→K1`.
- **Pin**: `K1:A1` (number or name), `X1:3:1` for terminals, `p1`, `p2` … for unnamed pins.
- **Wire**: `#1a2b3c4d` from `list_wires`, or a wire number carried by one conductor.

## Trying it

```bash
TOKEN=volt_pat_…
curl -s https://volt.example.com/api/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_drawing","arguments":{"version":"DEMO-001"}}}'
```

Or `npx @modelcontextprotocol/inspector` with transport *Streamable HTTP*, the URL above and an
`Authorization` header.
