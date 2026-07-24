// Provider → gemstone accents for the neuron "constellation" view.
// Soft, high-end metals/jewels that sit well on the aurora dark shell.
// Pure + dependency-free so unit tests and the canvas share the same map.

const PALETTES: Record<string, { accent: string; soft: string }> = {
  // champagne gold
  anthropic: { accent: "#e8c48a", soft: "rgba(232,196,138,0.18)" },
  // soft sapphire
  gemini: { accent: "#7ec8f0", soft: "rgba(126,200,240,0.18)" },
  // jade / seafoam
  openai: { accent: "#6ed9b5", soft: "rgba(110,217,181,0.18)" },
  // amethyst
  xai: { accent: "#b8a0f0", soft: "rgba(184,160,240,0.18)" },
};

const FALLBACK = { accent: "#a8b0c4", soft: "rgba(168,176,196,0.14)" }; // cool pearl slate

// Collapse the many names CLIProxyAPI / clients use into one palette key.
export function normalizeProvider(provider: string): string {
  const p = (provider || "").toLowerCase();
  if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
  if (p.includes("gemini") || p.includes("google")) return "gemini";
  if (p.includes("openai") || p.includes("gpt") || p.includes("codex")) return "openai";
  if (p.includes("xai") || p.includes("grok")) return "xai";
  return p || "unknown";
}

export function providerPalette(provider: string): { accent: string; soft: string } {
  return PALETTES[normalizeProvider(provider)] ?? FALLBACK;
}
