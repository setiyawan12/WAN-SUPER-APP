import fs from "node:fs";
import path from "node:path";
import {
  resolveInside,
  toRel,
  getRoot,
  isSecretPath,
  shouldSkipDir,
} from "../cowork-project.js";
import type { Tool } from "./types.js";
import { looksBinary, safeJsonArgs } from "./types.js";

export const listDir: Tool = {
  name: "list_dir",
  description:
    "List files and folders inside the Cowork project. path is relative to the project root (default '.').",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative directory path (default '.')" },
    },
  },
  needsApproval: false,
  async run(raw, { emit }) {
    const args = safeJsonArgs(raw);
    const rel = String(args.path ?? ".");
    const abs = resolveInside(rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const lines: string[] = [];
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (shouldSkipDir(ent.name) && ent.isDirectory()) continue;
      lines.push(ent.isDirectory() ? `${ent.name}/` : ent.name);
    }
    emit({ summary: `list ${rel} (${lines.length} entries)` });
    return lines.join("\n") || "(empty)";
  },
};

export const readFile: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the project. Optional start/end are 1-based line numbers.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path" },
      start: { type: "number", description: "1-based start line (optional)" },
      end: { type: "number", description: "1-based end line (optional)" },
    },
    required: ["path"],
  },
  needsApproval: false,
  async run(raw, { emit }) {
    const args = safeJsonArgs(raw);
    const rel = String(args.path ?? "");
    if (isSecretPath(rel)) throw new Error(`Refusing to read secret file: ${rel}`);
    const abs = resolveInside(rel);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
    if (stat.size > 2 * 1024 * 1024) throw new Error(`File too large (>2MB): ${rel}`);
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) throw new Error(`Binary file rejected: ${rel}`);
    let text = buf.toString("utf8");
    const allLines = text.split("\n");
    const start = typeof args.start === "number" ? Math.max(1, Math.floor(args.start)) : 1;
    const end =
      typeof args.end === "number" ? Math.min(allLines.length, Math.floor(args.end)) : allLines.length;
    if (start > 1 || end < allLines.length) {
      text = allLines.slice(start - 1, end).join("\n");
    }
    let truncated = false;
    if (text.length > 60_000) {
      text = text.slice(0, 60_000) + "\n…(truncated)";
      truncated = true;
    }
    emit({
      summary: `read ${rel} (lines ${start}–${Math.min(end, allLines.length)}${truncated ? ", truncated" : ""})`,
    });
    return text;
  },
};

export const search: Tool = {
  name: "search",
  description:
    "Search for a text query across project files. Returns file:line: match lines (capped).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Plain text or simple substring to find" },
      glob: { type: "string", description: "Optional file extension filter, e.g. '.ts' or 'tsx'" },
    },
    required: ["query"],
  },
  needsApproval: false,
  async run(raw, { emit }) {
    const args = safeJsonArgs(raw);
    const query = String(args.query ?? "");
    if (!query) throw new Error("query is required");
    const extFilter = args.glob ? String(args.glob).replace(/^\*\./, ".").toLowerCase() : "";
    const root = getRoot();
    if (!root) throw new Error("No project selected");

    const hits: string[] = [];
    const MAX_HITS = 80;
    const walk = (dir: string) => {
      if (hits.length >= MAX_HITS) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (hits.length >= MAX_HITS) return;
        if (ent.isDirectory()) {
          if (shouldSkipDir(ent.name)) continue;
          walk(path.join(dir, ent.name));
          continue;
        }
        const name = ent.name;
        if (extFilter) {
          const want = extFilter.startsWith(".") ? extFilter : `.${extFilter}`;
          if (!name.toLowerCase().endsWith(want)) continue;
        }
        const abs = path.join(dir, name);
        const rel = toRel(abs);
        if (isSecretPath(rel)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > 512 * 1024) continue;
        let buf: Buffer;
        try {
          buf = fs.readFileSync(abs);
        } catch {
          continue;
        }
        if (looksBinary(buf)) continue;
        const text = buf.toString("utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= MAX_HITS) break;
          }
        }
      }
    };
    walk(root);
    emit({ summary: `search "${query}" → ${hits.length} hit(s)` });
    return hits.length ? hits.join("\n") : "No matches.";
  },
};

export const FS_READ_TOOLS: Tool[] = [listDir, readFile, search];
