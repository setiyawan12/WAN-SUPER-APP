export function isLoopbackAddress(value: string) {
  return value === "127.0.0.1" || value === "::1" || value.toLowerCase() === "localhost";
}

export function isTrustedIpcSender(sender: any, expected: any) {
  return Boolean(expected && !expected.isDestroyed?.() && sender === expected);
}