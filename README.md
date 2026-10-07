# Volt

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A free, open-source, browser-based electrical diagram editor with a complete standard symbol library, an organization-wide component library, project-wide styles, controlled versions, review/approval, digital signatures and a full audit trail. Sign-in is Microsoft Entra ID.

Volt is a drawing and document-control tool. It does not simulate circuits, lay out PCBs, or certify anything. Its checks look for drawing consistency, not electrical safety.

https://github.com/user-attachments/assets/64a9a26a-7b25-42a1-9c05-e5f1f272d151

<p align="center"><sub><b>Launch film (1:21)</b> — live collaboration, git-like version control and customer variants, the Volt AI Reviewer, harness wire numbering, label printing, terminal diagrams and signed releases. <a href="docs/media/volt-film.mp4">Full-resolution 1080p</a> · made by GOAT Robotics with help from Claude.</sub></p>

---

## Quick start (macOS / Linux)

```bash
npm run setup      # installs deps, writes .env with secrets, creates the SQLite DB, seeds demo data
npm run dev        # http://localhost:3000
```

`setup` turns on the **development login** (`AUTH_DEV_LOGIN=true`), so you can sign in without Entra. Sign in as the first address in `ADMIN_EMAILS` (`admin@example.com` in `.env.example`), the seeded admin. The seed also creates these accounts (on the admin's email domain), one per role, for trying the workflow:

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
npm run entra                               # registers "Volt" (or $VOLT_APP_NAME), writes client id/secret/issuer to .env
npm run entra -- --url https://volt.example.com   # also adds the production redirect URI
```

Then set `AUTH_DEV_LOGIN="false"`. To give people access:

- `ADMIN_EMAILS` always get the Admin role.
- Users from `ALLOWED_EMAIL_DOMAINS` can sign in but need a workspace role under **Administration → Members** and project membership before they can access a project. The role for new people is set in **Administration → General → Access**; **Remove Viewer access** in Members revokes access from people who were added automatically before.
- Entra security groups can be mapped to roles under **Administration → Entra groups**. The app registration emits the `groups` claim.

Guests (B2B) follow the guest policy you set in Administration.

### External users (no organization account)

Contractors, customers and suppliers can work in Volt without an Entra account. Under **Administration → External users** an admin adds them with a **custom role** and the **projects** they work on, and optionally an end date for their access.

- They sign in with a **one-time link** sent to their email: no password. The invitation link is valid for 7 days; afterwards they request a new link on the sign-in page (valid 15 minutes). Opening a link shows a confirmation button, so mail scanners that open links cannot use it up. Only a hash of each link is stored.
- They see **only their assigned projects**: no folders, no other projects, no user directory or Entra groups. They can never share a project with anyone.
- **Custom roles** are sets of permissions (open, edit, export, comment, review, approve, manage, request signatures, sign, use the component library). Workspace administration, creating projects and publishing or approving library parts can never be granted to them. Two presets: External designer and External reviewer.
- Disabling, removing or reaching the end date ends their access at once, including open sessions and unused links. Every invitation, link and change is in the audit log.
- Email goes through `SMTP_URL` (any SMTP server, e.g. Microsoft 365) or Amazon SES (`SES_FROM_EMAIL`). Without either, the admin copies the link and sends it themselves. Set `APP_URL` so links point at the public address.

## Production (Docker)

GitHub Actions (`.github/workflows/docker.yml`) builds the image and publishes it to GHCR as `ghcr.io/<owner>/<repo>`. On the server, set `VOLT_IMAGE` to that image and `VOLT_DOMAIN` to your host name in `.env`, copy `.env`, `docker-compose.yml` and `Caddyfile` into `/opt/volt`, and run `docker compose pull && docker compose up -d`. Caddy gets the HTTPS certificate for `VOLT_DOMAIN`. To build the image yourself: `docker build -t volt .`
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
  - Tools: select, wire (orthogonal, click to add corners, Space flips the bend), text, shapes, pan, comment.
  - Shapes (S): rectangle, ellipse/circle, line, polygon and open polyline, drawn on the sheet with snapping (Shift = square / circle / 45°). Colour, thickness, solid/dashed/dotted/dash-dot line and fill are set in the tool bar (the last used style is remembered) and edited later in the inspector; drag handles to reshape. Shapes export to PDF, SVG, PNG, DXF and .qet.
  - Component outline: an optional box around a component's symbol (project default in Global styles, per component in the inspector), separate from the symbol's own line colour.
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
- **Terminal strips.** ⌘K → "Terminal strips…" (or Open terminal strip in a terminal's inspector) lists every strip as a table: reorder by drag or arrows, number or renumber (start, step, digits; written into the references, e.g. `X1:3`), terminal type (feed-through, PE, N, fuse, disconnect, diode, sensor, multi-level), level, bridges, spare terminals, part numbers and notes, with what each side of each terminal connects to and links to its sheets. Terminals move between strips; strip name and reference format (`X1:1`, `X1-1`, `X1.1`) rename all references. The terminal plan exports to Excel (one sheet per strip), CSV or PDF, or is appended to the drawing PDF; strip part numbers and spares feed the BOM. A new strip is created with a number of terminals (e.g. X2 with 10); **Place on drawing** draws them in series — side by side with vertical references, or one under the other — labelled `X2:1 … X2:10`, in free room on the current sheet. Long strips split over sheets: set *max per sheet* and the rest go on new sheets inserted after the current one ("X2 terminals 2/3"); a full sheet sends them to a new sheet. Single rows can be placed with ⊕. The *Sheets* filter shows a strip sheet by sheet (or only what is not drawn), and the strip list shows which sheets each strip is on. Terminals labelled only with a number ("12") are listed under *No strip* and can be put into a strip in one go, keeping their numbers.
- **End terminals vs feed-through terminals.** Some library terminal symbols (e.g. QElectroTech "borne_finale") are end terminals with a single connection point at the top, so nothing can be wired to their other side. Their inspector says so and offers to replace them with a feed-through terminal (pin top and bottom) — the Volt built-in one, one already in the project, or one from the library — for one terminal or the whole strip, keeping reference and wires (wires leaving downwards move to the bottom pin).
- **Terminal diagram sheets.** A terminal is drawn on the schematic as a single symbol wherever it is used, with its full reference (`X1:3`); the same reference on several sheets is the same terminal (not a duplicate). *Terminal diagram sheet* (Terminal strips dialog, or ⌘K → "Terminal diagram sheets" for every strip) inserts a generated sheet that draws the strip as a box of terminals side by side — numbers in the cells, PE / N / fuse marks, bridges as a line with dots between bridged terminals — and above and below each terminal its conductors: wire number next to the strip, then the device and pin it goes to, coloured like the wire. By default the strip is drawn as it sits on the DIN rail: rail with slots, end stop and marker carrier with the strip name and description ("X1 (24 Volts)") at the start, terminal blocks with a screw on top and bottom (connections on both sides), number markers, PE green/yellow and N blue, plugged-in bridges across the bridge channels, end plate and end stop at the end; the page properties switch to a simple box. It follows the schematic automatically. Clicking a terminal goes to its symbol on the schematic, and ⌘-clicking that symbol comes back. Long strips are spread over several sheets (page properties: strip, terminal range, *Re-split over sheets*).
- **Off-page arrows (folio reports).** A going arrow and its coming arrow on another sheet carry the *same* reference — the signal name (`24V`, `L1`, `E-STOP-1`); this is allowed only for folio report symbols. Matching references link automatically (one going arrow can feed several coming arrows), or pick the counterpart in the inspector's *Folio report* section, which also jumps there and unlinks. Linked arrows print where the conductor continues (`5-3B` = sheet 5, column 3, row B), the conductor is one net for ERC and wire numbering, and the PDF keeps clickable links. ⌘K → "Link off-page arrows" links every matching pair in the project. A library arrow that is not marked as a folio report gets an *Off-page arrow* section to mark it as going or coming.
- **Bill of materials.** Parts list from each component's name, rating, part number, manufacturer, supplier, quantity and unit, grouped by part number, by location, or one line per component, for all or selected sheets. Instances with the same reference count once; slave contacts, report arrows and junctions are skipped; the inspector's *In BOM* switch leaves a component out. Download as Excel (.xlsx, with a Cables sheet), CSV or a PDF table, or append it to the drawing PDF (Export → BOM, or "Bill of materials…" in ⌘K).
- **Accessibility.** Keyboard alternatives for the canvas (Connect pins dialog, nudging, commands) and a screen-reader live region.

**Wiring and cables**
- **Conductor data.** Every wire can carry a function (power, L1–L3, N, PE, AC/DC control, interlock), an insulation color (IEC 60757 codes such as BK, BU, GN/YE, or any text) and a cross-section (mm², AWG or sq). Set them in the Conductor panel for one wire or many at once, or apply them to a whole net.
- **Standards.** Project → Wiring & cables picks IEC 60204-1 (EU), NFPA 79 / UL 508A (US) or JIS B 9960-1 (Japan). A wire without its own color gets the standard color for its function (e.g. red AC control, blue DC control, green-yellow PE), shown in that standard's notation and size unit.
- **On the drawing.** The wire number sits on one side of the wire and its color code + cross-section on the other, at the same spot, with a small tick. Texts never overlap: when space is short the number wins, then end markers, then the color/size, each moving along the wire or to the other side before being left out. A conductor color (the wire's own or its cable core's) is always drawn; the Appearance color applies only when none is set. Optionally wires take their function's standard color, and heavier lines mark larger cross-sections.
- **Wire numbers and ends.** A wire keeps one number end to end; it changes where the circuit passes through a device. The number can be written in the middle, at both ends, or both; destination marking adds the far terminal at each end ("1A-01-0 / X1:8"), and each end can be named by hand.
- **Cables.** Multi-core cables with tag, type, cores (HD 308 colors, numbered, DIN 47100), cross-section, shield and length. Selecting wires and choosing Cable → New cable creates one and assigns cores in drawing order (green-yellow goes to the PE wire). The drawing shows a cable mark across the bundle with the tag and type (dashed ellipse when shielded); clicking it selects the cable's wires. Wire and cable lists export as CSV.
- **Checks.** Green-yellow on a non-PE wire, PE in another color, a core used twice, more conductors than cores.
- **Automatic wire numbering** (⌘⇧L or ⌘K → "Wire numbering…"). Conductors are grouped into circuits across sheets (through junctions, splices, feed-through terminals, mated connectors and folio reports), each circuit's voltage system is detected and every wire gets an identifier for the drawing, ferrules and harness labels:
  - *Harness preset* (default): class letter + circuit number + segment letter, `N` for returns — `B012A`, `B012B`, `B013AN`, `PE001A` — the SAE AS50881 structure used on vehicle, robot and aircraft harnesses; every physical wire has a unique ID. *Panel preset*: class + sheet + column (`B3.12`, EPLAN / IEC 61082 style). Formats are editable (`{class} {n:3} {seg} {ret} {page} {col} {row} {size}`).
  - Voltage classes are a table you edit: A = 48 V DC, B = 24 V DC, C = 5 V DC, D = 12 V DC, E = 3.3 V DC, X = AC mains, S = signal/data (CAN, RS-485, Ethernet … by name). Detection uses a class set on the wire, rail names (+24V, 0V, L1, N, PE, 230VAC, QET-style L1.4), conductor functions, existing numbers and supply pin names, and is carried through fuses, contacts, coils and other two-terminal devices (not through power supplies or modules).
  - Stable by default: existing numbers are kept and only new wires and segments get the next free numbers; "Renumber everything" re-sequences (closing gaps). Numbers typed by hand are locked; lock/unlock per wire. Replaced rail names keep their meaning as the conductor function. The rule check understands segment letters.

**Wire labels for harnesses** (⌘K → "Print wire labels…", the wire inspector, or Wiring & cables). One marker per wire end (or per wire) with the wire number and, on a second line, this end → other end ("K1:A1 → F1:2"), the destination or the terminal, optionally colour and cross-section; splices and folio continuations are named. Print the selected wires, a sheet, one cable, or the whole project, ordered by wire number, sheet or device, and pick single labels in the preview.
- Media: Brother HSe heat-shrink tubes (5.8 / 8.8 / 11.7 / 17.7 mm), TZe / TZe-FX tape as flag labels (wrapped around the wire, both halves readable) or wrap-around labels (text repeated), and straight TZe tape 9–24 mm; fixed or automatic length, repeated text, wire diameter for flags.
- **Direct printing from the browser** (Chrome / Edge on a desktop) to Brother P-touch printers with 180 dpi 128-pin heads — PT-E550W, PT-E560BT, PT-P750W, PT-P710BT, PT-P700, PT-D600 … — over **WebUSB**, or over **Web Serial** for Bluetooth models paired with the computer. Volt reads the loaded tape/tube width and type, refuses to print on the wrong media, and sends Brother raster commands (TIFF-compressed) with cut / half-cut / feed options and a calibration (upside down, offset). Windows: the Brother driver holds the USB port — use the PDF, or switch the port to WinUSB (Zadig); P750W: switch P-touch Editor Lite off.
- Downloads: **Label PDF** (one page per label at the label's size — print with the Brother driver, P-touch Editor or any label printer at 100 %), **A4 sheet PDF** (all labels at real size with cut lines and captions), and **CSV** for P-touch Editor's database merge.

**Deleting safely.** Deleting anything that is used elsewhere first shows where and what happens: a coil's contacts on other sheets, the counterpart of a folio report or a mated connector, other representations of the same device, the rest of a placed block, wires left with a loose end, connections that would be broken (project-wide), wire numbers that continue on other sheets, cable cores, terminal-strip rows and open review comments — each with a "show" link and an option to delete the related items too. After deleting a component the references close their gap (K1, K2, K4 → K1, K2, K3; every part of a device is renamed together, locked references are kept; can be turned off in the dialog), and wires can optionally be renumbered. Renaming a reference renames the device's other parts (contacts, other sheets) with it. ⌘K → "Close gaps in references" does the same for the whole project.

**Datasheets and documents.** Library elements and placed components carry datasheets, spec sheets, manuals, certificates, drawings and CAD models — uploaded files (PDF, images, STEP, ZIP … up to 25 MB) or links. Documents on a library element appear on every placed copy; documents of other parts with the same part number are offered too; "Find online" searches the manufacturer + part number. CSV / Excel BOM exports get a Datasheet column. (Specification fields are stored for later AI extraction.)

**Components**
- **Component info.** Name, rating, part number and manufacturer are stacked under the reference with even spacing, or placed right / left / below the symbol, aligned left, center or right. Each line has its own text role in Global styles (font, size, weight, color, visibility, line spacing, alignment); lines are shown or hidden per component, and the project default is set in Global styles → Component info or with "Use for all".
- **Style templates.** A fresh workspace gets three approved style templates: "IEC 61082 · ISO 3098 (monochrome)" (default; ISO 3098 lettering heights 1.8 / 2.5 / 3.5 / 5 mm, black), "NFPA 79 · ANSI (North America)" (Arial, sizes legible after reduction, part numbers shown) and "Screen review (color)", plus a "Standard control panel" project template. They are installed once at server start; later edits or deletions are kept.

**Library** (`/library`)
- **Standard library.** About 8,800 symbols (electric, logic, hydraulic, pneumatic, energy), starter circuit blocks (DOL starter, start/stop with self-holding, pilot lamp, relay, 24 V supply, terminal strip) and standard title blocks. They are installed into every workspace when the server starts, or with `npm run db:seed`, and updated in place when a newer collection ships.
- **Sharing.** Elements and blocks can be private, shared with named people (view or edit), or published to the whole organization. Org publishing can require approval.
- **History and provenance.** Every element keeps its revision history. Imported libraries keep their license and attribution. Import `.elmt` files, folders or `.zip` archives; export `.elmt` or `.zip`.
- **AI element drawing.** New element → *Describe or sketch (AI)*: describe the symbol, draw it on the built-in sketch pad (pen, line, rectangle, ellipse, eraser, undo) or upload a photo / datasheet picture, and OpenAI returns a clean, grid-aligned symbol with numbered pins. Refine it with follow-up instructions, then open it in the element editor. Needs `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default `gpt-4.1`) in `.env`; requests go from the server, the key never reaches the browser.
- **Element editor.** Canvas symbol editor with lines, rectangles, ellipses, arcs, polygons, text, dynamic text and pins; pin table; validation; live previews. A New-element wizard offers templates and SVG import.

