export interface DomainToolResponse<T> {
  code: number;
  message: string;
  data: T;
  timelineText: string;
}

export function buildOkResponse<T>(data: T, timelineText = ""): DomainToolResponse<T> {
  return { code: 0, message: "ok", data, timelineText };
}

export function buildErrorResponse<T>(message: string, data: T, timelineText = ""): DomainToolResponse<T> {
  return { code: 1, message, data, timelineText };
}

export function toToolResult<T>(response: DomainToolResponse<T>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
    details: response,
  };
}
