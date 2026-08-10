import type { OpenAICompatibleModel } from "./openai-compatible.js";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1/";

export const OPENAI_MODELS: readonly OpenAICompatibleModel[] = Object.freeze([
  Object.freeze({
    id: "openai/gpt-4.1",
    upstreamId: "gpt-4.1",
    ownedBy: "openai",
    status: "active",
    capabilities: Object.freeze({ tools: false, responseFormat: true }),
  }),
  Object.freeze({
    id: "openai/gpt-4.1-mini",
    upstreamId: "gpt-4.1-mini",
    ownedBy: "openai",
    status: "active",
    capabilities: Object.freeze({ tools: false, responseFormat: true }),
  }),
]);