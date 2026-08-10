export interface LogFields {
  request_id: string;
  generation_id?: string;
  generation_status?: "succeeded" | "failed" | "cancelled";
  method?: string;
  path?: string;
  status?: number;
  latency_ms?: number;
  ttft_ms?: number;
  workspace_id?: string;
  api_key_id?: string;
  requested_model?: string;
  resolved_model?: string;
  provider_id?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  usage_estimated?: boolean;
  stream?: boolean;
  operation?: "encrypt" | "decrypt";
  error_code?: string;
}

export interface GatewayLogger {
  info(message: string, fields: LogFields): void;
  error(message: string, fields: LogFields): void;
}

export const consoleGatewayLogger: GatewayLogger = {
  info(message, fields) {
    console.log(JSON.stringify({ severity: "INFO", message, ...fields }));
  },
  error(message, fields) {
    console.error(JSON.stringify({ severity: "ERROR", message, ...fields }));
  },
};