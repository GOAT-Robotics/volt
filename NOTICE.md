# Notices and third-party material

Volt is free software: you can redistribute it and/or modify it under the terms of the
**GNU General Public License version 3, or (at your option) any later version**
(SPDX: `GPL-3.0-or-later`). The full text is in [`LICENSE`](LICENSE).

Volt is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even
the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
Public License for more details. Volt is a drawing and document-control tool; it does not check
the electrical safety of a design.

Copyright © 2026 the Volt contributors.

Volt is an independent project. It is not made, endorsed or supported by the QElectroTech team.
"QElectroTech" is used only to describe file compatibility.

---

## QElectroTech

Volt reads and writes QElectroTech files and includes material from the QElectroTech project
(<https://qelectrotech.org>, source: <https://github.com/qelectrotech/qelectrotech-source-mirror>).

### Source code (GPL-2.0-or-later)

> Copyright 2006-2026 The QElectroTech Team.
> QElectroTech is free software: you can redistribute it and/or modify it under the terms of the
> GNU General Public License as published by the Free Software Foundation, either version 2 of
> the License, or (at your option) any later version.

Parts of `src/core/qet/` and `src/lib/library/elmt-tools.ts` re-implement QElectroTech
algorithms in TypeScript so that drawings come out the same — conductor path generation
(`Conductor::generateConductorPath`), title block template grid parsing and column widths
(`TitleBlockTemplate`), element size and hotspot (`ElementScene::toXml`) and QDom text
escaping. These parts are derived from QElectroTech and are used here under the "or any later
version" option of its license, as part of Volt under GPL-3.0-or-later. The files carry a notice.

### Title block templates and example projects (GPL-2.0-or-later)

`seed/titleblocks/*.titleblock` are the title block templates shipped with QElectroTech, and
`src/core/qet/__fixtures__/projects/*.qet` are example projects from the QElectroTech
distribution (authors as recorded in each file: the QElectroTech Team, Orlin Dimitrov,
pawel32640 and others). They are redistributed unmodified under the QElectroTech license. Logos
inside some templates (e.g. Alstom, SNCF, ENGIE) are trademarks of their owners and are
included only as they appear in QElectroTech's own templates.

### Elements collection (CC-BY 3.0)

`seed/elements.tgz` (installed as the "standard library", collection revision in
`seed/elements.version`) and `src/core/qet/__fixtures__/elements/*.elmt` come from the
QElectroTech elements collection (<https://github.com/qelectrotech/qelectrotech-elements>),
© the QElectroTech Team and contributors. Its license is in
[`seed/ELEMENTS.LICENSE`](seed/ELEMENTS.LICENSE):

- Using, modifying and integrating the elements into electric diagrams is allowed without
  conditions, whatever the license of the diagram.
- Redistributing the collection outside of diagrams, with or without modifications, is under the
  **Creative Commons Attribution 3.0** license (<https://creativecommons.org/licenses/by/3.0/>).
  Volt redistributes the collection unmodified as an archive; when it is installed, each element
  keeps its author and license information, and the library records the collection's license
  and attribution.
- The collection may **not** be used as sample data to build machine-learning models. Volt's AI
  element drawing (optional, off without an API key) sends only the user's own description,
  sketch or picture to the model; it does not send or train on the collection.

If you redistribute Volt, keep these notices and `seed/ELEMENTS.LICENSE` with it.

---

## Fonts

- **Liberation Sans** (`public/fonts/LiberationSans-*.ttf`) — SIL Open Font License 1.1, see
  `public/fonts/LiberationSans-LICENSE.txt`.
- **Work Sans** (`public/fonts/WorkSans-*.ttf`) — © The Work Sans Project Authors, SIL Open Font
  License 1.1, see `public/fonts/WorkSans-OFL.txt`.

## npm packages

Volt depends on packages from npm that are installed at build time and are not part of this
repository. They are under licenses compatible with GPL-3.0: MIT, Apache-2.0, ISC, BSD-2/3-Clause,
0BSD, MIT-0, Zlib, MPL-2.0 (`@resvg/resvg-js`), LGPL-3.0-or-later (the libvips binaries of
`sharp`) and CC-BY-4.0 (`caniuse-lite` data). Each package's license is in its folder under
`node_modules/` and in the container image. List them with
`npx license-checker --production --summary`.

## Distributing Volt

GPL-3.0 lets anyone use Volt for any purpose, for free, and share or sell copies, modified or
not. If you distribute Volt (including a Docker image) you must pass on the same freedoms: ship
or offer the complete corresponding source code under GPL-3.0-or-later, keep the copyright and
license notices (this file, `LICENSE`, `seed/ELEMENTS.LICENSE`, the font licenses), and mark
your changes. Running Volt for your own organization, without giving copies to others, has no
such obligations.
