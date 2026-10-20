# Volt MCP server

Volt runs a [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude — or any
other assistant or IDE that speaks MCP — can open projects, review drawings, and fix wiring and
naming in working drafts, as the person who connected it.

- Endpoint: `POST /api/mcp` — Streamable HTTP, stateless JSON responses (protocol versions
  2025-06-18, 2025-03-26, 2024-11-05). No SSE stream, no session id.
- Auth: `Authorization: Bearer volt_pat_…` — a personal access token. Cookies are never accepted
  on this endpoint, so the same-origin check for other API routes does not apply to it.
- Code: `src/app/api/mcp/route.ts` (HTTP), `src/lib/mcp/protocol.ts` (JSON-RPC), `src/lib/mcp/tools.ts`
  (tool registry) with `tools-drawing.ts`, `tools-sheets.ts`, `tools-project.ts`, `tools-workflow.ts`,
  `src/lib/mcp/kit.ts` (versions, editing, undo), `src/lib/mcp/doc.ts` (addressing and text views),
  `edits.ts` / `sheets.ts` / `project.ts` (drawing changes), `files.ts` (exports), `tokens.ts` (tokens).
  Tests: `src/lib/mcp/__tests__/`.

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
| Change working drafts, undo, commit, restore, start a version | – | ✓ (with the Edit permission, if the workspace allows assistant edits) |
| Submit for review, take back from review | – | ✓ (same rules as in the app; only when the person asks) |
| Add to their personal library (symbols, blocks) | – | ✓ |
| Export files | ✓ (with the Export permission) | ✓ |

- Changes only ever go into **working versions** (Draft, Changes requested). Versions in review,
  approved, signed, released or imported are refused; `start_new_version` makes a new draft.
- Assistants never approve, sign or release — there are no tools for it. Submitting for review and
  taking a version back follow the app's rules (author / submitter / owners).
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

69 tools, grouped like the editor. Read tools carry `readOnlyHint`; everything that changes a drawing
needs an edit token and a working version.

| Area | Read | Change |
|---|---|---|
| Projects & reading | `list_projects`, `get_project`, `get_drawing` (start here), `list_components`, `get_component` (all parts, mates, arrow links, block, library source, what every pin connects to), `list_wires`, `get_netlist`, `render_page` (PNG) | — |
| Review | `check_drawing`, `list_comments` | `add_comment`, `reply_to_comment`, `set_comment_status` |
| Components | — | `place_component` (rotation, mirrored, scale), `move_component`, `arrange_components` (rotate, mirror, resize, lock, hide, align, distribute), `style_components` (pin numbers / names, info lines and placement, reference direction, symbol colour, outline box, text styles, reset, project default), `rename_component`, `set_component_data` (incl. BOM quantity / unit / inclusion, custom fields), `renumber_components`, `mate_connectors` (plug ↔ socket), `link_offpage_arrows`, `replace_symbol`, `set_symbol_pins` (number, name, pin class, volts), `copy_components`, `delete_component` |
| Wires & cables | `list_cables` | `connect_pins`, `draw_wire` (pins, T onto a wire, junction, free point, via points), `route_wire` (path, re-route, reconnect an end), `set_wire` (number, potential, use, supply, colour, section, cable / core, end markers, label position, bus, line style, apply to the net), `straighten_wires` (line components up with what they connect to, fix sizes that put pins off the grid, draw straight; `preview` = picture only), `number_wires`, `convert_lines_to_wires`, `set_cable`, `delete_wires` |
| Terminals | `get_terminal_strips` | `edit_terminal_strip` (create, rename, order, renumber, types, levels, bridges, part numbers, spares, move between strips, delete), `place_terminals` |
| Pages & annotations | `list_page_items` | `add_page` (drawing, cover, contents, terminal diagrams, copy), `update_page` (name, position, type, border, title block, terminal diagram, archive), `delete_page`, `set_cover_sheet`, `add_text`, `add_shape` (shapes and pictures), `update_item`, `delete_items`, `edit_title_block_template` |
| Project settings | `get_settings` | `update_settings` (properties, revisions, numbering rules, wire numbering and supplies, wiring display, styles), `update_project` (name, number, description, tags) |
| Library & blocks | `search_library` (symbols, blocks) | `create_component`, `save_symbol_to_library` (one symbol, or several merged), `update_from_library`, `place_block`, `create_block`, `manage_block` (update, detach, linked / derived) |
| History & workflow | `list_history`, `compare_versions` (with a version, a commit `#12`, or the uncommitted changes) | `undo`, `commit_changes`, `restore_commit`, `start_new_version`, `submit_for_review`, `recall_from_review` |
| Reports & files | `get_report` (BOM, wire list, terminal plan, cable list), `export_file` | — |

`create_component` draws a new library symbol from shapes and pins (the same small drawing
language as Library → New element → *Describe or sketch (AI)*, `src/lib/library/ai-symbol.ts`),
returns a picture of it, and saves it to the person's personal library as a private draft
(`save: false` = picture only; `revise: <library_id>` = next revision of a component they created and
have not published). Publishing to the organization stays in Library, with its approval workflow.

Prompts: `review_drawing` (engineering review posted as comments), `fix_connectors` (mate plugs and
sockets, proper connector symbols and part data) and `fix_naming`.

### Straightening wires

`straighten_wires` is the editor's *Straighten wires* (⇧S): with `components` (references, or `all`
for every unlocked one on the page) each is shifted along its pins' axis by the amount that puts the
most of its wires in line with their other ends, never taking a straight wire out of line, never onto
another component, never more than 100 units (moving further is a layout decision). A plug and socket
mated at the same place move together, and chains (arrow → connector → device) line up in order.
Components drawn at a size that puts their pins off the grid (146 %, say) get the nearest
grid-friendly size when that lines up more wires (`fix_sizes: false` keeps sizes). Then every wire
that can be straight is drawn straight — unless the line would cross a symbol or run along another
wire — and doubled-back stubs are dropped; `reroute: true` also gives the rest the route with the
fewest bends that crosses no symbol and no more wires than now. Without `components` nothing moves.
The answer says what moved, what stayed and why, and which wires still bend.

