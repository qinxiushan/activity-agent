"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  ClarificationQuestion,
  PendingClarification,
} from "@/lib/clarification";
import { canSubmitClarificationWithDefaults } from "@/lib/clarification";

interface Props {
  clarification: PendingClarification;
  submitting: boolean;
  onSubmit: (answers: Record<string, unknown>) => Promise<boolean>;
}

export function ClarificationCard({ clarification, submitting, onSubmit }: Props) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  useEffect(() => {
    setIndex(0);
    setAnswers({});
    setValidationError(null);
  }, [clarification.id]);
  const question = clarification.questions[index];
  const allAnswered = useMemo(
    () => clarification.questions.every((item) => !item.required || hasValue(answers[item.id])),
    [answers, clarification.questions],
  );
  const canUseDefaults = useMemo(
    () => canSubmitClarificationWithDefaults(clarification.questions, answers),
    [answers, clarification.questions],
  );
  const hasUnusedDefault = useMemo(
    () => clarification.questions.some((item) =>
      !hasValue(answers[item.id]) && hasValue(item.fallbackValue)),
    [answers, clarification.questions],
  );
  if (!question || clarification.status !== "pending") return null;

  const submit = async (useDefaults: boolean) => {
    const payload = { ...answers };
    if (useDefaults) {
      for (const item of clarification.questions) {
        if (!hasValue(payload[item.id]) && item.fallbackValue !== undefined) {
          payload[item.id] = item.fallbackValue;
        }
      }
    }
    const missingIndex = clarification.questions.findIndex((item) =>
      item.required && !hasValue(payload[item.id]));
    if (missingIndex >= 0) {
      setIndex(missingIndex);
      setValidationError(`请填写：${clarification.questions[missingIndex]!.title}`);
      return;
    }
    setValidationError(null);
    await onSubmit(payload);
  };

  return (
    <div style={{
      marginBottom: 12,
      border: "1px solid rgba(99,102,241,0.45)",
      background: "var(--bg-panel)",
      borderRadius: 12,
      overflow: "hidden",
      boxShadow: "0 10px 30px rgba(15,23,42,0.12)",
    }}>
      <div style={{
        padding: "12px 14px 10px",
        background: "linear-gradient(135deg, rgba(79,70,229,0.14), rgba(14,165,233,0.08))",
        borderBottom: "1px solid var(--border)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
            {clarification.title}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
            {index + 1} / {clarification.questions.length}
          </div>
        </div>
        {clarification.description && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
            {clarification.description}
          </div>
        )}
        <div style={{ display: "flex", gap: 4, marginTop: 9 }}>
          {clarification.questions.map((item, itemIndex) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setIndex(itemIndex)}
              title={item.title}
              style={{
                height: 4,
                flex: 1,
                padding: 0,
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                background: itemIndex === index
                  ? "#6366f1"
                  : hasValue(answers[item.id]) ? "#10b981" : "var(--border)",
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ padding: "14px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
          {question.title}
          {question.required && <span style={{ color: "#ef4444", marginLeft: 3 }}>*</span>}
        </div>
        {question.description && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 10 }}>
            {question.description}
          </div>
        )}
        <QuestionInput
          question={question}
          value={answers[question.id]}
          onChange={(value) => {
            setValidationError(null);
            setAnswers((previous) => ({ ...previous, [question.id]: value }));
          }}
        />
        {validationError && (
          <div role="alert" style={{ marginTop: 8, fontSize: 10, color: "#ef4444" }}>
            {validationError}
          </div>
        )}
      </div>

      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "10px 14px",
        borderTop: "1px solid var(--border)",
      }}>
        <button
          type="button"
          onClick={() => setIndex((value) => Math.max(0, value - 1))}
          disabled={index === 0 || submitting}
          style={secondaryButton(index === 0 || submitting)}
        >
          上一个
        </button>
        {index < clarification.questions.length - 1 ? (
          <button
            type="button"
            onClick={() => setIndex((value) => Math.min(clarification.questions.length - 1, value + 1))}
            disabled={submitting}
            style={{ ...primaryButton(submitting), marginLeft: "auto" }}
          >
            下一个
          </button>
        ) : (
          <>
            {hasUnusedDefault && (
              <button
                type="button"
                disabled={submitting || !canUseDefaults}
                onClick={() => void submit(true)}
                title={!canUseDefaults ? "仍有必填项没有默认值" : undefined}
                style={{ ...secondaryButton(submitting || !canUseDefaults), marginLeft: "auto" }}
              >
                使用默认值
              </button>
            )}
            <button
              type="button"
              disabled={!allAnswered || submitting}
              onClick={() => void submit(false)}
              style={primaryButton(!allAnswered || submitting)}
            >
              {submitting ? "提交中…" : "提交并开始规划"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function QuestionInput({
  question,
  value,
  onChange,
}: {
  question: ClarificationQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (question.type === "single_select") {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {question.options?.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            style={choiceButton(String(value) === String(option.value))}
            title={option.description}
          >
            {option.label}
          </button>
        ))}
        {question.allowCustomInput && (
          <input
            type={question.field === "partySize" || question.field === "budgetPerPerson" ? "number" : "text"}
            min={question.min}
            max={question.max}
            value={value !== undefined && !question.options?.some((option) => String(option.value) === String(value)) ? String(value) : ""}
            onChange={(event) => onChange(event.target.value)}
            placeholder={question.placeholder ?? "其他"}
            style={inputStyle}
          />
        )}
      </div>
    );
  }
  if (question.type === "multi_select") {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {question.options?.map((option) => {
          const active = selected.includes(String(option.value));
          return (
            <button
              key={String(option.value)}
              type="button"
              onClick={() => onChange(active
                ? selected.filter((item) => item !== String(option.value))
                : [...selected, option.value])}
              style={choiceButton(active)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }
  if (question.type === "location") {
    const location = value && typeof value === "object"
      ? value as { name?: string; city?: string }
      : {};
    return (
      <div style={{ display: "grid", gap: 7 }}>
        <input
          value={location.name ?? ""}
          onChange={(event) => onChange({ ...location, name: event.target.value })}
          placeholder={question.placeholder ?? "具体出发地点"}
          style={inputStyle}
        />
        <input
          value={location.city ?? ""}
          onChange={(event) => onChange({ ...location, city: event.target.value })}
          placeholder="城市，例如：广州"
          style={inputStyle}
        />
      </div>
    );
  }
  return (
    <input
      type={question.type === "number" ? "number" : question.type}
      min={question.min}
      max={question.max}
      value={value === undefined ? "" : String(value)}
      onChange={(event) => onChange(event.target.value)}
      placeholder={question.placeholder}
      style={{ ...inputStyle, width: "100%" }}
    />
  );
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    const location = value as { name?: unknown; city?: unknown };
    return !!location.name && !!location.city;
  }
  return true;
}

const inputStyle: React.CSSProperties = {
  minWidth: 110,
  padding: "8px 10px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  color: "var(--text)",
  background: "var(--bg)",
  fontSize: 11,
  outline: "none",
};

function choiceButton(active: boolean): React.CSSProperties {
  return {
    padding: "7px 11px",
    borderRadius: 999,
    border: `1px solid ${active ? "#6366f1" : "var(--border)"}`,
    color: active ? "#fff" : "var(--text-muted)",
    background: active ? "#6366f1" : "var(--bg)",
    cursor: "pointer",
    fontSize: 11,
  };
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "7px 11px",
    border: "none",
    borderRadius: 6,
    color: "#fff",
    background: disabled ? "var(--bg-muted)" : "#4f46e5",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
    fontWeight: 600,
  };
}

function secondaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "7px 10px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: disabled ? "var(--text-dim)" : "var(--text-muted)",
    background: "var(--bg)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
  };
}
