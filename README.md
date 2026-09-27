# Volt

A browser-based electrical diagram editor with a complete standard symbol library, an organization-wide component library, project-wide styles, controlled versions, review/approval, digital signatures and a full audit trail. Sign-in is Microsoft Entra ID.

Volt is a drawing and document-control tool. It does not simulate circuits, lay out PCBs, or certify anything. Its checks look for drawing consistency, not electrical safety.

---

## Quick start (macOS / Linux)

```bash
npm run setup      # installs deps, writes .env with secrets, creates the SQLite DB, seeds demo data
npm run dev        # http://localhost:3000
```

`setup` turns on the **development login** (`AUTH_DEV_LOGIN=true`), so you can sign in without Entra. Sign in as `admin@example.com`, the seeded admin. The seed also creates these accounts, one per role, for trying the workflow:

| email | name | role |
|---|---|---|
| approver@example.com | Asha Approver | Approver |
| reviewer@example.com | Riya Reviewer | Reviewer |
| signer@example.com | Sam Signatory | Signatory |
| designer@example.com | Dev Designer | Designer |

When you sign in with the dev form, enter the full seeded name. Signing checks the typed name against it.

### Microsoft Entra ID

```bash
az login
npm run entra                               # registers "Volt – Example Company", writes client id/secret/issuer to .env
npm run entra -- --url https://volt.example.com   # also adds the production redirect URI
```

Then set `AUTH_DEV_LOGIN="false"`. To give people access:

- `ADMIN_EMAILS` always get the Admin role.
- Users from `ALLOWED_EMAIL_DOMAINS` are added with `DEFAULT_ROLE`.
- Entra security groups can be mapped to roles under **Administration → Entra groups**. The app registration emits the `groups` claim.

Guests (B2B) follow the guest policy you set in Administration.

## Production (Docker)

The production image is built and published by GitHub Actions to GHCR. On the server, log in to GHCR with the supplied read-only `GITHUB_TOKEN`, copy `.env` into `/opt/volt`, and run `docker compose pull && docker compose up -d`.
The standard library, blocks and title blocks install automatically when the container starts.

- Data (SQLite DB + signing key) lives in the host bind directory `/opt/volt/data`, mounted at `/app/data`. Back it up.
- The container applies additive schema changes on start.
- `/api/health` is used by the healthcheck.
- Put it behind HTTPS (reverse proxy) and set `AUTH_URL` to the public URL.

## What's in it

**Editor** (`/projects/{id}/v/{versionId}`)
- **Canvas.** Custom Canvas2D engine with no size limit.
  - An R-tree spatial index culls everything off-screen.
  - Symbol paths and wire paths are cached. Wires are drawn in one native stroke per style.
  - Text layouts are cached. Detail is reduced when zoomed out.
  - On very large drawings, the last frame is reused while panning and zooming, then redrawn sharp when you stop.
  - A seeded stress drawing (3,000 components, 3,600 wires) takes about 8 ms to redraw fully, even with software rendering.
- **Snapping.** Snaps to pins, junctions, wire ends, existing wires (which creates a T-junction), alignment guides and the grid. The priority order is configurable, and **Alt** turns snapping off. A label shows the target, and a dot shows when a junction will be created.
- **Wires are real connections.**
  - Each end is attached to a pin, a junction or nothing (dangling).
  - Wires that cross never connect.
  - Moving or rotating a component re-routes its wires so they stay attached.
  - Dropping a component so its pin lands on a free wire end connects them. The connection points are highlighted before you drop.
- **Tools and panels.**
  - Tools: select, wire (orthogonal, click to add corners, Space flips the bend), text, pan, comment.
  - Left: library, pages, and find-in-drawing.
  - Right: inspector, comments & review, checks, and history & versions.
  - Command palette (⌘K), context menus, keyboard shortcuts (`?`), and undo/redo.
  - Autosave with conflict detection.
