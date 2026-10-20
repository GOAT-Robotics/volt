/**
 * Model Context Protocol over Streamable HTTP, stateless: every POST carries one JSON-RPC message
 * (or a batch) and gets a JSON answer; there are no server-initiated messages, so no SSE stream and
 * no session id. Any MCP client works (Claude Code, Claude Desktop, IDEs, the MCP Inspector …).
 */
import "server-only";
import { callTool, toolList, type Env } from "./tools";
import { PROMPTS, promptMessages } from "./prompts";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "volt", title: "Volt electrical drawings", version: "1.0.0" };

export const INSTRUCTIONS = `Volt is an electrical diagram editor with document control (versions, reviews, signatures). Everything a person does in the editor has a tool here.

Work like this:
1. list_projects → get_project to find the version; versions are addressed as "<project number>@<label>" (e.g. DEMO-001@2), or just the project number for its working version.
2. get_drawing first (status, whether you may edit, pages). Then get_netlist, list_components, get_component, list_wires, check_drawing for the facts and render_page to see a sheet (list_page_items for texts / shapes, get_settings, get_terminal_strips, list_cables, get_report for the rest).
3. Review findings go into add_comment, pinned to the component or wire, with a concrete suggestion and the standard clause where it applies.
4. Changes only work on working versions (Draft / Changes requested): components (place, move, arrange, style, rename, data, mate_connectors, replace_symbol, copy), wires (connect_pins, draw_wire, route_wire, set_wire, number_wires), cables, terminal strips, pages, texts and shapes, cover sheet, title blocks, settings, blocks and the library. They are saved at once and shown live to anyone who has the version open; undo reverts your last changes. Prefer dry_run for bulk renumbering, confirm big changes with the user, then commit_changes with a clear message.
5. Versions in review, approved, signed or released are records: never try to change them; start_new_version when the user wants changes. Submit for review or take a version back only when the user asks; approving, signing and releasing are for people in Volt.

Addresses: components by reference ("K1"; "K1@2" for the part on page 2; "#1a2b3c4d" by id), pins as "K1:A1" (terminals "X1:3:1"; unnamed pins p1, p2 …), wires by id "#…" from list_wires or by wire number, texts / shapes / junctions by id from list_page_items, pages by number in sheet order, cells on a sheet as column+row ("3C"), commits as "#12".`;

type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const err = (id: Msg["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const ok = (id: Msg["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });

/** one JSON-RPC message → its response (null for notifications and responses) */
export async function handleMessage(m: Msg, env: Env): Promise<object | null> {
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return err(m?.id, -32600, "Invalid request: expected JSON-RPC 2.0");
  // a response from the client (we never ask it anything) or a notification: nothing to answer
  if (!m.method) return null;
  const isNotification = m.id === undefined;
  if (isNotification) return null;
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize": {
      const asked = String(p.protocolVersion ?? "");
      return ok(m.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, { tools: toolList(env) });
    case "tools/call": {
      const name = String(p.name ?? "");
      if (!toolList(env).some((t) => t.name === name)) return err(m.id, -32602, `Unknown tool: ${name}`);
      return ok(m.id, await callTool(name, p.arguments ?? {}, env));
    }
    case "prompts/list":
      return ok(m.id, { prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) });
    case "prompts/get": {
      const r = promptMessages(String(p.name ?? ""), (p.arguments ?? {}) as Record<string, string>);
      return r ? ok(m.id, r) : err(m.id, -32602, `Unknown prompt: ${String(p.name ?? "")}`);
    }
    case "resources/list":
      return ok(m.id, { resources: [] });
    case "resources/templates/list":
      return ok(m.id, { resourceTemplates: [] });
    case "logging/setLevel":
      return ok(m.id, {});
    default:
      return err(m.id, -32601, `Method not found: ${m.method}`);
  }
}
