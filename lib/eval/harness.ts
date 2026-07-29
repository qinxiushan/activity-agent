import { gradeEvalRun } from "./graders";
import { ScriptedUser } from "./scripted-user";
import { EvalTraceRecorder } from "./trace-recorder";
import type {
  EvalAgentCommand,
  EvalAgentDriver,
  EvalGrade,
  EvalRun,
  EvalScenario,
} from "./types";

export interface EvalHarnessResult {
  run: EvalRun;
  grade: EvalGrade;
}

export class EvalHarness {
  constructor(private readonly maxScriptedTurns = 8) {}

  async run(scenario: EvalScenario, driver: EvalAgentDriver): Promise<EvalHarnessResult> {
    const recorder = new EvalTraceRecorder(
      scenario.id,
      scenario.version,
      driver.target,
    );
    const user = new ScriptedUser(scenario.user.steps ?? []);
    recorder.append({
      at: new Date().toISOString(),
      type: "user_message",
      message: scenario.user.initialMessage,
      detail: { commandType: "prompt" },
    });

    try {
      let turn = await driver.start(scenario.user.initialMessage);
      recorder.appendMany(turn.events);
      recorder.snapshot(turn.state);

      for (let index = 0; index < this.maxScriptedTurns; index++) {
        const next = user.next(recorder.trace, turn.state);
        if (!next || next.stop) break;
        const command = next.command!;
        this.recordUserCommand(recorder, command, next.step.id);
        turn = await driver.send(command);
        recorder.appendMany(turn.events);
        recorder.snapshot(turn.state);
      }
    } catch (error) {
      recorder.append({
        at: new Date().toISOString(),
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await driver.close();
    }

    const run = recorder.build();
    return { run, grade: gradeEvalRun(scenario, run) };
  }

  private recordUserCommand(
    recorder: EvalTraceRecorder,
    command: EvalAgentCommand,
    stepId: string,
  ): void {
    recorder.append({
      at: new Date().toISOString(),
      type: "user_message",
      message: command.message,
      detail: {
        commandType: command.type,
        stepId,
        clarificationId: command.clarificationId,
      },
    });
  }
}
