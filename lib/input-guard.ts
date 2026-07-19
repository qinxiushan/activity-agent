import { detectInjectionKeyword, stripControlChars } from "./tool-result-sanitizer";

export const MAX_INPUT_CHARS = 10_000;

export interface InputGuardResult {
  ok: boolean;
  sanitized: string;
  originalLength: number;
  sanitizedLength: number;
  rejectedReason?: "too_long";
  keyword?: string;
}

export function validateUserInput(text: string): InputGuardResult {
  const sanitized = stripControlChars(text);
  const sanitizedLength = sanitized.length;
  const keyword = detectInjectionKeyword(sanitized);

  if (sanitizedLength > MAX_INPUT_CHARS) {
    return {
      ok: false,
      sanitized,
      originalLength: text.length,
      sanitizedLength,
      rejectedReason: "too_long",
      keyword: keyword ?? undefined,
    };
  }

  return {
    ok: true,
    sanitized,
    originalLength: text.length,
    sanitizedLength,
    keyword: keyword ?? undefined,
  };
}

