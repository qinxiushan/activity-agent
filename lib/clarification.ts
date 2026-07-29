import { randomUUID } from "node:crypto";
import type { CapturedIntent } from "./plan-state";

export type ClarificationField =
  | "date"
  | "startTime"
  | "endTime"
  | "departurePoint"
  | "partySize"
  | "budgetPerPerson"
  | "groupType"
  | "preferredCategories"
  | "dietaryRestrictions"
  | "mood"
  | "specialRequests";

export type ClarificationQuestionType =
  | "single_select"
  | "multi_select"
  | "text"
  | "number"
  | "date"
  | "time"
  | "location";

export interface ClarificationOption {
  value: string | number;
  label: string;
  description?: string;
}

export interface ClarificationQuestion {
  id: string;
  field: ClarificationField;
  type: ClarificationQuestionType;
  title: string;
  description?: string;
  required: boolean;
  options?: ClarificationOption[];
  allowCustomInput?: boolean;
  placeholder?: string;
  fallbackValue?: unknown;
  min?: number;
  max?: number;
}

export interface PendingClarification {
  id: string;
  status: "pending" | "answered" | "expired";
  title: string;
  description?: string;
  questions: ClarificationQuestion[];
  answers?: Record<string, unknown>;
  createdAt: number;
  answeredAt?: number;
}

export function canSubmitClarificationWithDefaults(
  questions: ClarificationQuestion[],
  answers: Record<string, unknown>,
): boolean {
  return questions.every((question) =>
    !question.required ||
    hasClarificationValue(answers[question.id]) ||
    hasClarificationValue(question.fallbackValue));
}

const DEFAULT_TEMPLATES: Partial<Record<ClarificationField, Omit<ClarificationQuestion, "id" | "field">>> = {
  date: {
    type: "date",
    title: "你计划哪天出发？",
    required: true,
    allowCustomInput: true,
  },
  startTime: {
    type: "time",
    title: "你希望几点开始？",
    required: true,
    fallbackValue: "10:00",
  },
  endTime: {
    type: "time",
    title: "最晚几点结束？",
    required: false,
    fallbackValue: "18:00",
  },
  departurePoint: {
    type: "location",
    title: "你从哪里出发？",
    required: true,
    allowCustomInput: true,
    placeholder: "例如：广州塔、三里屯、深圳大学城",
  },
  partySize: {
    type: "single_select",
    title: "一共有几个人？",
    required: true,
    options: [1, 2, 3, 4].map((value) => ({ value, label: `${value} 人` })),
    allowCustomInput: true,
    fallbackValue: 2,
    min: 1,
    max: 100,
  },
  budgetPerPerson: {
    type: "single_select",
    title: "人均预算大约是多少？",
    required: true,
    options: [100, 200, 300, 500].map((value) => ({ value, label: `¥${value}` })),
    allowCustomInput: true,
    fallbackValue: 300,
    min: 0,
    max: 100_000,
  },
};

function safeId(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return normalized || fallback;
}

