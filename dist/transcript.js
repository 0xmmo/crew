"use strict";
/**
 * transcript.ts — the product-neutral transcript model.
 *
 * Every agent's history is normalized into a flat list of entries (text,
 * tool_use, tool_result) plus an optional recap, so rendering and the hook
 * never care which product a session belongs to.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.clean = clean;
exports.toolInputSummary = toolInputSummary;
const STRIP = [
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    /<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g,
    /<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g,
    // crew's own injections (e.g. mail appended to OpenCode tool outputs);
    // other sessions shouldn't see crew talking to itself.
    /<crew-messages>[\s\S]*?<\/crew-messages>/g,
];
function clean(s) {
    for (const r of STRIP)
        s = s.replace(r, "");
    return s.trim();
}
/** Best single-line summary of a tool call's input object. */
function toolInputSummary(input) {
    if (typeof input === "string")
        return input;
    if (!input || typeof input !== "object")
        return String(input ?? "");
    const obj = input;
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
        if (typeof candidate === "string")
            return candidate;
        if (Array.isArray(candidate))
            return candidate.map(String).join(" ");
    }
    try {
        return JSON.stringify(input);
    }
    catch {
        return "";
    }
}
