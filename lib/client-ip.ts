import { isIP } from "node:net";

function normalizeIp(value: string): string {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

export function isPublicIp(value: string): boolean {
  const ip = normalizeIp(value);
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    return lower !== "::1" && lower !== "::" && !lower.startsWith("fc") &&
      !lower.startsWith("fd") && !lower.startsWith("fe8") &&
      !lower.startsWith("fe9") && !lower.startsWith("fea") && !lower.startsWith("feb");
  }
  return false;
}

/**
 * Forwarded headers are trusted only when the deployment explicitly opts in.
 * The returned IP is runtime-only and must never be persisted or returned to the LLM.
 */
export function extractTrustedClientIp(req: Request): string | undefined {
  if (process.env.TRUST_PROXY_HEADERS !== "true") return undefined;
  const candidates = [
    req.headers.get("cf-connecting-ip"),
    req.headers.get("x-real-ip"),
    req.headers.get("x-forwarded-for")?.split(",")[0],
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ip = normalizeIp(candidate);
    if (isPublicIp(ip)) return ip;
  }
  return undefined;
}