- **Clickable labels (cross references).** Component references (K1 coil ↔ K1 contacts), wire numbers, and folio-report / master–slave links are links.
  - ⌘/Ctrl-click a label to jump to its next occurrence on any page; on read-only versions a plain click works. Press `L` to follow the selection, ⌘[ or Alt+← to go back.
  - The inspector lists every occurrence with its page and grid reference (e.g. page 3 · 5C).
  - Exported PDFs carry the same links as internal PDF links.
- **Deleting.** Deleting a component leaves its wires in place with dangling ends (they reconnect when a component is dropped on them). Deleting a wire removes only that wire. Released or in-review versions are frozen and say so when you try to edit.
- **Global styles.** Every text role (component name, reference, pin number/name, wire/cable/terminal labels, title block…) and graphic (wires, junctions, pins, outlines, border) can be styled once for the whole project.
  - Styles stack: organization template → project → element → object override.
  - Changes preview live before you apply them.
  - Individual overrides can be seen and reset.
- **Numbering.** Rules per prefix or category with page, project or location scope and formats like `{page}{prefix}{n:2}`. You preview the renumbering before applying it. Locked references are kept, and duplicates are detected.
- **Blocks.** Save a selection as a reusable block with named ports. Place it as linked, derived or an independent copy, and update placed instances when the block changes.
- **Compare.** Compare two versions by overlay (removed items shown as red ghosts) or side by side with synced views, with a structured change list.
- **Export.** PDF (vector, multi-page, optional comment summary), SVG, PNG, DXF, and `.qet`.
- **Accessibility.** Keyboard alternatives for the canvas (Connect pins dialog, nudging, commands) and a screen-reader live region.

**Wiring and cables**
- **Conductor data.** Every wire can carry a function (power, L1–L3, N, PE, AC/DC control, interlock), an insulation color (IEC 60757 codes such as BK, BU, GN/YE, or any text) and a cross-section (mm², AWG or sq). Set them in the Conductor panel for one wire or many at once, or apply them to a whole net.
- **Standards.** Project → Wiring & cables picks IEC 60204-1 (EU), NFPA 79 / UL 508A (US) or JIS B 9960-1 (Japan). A wire without its own color gets the standard color for its function (e.g. red AC control, blue DC control, green-yellow PE), shown in that standard's notation and size unit.
- **On the drawing.** The wire number sits on one side of the wire and its color code + cross-section on the other, at the same spot, with a small tick. Texts never overlap: when space is short the number wins, then end markers, then the color/size, each moving along the wire or to the other side before being left out. A conductor color (the wire's own or its cable core's) is always drawn; the Appearance color applies only when none is set. Optionally wires take their function's standard color, and heavier lines mark larger cross-sections.
- **Wire numbers and ends.** A wire keeps one number end to end; it changes where the circuit passes through a device. The number can be written in the middle, at both ends, or both; destination marking adds the far terminal at each end ("1A-01-0 / X1:8"), and each end can be named by hand.
- **Cables.** Multi-core cables with tag, type, cores (HD 308 colors, numbered, DIN 47100), cross-section, shield and length. Selecting wires and choosing Cable → New cable creates one and assigns cores in drawing order (green-yellow goes to the PE wire). The drawing shows a cable mark across the bundle with the tag and type (dashed ellipse when shielded); clicking it selects the cable's wires. Wire and cable lists export as CSV.
- **Checks.** Green-yellow on a non-PE wire, PE in another color, a core used twice, more conductors than cores.

**Components**
- **Component info.** Name, rating, part number and manufacturer are stacked under the reference with even spacing, or placed right / left / below the symbol, aligned left, center or right. Each line has its own text role in Global styles (font, size, weight, color, visibility, line spacing, alignment); lines are shown or hidden per component, and the project default is set in Global styles → Component info or with "Use for all".
- **Style templates.** A fresh workspace gets three approved style templates: "IEC 61082 · ISO 3098 (monochrome)" (default; ISO 3098 lettering heights 1.8 / 2.5 / 3.5 / 5 mm, black), "NFPA 79 · ANSI (North America)" (Arial, sizes legible after reduction, part numbers shown) and "Screen review (color)", plus a "Standard control panel" project template. They are installed once at server start; later edits or deletions are kept.

**Library** (`/library`)
- **Standard library.** About 8,800 symbols (electric, logic, hydraulic, pneumatic, energy), starter circuit blocks (DOL starter, start/stop with self-holding, pilot lamp, relay, 24 V supply, terminal strip) and standard title blocks. They are installed into every workspace when the server starts, or with `npm run db:seed`, and updated in place when a newer collection ships.
- **Sharing.** Elements and blocks can be private, shared with named people (view or edit), or published to the whole organization. Org publishing can require approval.
- **History and provenance.** Every element keeps its revision history. Imported libraries keep their license and attribution. Import `.elmt` files, folders or `.zip` archives; export `.elmt` or `.zip`.
- **Element editor.** Canvas symbol editor with lines, rectangles, ellipses, arcs, polygons, text, dynamic text and pins; pin table; validation; live previews. A New-element wizard offers templates and SVG import.

**Document control**
- **Versions.** "Start new version" copies the current version, which stays unchanged. Version labels can be integer, decimal, letter or custom.
- **Review.** Submitting freezes the version. Reviewers can be people or Entra groups, in sequence or in parallel. Reviewers comment with @mentions and approve, reject or request changes, under the policy set in Administration.
- **Signatures and release.** Built-in, provider-neutral signing: fresh sign-in, Ed25519 seal over the version hashes, a signed release PDF with an evidence page, and a verification endpoint. See `docs/SIGNING.md`. Versions can then be released, superseded or withdrawn.
- **Traceability.** Notifications (in-app, email, Teams webhook), an audit log with CSV export, search across all versions, admin settings, and style and project templates.

## File compatibility

- **Import.** `src/core/qet` reads QET 0.3 to 0.100 projects. Anything it doesn't model is kept and written back unchanged, so an untouched project exports byte-identical. Tested on the bundled examples.
- **Compatibility report.** Shown on import and before export: what is supported, degraded, preserved-but-not-editable, or unsupported.
- **Junctions.** Volt junctions and dangling wire ends are exported as a tiny embedded `volt_junction` element, because QET has no free junctions. Volt recognizes them on re-import.
- **Limitations.** QET has no mirroring, so mirrored elements are exported unmirrored. Composite texts show their last computed value. Drawn lines, rectangles, ellipses and polylines can be selected, moved, reshaped, restyled and deleted, and are written back on export. Cross-references and terminal strips are kept and drawn, but can't be edited.

## Development

```bash
npm test              # vitest: core model, wires, topology, numbering, diff, validation, blocks, render, QET round-trips (270+ tests)
npm run typecheck
npm run test:e2e      # Playwright against a running dev server (PW_CHROMIUM=/path/to/chrome optional)
npm run db:studio
```

Layout: `src/core` (isomorphic model, QET I/O, rendering to Canvas/SVG/PDF/DXF), `src/editor` (canvas engine + editor UI), `src/library-editor` (symbol editor), `src/app` (Next.js routes/pages/APIs), `src/lib` (auth, permissions, workflow, signing, audit), `prisma` (SQLite schema + seed). `docs/CONTRACT.md` lists the API surface.

Stack: Next.js 16, React 19, Tailwind CSS 4, Prisma 6 + SQLite, Auth.js 5 (Entra ID), pdf-lib, rbush, immer, zustand.
