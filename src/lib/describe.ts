import { AUDIT_LABELS } from "./audit";
import { EXTRA_AUDIT_LABELS } from "./constants";

const LABELS = { ...AUDIT_LABELS, ...EXTRA_AUDIT_LABELS };
const s = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));

export function auditLabel(type: string) {
  return LABELS[type] ?? type;
}

/** One-line human description of an audit event's data. */
export function describeAudit(type: string, data: Record<string, unknown>): string {
  const parts: string[] = [];
  const label = s(data.label);
  if (label) parts.push(`v${label}`);
  switch (type) {
    case "version.status":
      if (data.from && data.to) parts.push(`${String(data.from).toLowerCase().replace("_", " ")} → ${String(data.to).toLowerCase().replace("_", " ")}`);
      break;
    case "version.create":
      if (data.parent) parts.push(`from v${data.parent}`);
      if (data.summary) parts.push(`“${data.summary}”`);
      break;
    case "document.add":
    case "document.remove":
      if (data.title) parts.push(`${String(data.kind ?? "").toLowerCase()} “${data.title}”`.trim());
      if (data.partNumber) parts.push(String(data.partNumber));
      break;
    case "version.commit":
      if (data.seq) parts.push(`#${data.seq}`);
      if (data.message) parts.push(`“${String(data.message).slice(0, 80)}”`);
      break;
    case "version.recall":
      if (data.from) parts.push(`${String(data.from).toLowerCase().replace("_", " ")} → draft`);
      break;
    case "version.obsolete":
      if (data.by) parts.push(`replaced by v${data.by}`);
      break;
    case "variant.create":
    case "variant.update":
      if (data.name) parts.push(`${data.code ? `${data.code} · ` : ""}${data.name}`);
      if (data.base) parts.push(`from v${data.base}`);
      if (data.state) parts.push(String(data.state).toLowerCase());
      break;
    case "ai.review":
      if (data.status === "FAILED") parts.push(`failed: ${data.error ?? ""}`);
      else if (data.status === "DONE") parts.push(`${data.findings ?? 0} finding${data.findings === 1 ? "" : "s"}${data.model ? ` (${data.model})` : " (rule checks)"}`);
      break;
    case "version.supersede":
      if (data.by) parts.push(`by v${data.by}`);
      break;
    case "project.export":
      if (data.format) parts.push(String(data.format).toUpperCase());
      break;
    case "project.import":
      if (data.filename) parts.push(String(data.filename));
      if (data.pages) parts.push(`${data.pages} pages`);
      break;
    case "project.member":
      if (data.user) parts.push(`${data.action ?? ""} ${data.user}`.trim());
      if (data.roles) parts.push(String(data.roles).toLowerCase());
      break;
    case "project.update":
      if (data.attachment) parts.push(`attached ${data.attachment}`);
      else if (data.attachmentDeleted) parts.push(`removed ${data.attachmentDeleted}`);
      else parts.push(Object.keys(data).filter((k) => k !== "state").join(", "));
      break;
    case "project.archive":
      parts.push(data.state === "ARCHIVED" ? "archived" : "restored");
      break;
    case "signature.request":
      if (Array.isArray(data.signatories)) parts.push(`from ${(data.signatories as string[]).join(", ")}`);
      break;
    case "comment.status":
      if (data.to) parts.push(String(data.to).toLowerCase());
      break;
    case "admin.member":
    case "admin.group":
      parts.push([data.action, data.user ?? data.group, data.to ?? data.roles].filter(Boolean).join(" "));
      break;
    case "admin.settings":
      if (Array.isArray(data.changed)) parts.push((data.changed as string[]).join(", "));
      break;
    case "admin.backup":
      parts.push(data.ok ? `to ${data.key}` : `failed: ${data.error}`);
      break;
    case "admin.retention":
      parts.push(`${data.autosavesDeleted ?? 0} autosaves deleted, ${data.projectsArchived ?? 0} projects archived`);
      break;
  }
  const reason = s(data.reason) ?? s(data.note);
  const out = parts.filter(Boolean).join(" · ");
  return reason ? `${out}${out ? " — " : ""}${reason}` : out;
}