export function normalizeClarification(input: {
  title?: string;
  description?: string;
  missingFields: string[];
  question?: string;
  questions?: ClarificationQuestion[];
  fallbackDefaults?: Record<string, unknown>;
}): PendingClarification {
  const allowedFields = new Set<ClarificationField>([
    "date", "startTime", "endTime", "departurePoint", "partySize", "budgetPerPerson",
    "groupType", "preferredCategories", "dietaryRestrictions", "mood", "specialRequests",
  ]);
  const supplied = (input.questions ?? [])
    .filter((question) => allowedFields.has(question.field))
    .slice(0, 6)
    .map((question, index): ClarificationQuestion => {
      const configuredFallback = input.fallbackDefaults?.[question.field];
      return {
        ...question,
        id: safeId(question.id, `question_${index + 1}`),
        title: cleanText(question.title, 120),
        description: question.description ? cleanText(question.description, 240) : undefined,
        placeholder: question.placeholder ? cleanText(question.placeholder, 120) : undefined,
        fallbackValue: question.fallbackValue ?? configuredFallback,
        options: question.options?.slice(0, 12).map((option) => ({
          value: option.value,
          label: cleanText(option.label, 60),
          description: option.description ? cleanText(option.description, 120) : undefined,
        })),
      };
    });
  const uncoveredFields = input.missingFields
    .filter((field): field is ClarificationField => allowedFields.has(field as ClarificationField))
    .filter((field) => !supplied.some((question) => question.field === field));
  const generated = uncoveredFields
        .slice(0, Math.max(0, 6 - supplied.length))
        .map((field, index): ClarificationQuestion => {
          const template = DEFAULT_TEMPLATES[field] ?? {
            type: "text" as const,
            title: `请补充 ${field}`,
            required: true,
            allowCustomInput: true,
          };
          return {
            ...template,
            id: safeId(field, `question_${index + 1}`),
            field,
            fallbackValue: input.fallbackDefaults?.[field] ?? template.fallbackValue,
          };
        });
  const questions = [...supplied, ...generated];
  if (questions.length === 0) throw new Error("No valid clarification questions");
  return {
    id: `clarify_${randomUUID()}`,
    status: "pending",
    title: cleanText(input.title || input.question || "补充活动信息", 120),
    description: input.description ? cleanText(input.description, 240) : "完成后将直接开始自动规划",
    questions,
    createdAt: Date.now(),
  };
}

export function applyClarificationAnswers(
  pending: PendingClarification,
  answers: Record<string, unknown>,
): { normalizedAnswers: Record<string, unknown>; intent: Partial<CapturedIntent> } {
  if (pending.status !== "pending") throw new Error("Clarification has already been answered");
  const normalizedAnswers: Record<string, unknown> = {};
  const intent: Partial<CapturedIntent> = {};
  for (const question of pending.questions) {
    const raw = answers[question.id] ?? question.fallbackValue;
    if ((raw === undefined || raw === null || raw === "") && question.required) {
      throw new Error(`请填写必填项：${question.title}`);
    }
    if (raw === undefined || raw === null || raw === "") continue;
    const value = normalizeAnswer(question, raw);
    normalizedAnswers[question.id] = value;
    Object.assign(intent, { [question.field]: value });
  }
  return { normalizedAnswers, intent };
}

function normalizeAnswer(question: ClarificationQuestion, raw: unknown): unknown {
  if (question.type === "location") {
    if (!raw || typeof raw !== "object") throw new Error(`${question.id} must be a location`);
    const value = raw as { name?: unknown; city?: unknown };
    const name = cleanText(String(value.name ?? ""), 120);
    const city = cleanText(String(value.city ?? ""), 60);
    if (!name || !city) throw new Error(`${question.id} requires name and city`);
    return { name, city };
  }
  if (question.type === "number") return normalizeNumber(question, raw);
  if (question.type === "multi_select") {
    if (!Array.isArray(raw)) throw new Error(`${question.id} must be an array`);
    return raw.slice(0, 12).map((value) => normalizeSelection(question, value));
  }
  if (question.type === "single_select") return normalizeSelection(question, raw);
  const value = cleanText(String(raw), 200);
  if (question.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${question.id} must be YYYY-MM-DD`);
  }
  if (question.type === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${question.id} must be HH:MM`);
  }
  return value;
}

function normalizeSelection(question: ClarificationQuestion, raw: unknown): string | number {
  const matching = question.options?.find((option) => String(option.value) === String(raw));
  if (matching) return matching.value;
  if (!question.allowCustomInput) throw new Error(`${question.id} is not an allowed option`);
  if (question.field === "partySize" || question.field === "budgetPerPerson") {
    return normalizeNumber(question, raw);
  }
  return cleanText(String(raw), 200);
}

function normalizeNumber(question: ClarificationQuestion, raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${question.id} must be a number`);
  if (question.min !== undefined && value < question.min) throw new Error(`${question.id} is below minimum`);
  if (question.max !== undefined && value > question.max) throw new Error(`${question.id} is above maximum`);
  return value;
}

function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function hasClarificationValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    const location = value as { name?: unknown; city?: unknown };
    return !!location.name && !!location.city;
  }
  return true;
}
