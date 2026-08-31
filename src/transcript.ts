/**
 * transcript.ts — the product-neutral transcript model.
 *
 * Every agent's history is normalized into a flat list of entries (text,
 * tool_use, tool_result) plus an optional recap, so rendering and the hook
 * never care which product a session belongs to.
 */

export type Kind = "text" | "tool_use" | "tool_result";

export interface Entry {
  ts: string | null;
  role: string;
  kind: Kind;
  text?: string; // text / tool_result
  name?: string; // tool_use
  summary?: string; // tool_use raw input summary
}

export interface Parsed {
  recap: string | null;
  total: number;
  entries: Entry[];
}

const STRIP: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g,
  /<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g,
  // crew's own injections (e.g. mail appended to opencode tool outputs);
  // other sessions shouldn't see crew talking to itself.
  /<crew-messages>[\s\S]*?<\/crew-messages>/g,
];

export function clean(s: string): string {
  for (const r of STRIP) s = s.replace(r, "");
  return s.trim();
}

/** Best single-line summary of a tool call's input object. */
export function toolInputSummary(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return String(input ?? "");
  const obj = input as Record<string, unknown>;
  for (const key of [
    "description",
    "cmd",
    "command",
    "prompt",
    "query",
    "pattern",
    "path",
    "file_path",
    "filePath",
    "url",
    "target",
  ]) {
    const candidate = obj[key];
    if (typeof candidate === "string") return candidate;
    if (Array.isArray(candidate)) return candidate.map(String).join(" ");
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}
