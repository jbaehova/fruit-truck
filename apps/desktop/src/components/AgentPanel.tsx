import { CircleAlert, CirclePause, CircleStop, Clock3, Link2, MessageCircle, RotateCcw, Sparkles, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@base-ui/react/progress";
import { useI18n } from "@/i18n";
import type { AgentSessionState } from "@/agent";
import type { SessionVideoJob } from "@/studio";

type Props = {
  state: AgentSessionState;
  jobs: SessionVideoJob[];
  onToggleControl: () => void;
  onPauseResume: () => void;
  onStop: () => void;
};

export function AgentPanel({
  state,
  jobs,
  onToggleControl,
  onPauseResume,
  onStop,
}: Props) {
  const { t } = useI18n();
  const pending = state.decisions.filter((item) => item.status === "pending");
  const blocking = pending.find((item) => item.blocking) ?? pending[0];
  const activeStep = state.plan.find((item) => item.id === state.currentStepId);
  const activeJob = jobs.find((item) => item.status === "pending" || item.status === "in_progress");
  const status = state.connection.status === "disconnected"
    ? "notConnected"
    : state.connection.status === "waiting"
    ? "waitingConnection"
    : blocking ? "waitingChoice"
      : state.runStatus === "paused" || state.runStatus === "idle" ? "paused"
        : state.runStatus === "failed" ? "failed"
          : state.runStatus === "completed" ? "completed"
            : "working";
  const statusIcon = status === "notConnected" ? <UserRound />
    : status === "waitingConnection" ? <Link2 />
    : status === "waitingChoice" ? <Clock3 />
      : status === "paused" ? <CirclePause />
        : status === "failed" ? <CircleAlert />
          : status === "completed" ? <Sparkles />
            : <span className="agent-live-dot" />;

  return (
    <section className="agent-panel" aria-label={t("agent")}>
      <div className={`agent-status-line ${status}`}>
        <span>{statusIcon}</span>
        <div>
          <small>{t("agentStatus")}</small>
          <strong>{t(status)}</strong>
        </div>
      </div>

      <div className="agent-current-action">
        <small>{t("currentAction")}</small>
        <strong>{blocking?.title ?? activeStep?.title ?? (
          state.connection.status === "disconnected"
            ? t("agentNotConnected")
            : state.connection.status === "waiting" ? t("waitingForAgent") : t("readyForAgentWork")
        )}</strong>
        <p>{blocking?.prompt ?? activeStep?.description ?? (
          state.connection.status === "disconnected"
            ? t("agentNotConnectedHint")
            : state.connection.status === "waiting"
            ? t("waitingForAgentHint")
            : t("agentWorkingHint")
        )}</p>
      </div>

      {state.connection.status === "claimed" && state.imageGeneration.status === "selected" ? (
        <dl className="agent-session-meta">
          <div>
            <dt>{t("generationBackend")}</dt>
            <dd>{state.imageGeneration.backend === "codex_builtin" ? t("codexBuiltIn") : "OpenRouter"}</dd>
          </div>
        </dl>
      ) : null}

      {activeJob ? (
        <Progress.Root className="agent-job-progress" value={activeJob.progress ?? null}>
          <div><Progress.Label>{t("generatingVideo")}</Progress.Label><Progress.Value>{() => activeJob.progress == null ? t("statusInProgress") : `${activeJob.progress}%`}</Progress.Value></div>
          <Progress.Track><Progress.Indicator /></Progress.Track>
        </Progress.Root>
      ) : null}

      {blocking ? (
        <div className="agent-chat-handoff" role="status">
          <MessageCircle />
          <span>{t("answerInAgentChat")}</span>
        </div>
      ) : null}

      <div className="agent-control-strip">
        <Button size="xs" variant="ghost" onClick={onToggleControl}>
          <UserRound /> {state.controlMode === "agent" ? t("takeControl") : t("handToAgent")}
        </Button>
        {state.controlMode === "agent" && state.connection.status === "claimed" ? (
          <>
            <Button size="icon-xs" variant="ghost" aria-label={state.runStatus === "paused" ? t("resume") : t("pause")} onClick={onPauseResume}>
              {state.runStatus === "paused" ? <RotateCcw /> : <CirclePause />}
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label={t("stop")} onClick={onStop}><CircleStop /></Button>
          </>
        ) : null}
      </div>
    </section>
  );
}
