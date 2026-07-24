// Pure, Electron-free logic for the JetBrains/ProxyAI sync. Kept in its own
// module (no electron/fs imports) so it can be unit-tested directly under plain
// `node --test` -- these are exactly the fiddly bits (XML escaping, JSON-in-
// attribute round-tripping, merge-preserving foreign services, stable ids) that
// silently corrupt ProxyAI's config if they regress. jetbrains-sync.ts wires
// these to the filesystem, the backend and the keychain.

export const SERVICE_ID_PREFIX = "wan-";
export const OPTIONS_FILE = "CodeGPT_CustomServicesSettings.xml";
export const COMPONENT_NAME = "CodeGPT_CustomServicesSettings";
// ProxyAI stores each custom-service key in the IDE PasswordSafe under this
// service name (verified against a real "IntelliJ Platform CodeGPT —
// CODEGPT_API_KEY" keychain entry; em dash is U+2014).
export const KEYCHAIN_SERVICE_PREFIX =
  "IntelliJ Platform CodeGPT — CUSTOM_SERVICE_API_KEY_ID:";

export interface RemoteModelEntry {
  id: string;
  name: string;
  url: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface JbService {
  id: string;
  name: string;
  template: string;
  contextWindowSize?: number;
  chatCompletionSettings: unknown;
  codeCompletionSettings: unknown;
  [key: string]: unknown;
}

// The services list is a single JSON string held in the `value` attribute;
// inside it every real quote is escaped to &quot;, so the attribute has no raw
// double-quote until its own closing one -- [^"]* is safe.
const SERVICES_OPTION_RE = /<option name="services" value="([^"]*)"\s*\/?>/;

export function xmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Deterministic keychain service name for a given wan- service id. */
export function keychainServiceName(serviceId: string): string {
  return KEYCHAIN_SERVICE_PREFIX + serviceId;
}

/** Stable, collision-resistant service id derived from a model id. */
export function serviceIdFor(modelId: string): string {
  return SERVICE_ID_PREFIX + modelId.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Parse the services already stored in a config file's raw text.
 *   { ok: true, services } -> parsed (possibly empty when the component exists
 *                             but has no services yet, or the file is blank)
 *   { ok: false }          -> file has content we don't recognise; the caller
 *                             MUST leave it untouched rather than clobber it.
 */
export function parseServicesXml(
  raw: string
): { ok: true; services: JbService[] } | { ok: false } {
  const m = raw.match(SERVICES_OPTION_RE);
  if (!m) {
    if (raw.trim() === "" || raw.includes(`name="${COMPONENT_NAME}"`)) {
      return { ok: true, services: [] };
    }
    return { ok: false };
  }
  try {
    const arr = JSON.parse(xmlUnescape(m[1]));
    return Array.isArray(arr) ? { ok: true, services: arr as JbService[] } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function serializeServicesXml(services: JbService[]): string {
  const json = JSON.stringify(services);
  return (
    `<application>\n` +
    `  <component name="${COMPONENT_NAME}">\n` +
    `    <option name="services" value="${xmlEscape(json)}" />\n` +
    `  </component>\n` +
    `</application>`
  );
}

export function buildService(model: RemoteModelEntry, authValue: string): JbService {
  const headers = {
    "Content-Type": "application/json",
    "X-LLM-Application-Tag": "proxyai",
    Authorization: `Bearer ${authValue}`,
  };
  // ProxyAI's stored body is only the extra params (it injects messages itself
  // at request time -- the OPENAI template body is {stream, model, max_tokens}).
  const body = { stream: true, model: model.id, max_tokens: model.maxOutputTokens ?? 32_768 };
  return {
    id: serviceIdFor(model.id),
    name: `${model.name} (WAN)`,
    template: "OPENAI",
    contextWindowSize: model.maxInputTokens ?? 200_000,
    chatCompletionSettings: { url: model.url, headers, body },
    // Chat only -- routing code-completion through a chat model would be wrong
    // and burn tokens, so leave completions disabled.
    codeCompletionSettings: {
      codeCompletionsEnabled: false,
      parseResponseAsChatCompletions: false,
      infillTemplate: "OPENAI",
      url: model.url,
      headers,
      body: { ...body },
    },
  };
}

/** Whether any service in the list is one of ours. */
export function hasWanService(services: JbService[]): boolean {
  return services.some((s) => (s.id ?? "").startsWith(SERVICE_ID_PREFIX));
}

/**
 * Merge our desired services into whatever is already on disk: drop our old
 * wan- entries (so re-syncs don't duplicate), keep every foreign service the
 * user configured by hand, then append the fresh set.
 */
export function mergeServices(existing: JbService[], desired: JbService[]): JbService[] {
  const foreign = existing.filter((s) => !(s.id ?? "").startsWith(SERVICE_ID_PREFIX));
  return [...foreign, ...desired];
}
