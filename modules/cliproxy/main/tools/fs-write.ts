import fs from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { resolveInside, isSecretPath } from "../cowork-project.js";
import type { Tool, ApprovalPreview } from "./types.js";
import { safeJsonArgs } from "./types.js";

function previewWrite(rel: string, content: string, mode: "edit" | "create" | "write"): ApprovalPreview {
  const abs = resolveInside(rel);
  const exists = fs.existsSync(abs);
  const before = exists && fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf8") : "";
  const diff = createTwoFilesPatch(rel, rel, before, content);
  return {
    title: `${mode === "create" ? "Create" : mode === "edit" ? "Edit" : "Write"} ${rel}`,
    detail: exists ? `Replace contents of ${rel}` : `Create new file ${rel}`,
    danger: false,
    diff,
  };
}

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or overwrite a text file with the full new contents (relative path).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  needsApproval: true,
  prepareApproval(raw) {
    const args = safeJsonArgs(raw);
    return previewWrite(String(args.path ?? ""), String(args.content ?? ""), "write");
  },
  async run(raw, { emit }) {
    const args = safeJsonArgs(raw);
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (isSecretPath(rel)) throw new Error(`Refusing to write secret path: ${rel}`);
    const abs = resolveInside(rel);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const diff = createTwoFilesPatch(rel, rel, before, content);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    emit({ summary: `wrote ${rel} (${content.split("\n").length} lines)`, diff });
    return `Wrote ${rel} (${content.split("\n").length} lines).`;
  },
};

export const editFile: Tool = {
  name: "edit_file",
  description:
    "Replace the full contents of an existing file. Prefer this when modifying a known file; provide the complete new file text.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  needsApproval: true,
  prepareApproval(raw) {
    const args = safeJsonArgs(raw);
    return previewWrite(String(args.path ?? ""), String(args.content ?? ""), "edit");
  },
  async run(raw, { emit }) {
    const args = safeJsonArgs(raw);
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (isSecretPath(rel)) throw new Error(`Refusing to edit secret path: ${rel}`);
    const abs = resolveInside(rel);
    if (!fs.existsSync(abs)) throw new Error(`File does not exist: ${rel} (use write_file or create_file)`);
    const before = fs.readFileSync(abs, "utf8");
    const diff = createTwoFilesPatch(rel, rel, before, content);
    fs.writeFileSync(abs, content, "utf8");
    emit({ summary: `edited ${rel}`, diff });
    return `Edited ${rel} (${content.split("\n").length} lines).`;
  },
};

export const createFile: Tool = {
  name: "create_file",
  description: "Create a new text file. Fails if the file already exists.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  needsApproval: true,
  prepareApproval(raw) {
    const args = safeJsonArgs(raw);
    return previewWrite(String(args.path ?? ""), String(args.content ?? ""), "create");
  },
  async run(raw, { emit }) {
    const args = safeJsonArgs(raw);
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (isSecretPath(rel)) throw new Error(`Refusing to create secret path: ${rel}`);
    const abs = resolveInside(rel);
    if (fs.existsSync(abs)) throw new Error(`Already exists: ${rel}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    const diff = createTwoFilesPatch(rel, rel, "", content);
    emit({ summary: `created ${rel}`, diff });
    return `Created ${rel}.`;
  },
};

export const deleteFile: Tool = {
  name: "delete_file",
  description: "Delete a file inside the project. Requires approval (dangerous).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
  needsApproval: true,
  danger: true,
  prepareApproval(raw) {
    const args = safeJsonArgs(raw);
    const rel = String(args.path ?? "");
    return {
      title: `Delete ${rel}`,
      detail: `Permanently delete ${rel}`,
      danger: true,
    };
  },
  async run(raw, { emit }) {
    const args = safeJsonArgs(raw);
    const rel = String(args.path ?? "");
    const abs = resolveInside(rel);
    if (!fs.existsSync(abs)) throw new Error(`Not found: ${rel}`);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error(`Not a file (won't delete directories): ${rel}`);
    fs.rmSync(abs);
    emit({ summary: `deleted ${rel}` });
    return `Deleted ${rel}.`;
  },
};

export const FS_WRITE_TOOLS: Tool[] = [writeFileTool, editFile, createFile, deleteFile];
