import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  persistToolExecutionSpan,
  resultUsedFallback,
  toolTelemetryRecorder,
} from "../tool-telemetry";

/**
 * SDK lifecycle-based tool telemetry. It intentionally has no dependency on
 * plan state or phase rules, so every executed tool is observable.
 */
export default function toolTelemetryExtension(pi: ExtensionAPI): void {
  pi.on("tool_execution_start", async (event, ctx) => {
    toolTelemetryRecorder.start(
      ctx.sessionManager.getSessionId(),
      event.toolCallId,
      event.toolName,
    );
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const span = toolTelemetryRecorder.finish(
      ctx.sessionManager.getSessionId(),
      event.toolCallId,
      event.toolName,
      {
        isError: event.isError,
        fallbackUsed: resultUsedFallback(event.result),
      },
    );
    await persistToolExecutionSpan(span);
  });
}
