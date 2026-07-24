import { fetchUrlContext } from "../context-service.js";
import type { Tool } from "./types.js";
import { safeJsonArgs } from "./types.js";

export const fetchUrl: Tool = {
  name: "fetch_url",
  description:
    "Fetch a public web page (http/https) and return its readable text. Use for looking up current information the user references by URL.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http(s) URL to fetch" } },
    required: ["url"],
  },
  needsApproval: false,
  async run(raw, { emit }) {
    const args = safeJsonArgs(raw);
    const url = String(args.url ?? "");
    const ctx = await fetchUrlContext(url);
    emit({ summary: `fetched ${ctx.title || url}` });
    const head = `# ${ctx.title}\n(${ctx.url})${ctx.truncated ? " [truncated]" : ""}\n\n`;
    return head + ctx.text;
  },
};

export const CHAT_TOOLS: Tool[] = [fetchUrl];
