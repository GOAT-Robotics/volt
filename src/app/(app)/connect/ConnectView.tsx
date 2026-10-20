"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, Copy, KeyRound, Plus, Trash2, Check, Eye, MessageSquare, PenLine, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Empty, Spinner, Table } from "@/components/ui/misc";
import { PromptDialog, Section, useMutation } from "@/components/volt/common";
import { api } from "@/lib/fetcher";
import { cn, fmtDate, relTime } from "@/lib/utils";

type Token = { id: string; name: string; prefix: string; scope: "READ" | "EDIT"; expiresAt: string | null; lastUsedAt: string | null; createdAt: string; expired: boolean };
type ToolRow = { name: string; title: string; access: "read" | "comment" | "edit" };

function CopyBox({ value, label, secret }: { value: string; label?: string; secret?: boolean }) {
  const [done, setDone] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("Could not copy — select the text and copy it");
    }
  };
  return (
    <div>
      {label && <p className="mb-1 text-2xs font-medium text-muted">{label}</p>}
      <div className={cn("flex items-start gap-2 rounded-md border px-2.5 py-2", secret ? "border-warning/40 bg-warning-soft" : "border-border bg-panel-2")}>
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-2xs leading-relaxed">{value}</pre>
        <button onClick={copy} className="shrink-0 rounded p-1 text-subtle hover:bg-hover hover:text-fg" aria-label={`Copy ${label ?? "value"}`}>
          {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}

const snippets = (url: string, token: string) => ({
  code: `claude mcp add --transport http volt ${url} --header "Authorization: Bearer ${token}"`,
  json: JSON.stringify({ mcpServers: { volt: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  stdio: JSON.stringify({ mcpServers: { volt: { command: "npx", args: ["-y", "mcp-remote", url, "--header", "Authorization:${VOLT_AUTH}"], env: { VOLT_AUTH: `Bearer ${token}` } } } }, null, 2),
});

function Setup({ url, token }: { url: string; token: string }) {
  const [tab, setTab] = React.useState<"code" | "json" | "stdio">("code");
  const s = snippets(url, token);
  const tabs = [
    { id: "code", label: "Claude Code" },
    { id: "json", label: "Cursor, .mcp.json, other HTTP clients" },
    { id: "stdio", label: "Claude Desktop & stdio-only clients" },
  ] as const;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("rounded-md px-2 py-1 text-2xs font-medium", tab === t.id ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover")}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "code" && <CopyBox value={s.code} label="Run in a terminal (add --scope user to use it in every project)" />}
      {tab === "json" && <CopyBox value={s.json} label="MCP server configuration (mcp.json / settings)" />}
      {tab === "stdio" && <CopyBox value={s.stdio} label="claude_desktop_config.json — bridges to the HTTP server with mcp-remote (needs Node.js)" />}
    </div>
  );
}

function CreateDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState("Claude");
  const [scope, setScope] = React.useState<"EDIT" | "READ">("EDIT");
  const [days, setDays] = React.useState("90");
  const [busy, setBusy] = React.useState(false);
  const [made, setMade] = React.useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    try {
      const j = await api<{ token: string }>("/api/tokens", { method: "POST", json: { name: name.trim(), scope, days: days === "never" ? null : Number(days) } });
      setMade(j.token);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent wide title={made ? "Token created — copy it now" : "New access token"} description={made ? "This is the only time it is shown. Anyone with it can act as you in this workspace through an AI assistant." : "An AI assistant using this token works as you, with your roles and projects."}>
        {!made ? (
          <div className="space-y-3">
            <Field label="Name" hint="Where you will use it, e.g. Claude Code on my laptop">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
            </Field>
            <Field label="Access">
              <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as "EDIT" | "READ")}>
                <option value="EDIT">Read, comment and edit working drafts</option>
                <option value="READ">Read and check only</option>
              </NativeSelect>
            </Field>
            <Field label="Expires">
              <NativeSelect value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="30">After 30 days</option>
                <option value="90">After 90 days</option>
                <option value="365">After a year</option>
                <option value="never">Never</option>
              </NativeSelect>
            </Field>
          </div>
        ) : (
          <div className="space-y-3">
            <CopyBox value={made} label="Access token" secret />
            <Setup url={url} token={made} />
          </div>
        )}
        <DialogFooter>
          {made ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={create} disabled={busy || !name.trim()}>
                {busy ? <Spinner /> : <KeyRound />} Create token
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConnectView({ url, enabled, allowEdits, workspace, tokens, tools }: { url: string; enabled: boolean; allowEdits: boolean; workspace: string; tokens: Token[]; tools: ToolRow[] }) {
  const [creating, setCreating] = React.useState(false);
  const [revoke, setRevoke] = React.useState<Token | null>(null);
  const [run] = useMutation();
  const groups: { access: ToolRow["access"]; title: string; icon: React.ReactNode; hint: string }[] = [
    { access: "read", title: "Read & check", icon: <Eye />, hint: "Any token" },
    { access: "comment", title: "Review comments", icon: <MessageSquare />, hint: "Edit tokens" },
    { access: "edit", title: "Change working drafts", icon: <PenLine />, hint: allowEdits ? "Edit tokens, with your Edit role" : "Turned off by your admin" },
  ];
  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Bot className="size-4 text-accent" /> Connect AI assistants
          </span>
        }
        description={`Let Claude — or any assistant that speaks the Model Context Protocol (MCP) — open your projects in ${workspace}, review drawings and fix wiring and naming, working as you.`}
        actions={
          enabled && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> New token
            </Button>
          )
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        {!enabled && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" /> The MCP server is turned off for this workspace. A workspace admin can turn it on under Administration → General → AI assistants.
          </div>
        )}
        <Section title="1 · Server address" description="Streamable HTTP (MCP 2025-06-18). Every request carries your token: Authorization: Bearer …">
          <div className="p-4">
            <CopyBox value={url} />
          </div>
        </Section>
        <Section
          title="2 · Your access tokens"
          description="Create one per assistant or computer. It acts as you: the same roles, projects and permissions. Revoke it when you no longer use it."
          actions={
            enabled && (
              <Button size="xs" onClick={() => setCreating(true)}>
                <Plus /> New token
              </Button>
            )
          }
        >
          {tokens.length === 0 ? (
            <Empty icon={<KeyRound />} title="No tokens yet">
              Create a token, then add Volt to your assistant with the snippet shown.
            </Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="w-40">Token</th>
                  <th className="w-36">Access</th>
                  <th className="w-36">Last used</th>
                  <th className="w-36">Expires</th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td className="text-xs font-medium">{t.name}</td>
                    <td className="font-mono text-2xs text-muted">{t.prefix}…</td>
                    <td>{t.scope === "EDIT" ? <Badge tone="accent">Read & edit</Badge> : <Badge>Read only</Badge>}</td>
                    <td className="text-2xs text-muted">{t.lastUsedAt ? relTime(t.lastUsedAt) : "never"}</td>
                    <td className="text-2xs text-muted">{t.expired ? <Badge tone="danger">Expired</Badge> : t.expiresAt ? fmtDate(t.expiresAt, false) : "never"}</td>
                    <td className="text-right">
                      <Button size="icon-sm" variant="ghost" aria-label={`Revoke ${t.name}`} onClick={() => setRevoke(t)}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>
        <Section title="3 · Add Volt to your assistant" description="Put your token in place of <token> (the snippet is filled in for you when you create one).">
          <div className="p-4">
            <Setup url={url} token="<token>" />
          </div>
        </Section>
        <Section title="What an assistant can do" description="Working versions (Draft, Changes requested) only — versions in review, approved, signed or released are never changed, and approving, signing and releasing stay with people. Every change is shown live in open editors and recorded in the audit log as made via MCP.">
          <div className="grid gap-3 p-4 md:grid-cols-3">
            {groups.map((g) => (
              <div key={g.access} className="rounded-md border border-border p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold [&_svg]:size-3.5 [&_svg]:text-accent">
                  {g.icon} {g.title}
                </p>
                <p className="mb-2 text-2xs text-muted">{g.hint}</p>
                <ul className="space-y-0.5">
                  {tools
                    .filter((t) => t.access === g.access)
                    .map((t) => (
                      <li key={t.name} className="text-2xs">
                        {t.title} <span className="font-mono text-subtle">{t.name}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="border-t border-border px-4 py-2.5 text-2xs text-muted">
            Ready-made prompts: <b>review_drawing</b> (an engineering review posted as comments) and <b>fix_naming</b> (references and wire numbers). Try: “Review DEMO-001 and comment on anything wrong” or “Close the gaps in the K references of DEMO-001 and number the new wires”.
          </p>
        </Section>
      </div>
      {creating && <CreateDialog url={url} onClose={() => setCreating(false)} />}
      <PromptDialog
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title={`Revoke “${revoke?.name}”?`}
        description="Assistants using it stop working at once. This cannot be undone."
        confirmLabel="Revoke"
        danger
        onConfirm={async () => {
          const t = revoke!;
          await run(() => api(`/api/tokens/${t.id}`, { method: "DELETE" }), `Revoked ${t.name}`);
          setRevoke(null);
        }}
      />
    </div>
  );
}