### Undo

Every change through MCP keeps its inverse (id-addressed operations, like the editor's undo), per
version and access token: `undo` reverts the last ones — other people's changes made in between are
kept — and `undo list: true` shows them. The history lives in the server's memory (lost on restart);
`compare_versions` and `restore_commit` reach older states.

### Files

`export_file` makes the file once (so permission or page errors show at once) and returns a signed
download link — `/api/mcp/files/<token>`, valid one hour, no cookie needed — as text and, for
protocol 2025-06-18 clients, as a `resource_link`. The file is made again when the link is opened
(the drawing as it is then). The link names the access token: revoking the token, the person losing
access, or the workspace turning the MCP server off stops it. Links are signed with a key derived
from `AUTH_SECRET` (without it, a per-process key: links stop working on restart). Downloads are in
the audit log as `project.export` with `via: "mcp: <token name>"`. The address comes from `APP_URL`
(else `AUTH_URL`, else the request's host).

Code: `src/lib/mcp/kit.ts` (shared: versions, editing, undo), `tools*.ts` (tools by area),
`edits.ts`, `sheets.ts`, `project.ts` (the changes, unit tested in `__tests__/features.test.ts`),
`files.ts` + `src/app/api/mcp/files/[token]/route.ts` (files).

## Addresses

- **Version**: `DEMO-001` (the project's working version, else its newest), `DEMO-001@2`, or an id.
- **Page**: number in sheet order (`2`), title, or id. **Cell**: border column + row (`3C`).
- **Component**: reference `K1`; `K1@2` = the part on page 2; `#1a2b3c4d` = by id (any unique prefix
  of 6+ characters). Contacts without their own reference are listed as `→K1`.
- **Pin**: `K1:A1` (number or name), `X1:3:1` for terminals, `p1`, `p2` … for unnamed pins.
- **Wire**: `#1a2b3c4d` from `list_wires`, or a wire number carried by one conductor.
- **Text, shape, junction**: `#1a2b3c4d` from `list_page_items`.
- **Commit**: `#12` (from `list_history`).

## Trying it

```bash
TOKEN=volt_pat_…
curl -s https://volt.example.com/api/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_drawing","arguments":{"version":"DEMO-001"}}}'
```

Or `npx @modelcontextprotocol/inspector` with transport *Streamable HTTP*, the URL above and an
`Authorization` header.
