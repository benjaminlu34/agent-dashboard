export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatTime(value) {
  const parsed = new Date(value ?? "");
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown time";
  }
  return parsed.toLocaleString();
}

export function normalizeSprint(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^M[1-4]$/u.test(normalized) ? normalized : null;
}

export function statusBadgeClasses(status) {
  const normalized = String(status ?? "").trim();
  if (normalized === "Done") return "bg-white text-black border border-white/80";
  if (normalized === "In Progress") return "bg-zinc-200 text-zinc-950 border border-zinc-300";
  if (normalized === "In Review") return "bg-zinc-300 text-zinc-950 border border-zinc-300";
  if (normalized === "Ready") return "bg-zinc-100 text-zinc-950 border border-zinc-200";
  if (normalized === "Blocked") return "bg-zinc-800 text-zinc-100 border border-zinc-600";
  if (normalized === "Needs Human Approval") return "bg-zinc-700 text-zinc-100 border border-zinc-500";
  if (normalized === "Backlog") return "bg-zinc-900 text-zinc-300 border border-zinc-700";
  return "bg-zinc-900 text-zinc-300 border border-zinc-700";
}

export function runBadgeClasses(status) {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "succeeded") return "bg-white text-black border border-white/80";
  if (normalized === "running") return "bg-zinc-200 text-zinc-950 border border-zinc-300";
  if (normalized === "queued") return "bg-zinc-300 text-zinc-950 border border-zinc-300";
  if (normalized === "failed") return "bg-zinc-800 text-zinc-100 border border-zinc-600";
  if (normalized === "skipped") return "bg-zinc-900 text-zinc-300 border border-zinc-700";
  return "bg-zinc-900 text-zinc-300 border border-zinc-700";
}

export function toTimestampMs(value) {
  const parsed = new Date(value ?? "").getTime();
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed;
}
