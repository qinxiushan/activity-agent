export type AuthMode = "disabled" | "optional" | "required";

export function getAuthMode(): AuthMode {
  const raw = (process.env.AUTH_MODE ?? "optional").toLowerCase();
  if (raw === "disabled" || raw === "required") return raw;
  return "optional";
}

export function isAuthRequired(): boolean {
  return getAuthMode() === "required";
}
