import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";

// Projects / Spaces (HANDBOOK M6 — Tahap 9). A lightweight grouping layer over
// conversations: each project carries a name + an optional default system
// prompt (persona) that new chats in it inherit. Conversations reference a
// project by id (Conversation.projectId in chat-store.ts); the project list
// lives in a single userData/projects.json. Same atomic-write discipline as
// chat-store.ts (.tmp → rename) so a quit mid-save can't corrupt it.

export interface Project {
  id: string;
  name: string;
  systemPrompt?: string; // default persona applied to new chats in this project
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

function projectsFile(): string {
  return path.join(app.getPath("userData"), "projects.json");
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

function readAll(): Project[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectsFile(), "utf8"));
    return Array.isArray(parsed) ? (parsed as Project[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: Project[]): void {
  writeAtomic(projectsFile(), JSON.stringify(list, null, 2));
}

/** Newest first. */
export function listProjects(): Project[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createProject(name: string, systemPrompt?: string): Project {
  const now = Date.now();
  const project: Project = {
    id: randomUUID(),
    name: name.trim() || "New project",
    systemPrompt: systemPrompt?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  const list = readAll();
  list.push(project);
  writeAll(list);
  return project;
}

export function updateProject(id: string, patch: { name?: string; systemPrompt?: string }): Project | null {
  const list = readAll();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const next: Project = {
    ...list[idx],
    ...(patch.name !== undefined ? { name: patch.name.trim() || list[idx].name } : {}),
    ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt.trim() || undefined } : {}),
    updatedAt: Date.now(),
  };
  list[idx] = next;
  writeAll(list);
  return next;
}

/**
 * Delete a project. Conversations keep their (now dangling) projectId; the
 * renderer treats an unknown projectId as "Unfiled", so nothing is lost — the
 * chats just fall back to the ungrouped bucket.
 */
export function deleteProject(id: string): void {
  writeAll(readAll().filter((p) => p.id !== id));
}
