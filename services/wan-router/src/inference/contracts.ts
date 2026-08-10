import { z } from "zod";
import { GatewayError } from "../errors.js";

const scalarMetadataValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const metadataSchema = z.record(scalarMetadataValue).refine(
  (metadata) => Object.keys(metadata).length <= 16 && Object.keys(metadata).every((key) => /^[a-zA-Z0-9_.-]{1,64}$/.test(key)),
  "metadata supports at most 16 simple keys",
);

const contentPartSchema = z.object({
  type: z.string().min(1).max(64),
  text: z.string().max(200_000).optional(),
  image_url: z.unknown().optional(),
}).passthrough();

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([
    z.string().max(200_000),
    z.array(contentPartSchema).max(128),
    z.null(),
  ]),
  name: z.string().min(1).max(128).optional(),
  tool_call_id: z.string().min(1).max(256).optional(),
  tool_calls: z.array(z.unknown()).max(64).optional(),
}).strict();

const toolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    description: z.string().max(4_000).optional(),
    parameters: z.record(z.unknown()).optional(),
  }).strict(),
}).strict();

export const chatCompletionSchema = z.object({
  model: z.string().min(1).max(256),
  messages: z.array(messageSchema).min(1).max(256),
  stream: z.boolean().default(false),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
  max_tokens: z.number().int().positive().max(128_000).optional(),
  max_completion_tokens: z.number().int().positive().max(128_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(toolSchema).max(64).optional(),
  tool_choice: z.union([
    z.enum(["none", "auto", "required"]),
    z.object({
      type: z.literal("function"),
      function: z.object({ name: z.string().min(1).max(128) }).strict(),
    }).strict(),
  ]).optional(),
  response_format: z.record(z.unknown()).optional(),
  user: z.string().min(1).max(128).optional(),
  metadata: metadataSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.max_tokens !== undefined && value.max_completion_tokens !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Use only one of max_tokens or max_completion_tokens.",
      path: ["max_tokens"],
    });
  }
  if (value.tool_choice && !value.tools?.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "tool_choice requires tools.",
      path: ["tool_choice"],
    });
  }
});

export type NormalizedChatRequest = z.infer<typeof chatCompletionSchema>;

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated?: boolean;
}

export function parseChatCompletion(input: unknown): NormalizedChatRequest {
  const result = chatCompletionSchema.safeParse(input);
  if (result.success) return result.data;

  const unsupported = result.error.issues.find((issue) => issue.code === "unrecognized_keys");
  if (unsupported && unsupported.code === "unrecognized_keys") {
    throw new GatewayError(
      400,
      "invalid_request_error",
      "unsupported_parameter",
      `Unsupported parameter: ${unsupported.keys.join(", ")}.`,
    );
  }

  throw new GatewayError(
    400,
    "invalid_request_error",
    "invalid_request",
    result.error.issues[0]?.message || "The request body is invalid.",
  );
}