**Branding.** Administration → General → Branding sets your organization's name, address, website and logo. The logo fills any title block logo cell that has no uploaded logo and appears at the top of cover sheets (replace or hide it per cover sheet); name and address become the manufacturer of new cover sheets; the sign-in page and link previews show them. A fresh installation is unbranded.

**Document control**
- **Versions.** "Start new version" copies the current version, which stays unchanged. Version labels can be integer, decimal, letter or custom.
- **Variants.** A variant is a customer or configuration specific line branched from a main-line version — e.g. the standard robot v2 plus an extra emergency stop for one customer — without becoming v3 of the product. *New variant* (or *Create variant from here* on an approved, signed or released version) asks for a name, customer and short code; its versions are labelled `2-ACME.1`, `2-ACME.2` … and go through their own review, signatures and release. Each line (main and every variant) has its own working version, and releasing a version supersedes only the earlier release of the same line. Variants can be renamed, archived and restored.
- **Version control (git-like).** Inside a draft you commit your work with a message (right panel → Version control): only what changed is listed (added / removed / changed / moved components, wires, texts, sheets, settings), and each item jumps to the drawing. The history runs across versions — versions are the tags (v1 released, v2 approved …) and variants the branches. Any commit or version can be compared on the canvas, restored into the working copy (an ordinary undoable change, then commit it), or used to start a new version. Submitting for review commits what is not committed yet, so a review covers exactly one commit like a pull request (reviewers see "Changes in this version" against where it started); approval and signatures are the merge and the release.
- **Review.** Submitting freezes the version. Reviewers can be people or Entra groups, in sequence or in parallel. Reviewers comment with @mentions and approve, reject or request changes, under the policy set in Administration. A version in review can be recalled to draft by its author (e.g. to fix findings), and an approval can be taken back by project owners and approvers — until someone signs.
- **AI reviewer.** When a version is submitted, *Volt AI Reviewer* does the first review and posts its findings as comments on the component or wire concerned; the designer resolves them (with the default policy, open comments block approval). It runs the electrical rule check — project-wide nets through folio reports, terminals and mated connectors; short circuits between potentials (L1/L2/L3/N/PE, +24 V/0 V), PE on live conductors, reversed polarity, bypassed components (both terminals on one conductor), open folio reports, dead-end conductors, contacts without a coil, unconnected PE terminals; reference letter codes (IEC 81346-2), wire numbers used twice or several numbers on one conductor, N / phase / PE colours (IEC 60445); conductor size against the protective device rating (IEC 60204-1 Table 6), minimum sizes, PE size (IEC 60364-5-54), section reductions without protection; emergency stops on NO contacts, missing supply disconnecting device, motors without overload protection, PELV bonding — and then, with `OPENAI_API_KEY` set, an AI engineering review of the netlist (connections, naming, shorts, wrong wiring such as coil voltage or NO/NC misuse and missing interlocks, safety, wire sizing, protection, documentation) with concrete suggestions and the standard clause. Designers and reviewers can re-run it from the editor's Review panel at any time (earlier open findings are superseded). Administration → General → AI reviewer turns it on/off, runs it on submit or only on demand, keeps it to rule checks only (nothing leaves the server), sets which rule levels become comments, and adds your own house rules to the AI prompt.
- **Signatures and release.** Built-in, provider-neutral signing: fresh sign-in, Ed25519 seal over the version hashes, a signed release PDF with an evidence page, and a verification endpoint. See `docs/SIGNING.md`. Versions can then be released or superseded. A signed version is a record and is never taken back (no recall, no withdrawal): changes need a new version, and starting one from a signed version marks the signed one **obsolete** (non-editable, kept with its signatures). Project owners can also mark signed or released versions obsolete explicitly.
- **Traceability.** Notifications (in-app, email, Teams webhook), an audit log with CSV export, search across all versions, admin settings, and style and project templates.

