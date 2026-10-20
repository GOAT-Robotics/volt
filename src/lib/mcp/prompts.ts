/** Ready-made tasks an MCP client can offer (e.g. as slash commands). */
export const PROMPTS = [
  {
    name: "review_drawing",
    title: "Review a drawing",
    description: "Electrical engineering review of a version: rule checks, netlist, naming, safety — findings posted as comments on the drawing.",
    arguments: [
      { name: "version", description: 'Version, e.g. "DEMO-001" or "DEMO-001@2"', required: true },
      { name: "focus", description: "Anything to look at in particular (optional)", required: false },
    ],
  },
  {
    name: "fix_naming",
    title: "Fix references and wire numbers",
    description: "Find duplicate or missing references, gaps and unnumbered wires, and fix them in the working version.",
    arguments: [{ name: "version", description: 'Working version, e.g. "DEMO-001"', required: true }],
  },
] as const;

export function promptMessages(name: string, args: Record<string, string>) {
  const v = args.version || "<version>";
  if (name === "review_drawing")
    return {
      description: `Review ${v}`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Review the electrical drawing ${v} in Volt like an experienced electrical design engineer.

1. get_drawing, then check_drawing for Volt's rule checks.
2. get_netlist and list_components; render_page for sheets you need to see.
3. Look for: wrong or missing connections, short circuits between potentials, PE and polarity, coil voltages and NO/NC use, missing interlocks and protection, conductor cross-sections against the protective devices, emergency stop circuits, duplicate or inconsistent references and wire numbers, missing part numbers and ratings, unclear documentation.
4. Post each real finding with add_comment on the component or wire it concerns: what is wrong, why, the concrete fix, and the standard clause (IEC 60204-1, IEC 60364, IEC 81346, NFPA 79 …) where one applies. Do not repeat findings that already have an open comment (list_comments).
5. Do not change the drawing. Finish with a short summary of the review.${args.focus ? `\n\nFocus especially on: ${args.focus}` : ""}`,
          },
        },
      ],
    };
  if (name === "fix_naming")
    return {
      description: `Fix naming in ${v}`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `In Volt, tidy up the naming of ${v} (a working version).

1. get_drawing and check_drawing: note duplicate references, missing references and wire-number problems.
2. list_components and list_wires (unnumbered) to see the current state.
3. Propose the changes first: renumber_components with dry_run (close_gaps, or by_rules if the numbering is a mess), rename_component for single fixes, number_wires with dry_run.
4. After I agree, apply them, run check_drawing again, and commit_changes with a message describing what was renamed.`,
          },
        },
      ],
    };
  return null;
}