## File compatibility

- **Import.** `src/core/qet` reads QET 0.3 to 0.100 projects. Anything it doesn't model is kept and written back unchanged, so an untouched project exports byte-identical. Tested on the bundled examples.
- **Compatibility report.** Shown on import and before export: what is supported, degraded, preserved-but-not-editable, or unsupported.
- **Junctions.** Volt junctions and dangling wire ends are exported as a tiny embedded `volt_junction` element, because QET has no free junctions. Volt recognizes them on re-import.
- **Limitations.** QET has no mirroring, so mirrored elements are exported unmirrored. Composite texts show their last computed value. Drawn lines, rectangles, ellipses and polylines can be selected, moved, reshaped, restyled and deleted, and are written back on export. Cross-references are kept and drawn, but can't be edited. QElectroTech's own terminal strip records are kept unchanged; Volt's strip data (order, types, bridges, spares) is stored with the project, while terminal numbers travel in the references.

## Development

```bash
npm test              # vitest: core model, wires, topology, numbering, diff, validation, blocks, render, QET round-trips (270+ tests)
npm run typecheck
npm run test:e2e      # Playwright against a running dev server (PW_CHROMIUM=/path/to/chrome optional)
npm run db:studio
```

Layout: `src/core` (isomorphic model, QET I/O, rendering to Canvas/SVG/PDF/DXF), `src/editor` (canvas engine + editor UI), `src/library-editor` (symbol editor), `src/app` (Next.js routes/pages/APIs), `src/lib` (auth, permissions, workflow, signing, audit), `prisma` (SQLite schema + seed). `docs/CONTRACT.md` lists the API surface.

Stack: Next.js 16, React 19, Tailwind CSS 4, Prisma 6 + SQLite, Auth.js 5 (Entra ID), pdf-lib, rbush, immer, zustand.

## License

Volt is free software, licensed under the **GNU General Public License v3.0 or later** — see [`LICENSE`](LICENSE). You may use it for free for any purpose, study and change it, and redistribute it, with or without changes. If you distribute it (including as a Docker image), you must make the source code available under the same license and keep the notices.

Volt includes and is partly derived from material of the [QElectroTech](https://qelectrotech.org) project: some algorithms (GPL-2.0-or-later), the standard title blocks and example projects (GPL-2.0-or-later), and the elements collection (CC-BY 3.0, not for training machine-learning models). Volt is not affiliated with the QElectroTech team. Details and the font and npm package licenses are in [`NOTICE.md`](NOTICE.md).

