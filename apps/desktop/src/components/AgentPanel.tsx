import { CircleAlert, CirclePause, CircleStop, Clock3, ExternalLink, Link2, MessageCircle, RotateCcw, Sparkles, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@base-ui/react/progress";
import { useI18n } from "@/i18n";
import type { AgentSessionState } from "@/agent";
import { activeGenerationAttempt, latestGenerationAttempt, type GenerationThread } from "@/studio";
import type { GenerationMode } from "@/openrouter";

export type BatchSummary = {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  uncertain: number;
  canceled: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
};

type Props = {
  state: AgentSessionState;
  threads: Record<GenerationMode, GenerationThread[]>;
  currentMode: GenerationMode;
  batchSummary?: BatchSummary | null;
  onOpenThread: (mode: GenerationMode, threadId: string) => void;
  onToggleControl: () => void;
  onPauseResume: () => void;
  onStop: () => void;
  onOpenDecision: () => void;
};

export function AgentPanel({
  state,
  threads,
  currentMode,
  batchSummary,
  onOpenThread,
  onToggleControl,
  onPauseResume,
  onStop,
  onOpenDecision,
}: Props) {
  const { t } = useI18n();
  const pending = state.decisions.filter((item) => item.status === "pending");
  const blocking = pending.find((item) => item.blocking) ?? pending[0];
  const activeSteps = state.plan.filter((item) => item.status === "in_progress" || item.status === "waiting");
  const allThreads = [...threads.image, ...threads.video];
  const visibleThreads = allThreads.filter((thread) => !thread.archivedAt);
  const activeThreads = visibleThreads.filter((thread) => activeGenerationAttempt(thread));
  const latestStatuses = visibleThreads.flatMap((thread) => {
    const status = latestGenerationAttempt(thread)?.status;
    return status ? [status] : [];
  });
  const queuedCount = latestStatuses.filter((status) => ["queued", "enhancing", "awaiting_host"].includes(status)).length;
  const runningCount = latestStatuses.filter((status) => ["submitting", "in_progress"].includes(status)).length;
  const failedCount = latestStatuses.filter((status) => status === "failed").length;
  const uncertainCount = latestStatuses.filter((status) => status === "uncertain").length;
  const completedCount = latestStatuses.filter((status) => status === "completed").length;
  const failedThreads = visibleThreads.filter((thread) => {
    const status = latestGenerationAttempt(thread)?.status;
    return status === "failed" || status === "uncertain";
  });
  const outsideMode = activeThreads.filter((thread) => thread.mode !== currentMode);
  const attempts = allThreads.flatMap((thread) => thread.attempts);
  const totalCost = attempts.reduce((sum, attempt) => sum + (attempt.actualCostUsd ?? attempt.estimatedCostUsd ?? 0), 0);
  const activeStep = activeSteps[0];
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
        <strong>{blocking?.title ?? (activeSteps.length > 1 ? t("parallelAgentActions", { count: activeSteps.length }) : activeStep?.title) ?? (
          state.connection.status === "disconnected"
            ? t("agentNotConnected")
            : state.connection.status === "waiting" ? t("waitingForAgent") : t("readyForAgentWork")
        )}</strong>
        <p>{blocking?.prompt ?? (activeSteps.length > 1 ? activeSteps.map((item) => item.title).join(" · ") : activeStep?.description) ?? (
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

      <section className="project-overview" aria-label={t("projectOverview")}>
        <header><small>{t("projectOverview")}</small><strong>{t("activeThreads", { count: activeThreads.length })}</strong></header>
        <dl>
          <div><dt>{t("queuedThreads")}</dt><dd>{queuedCount}</dd></div>
          <div><dt>{t("runningThreads")}</dt><dd>{runningCount}</dd></div>
          <div><dt>{t("failedThreads")}</dt><dd>{failedCount}</dd></div>
          <div><dt>{t("uncertainThreads")}</dt><dd>{uncertainCount}</dd></div>
          <div><dt>{t("completedThreads")}</dt><dd>{completedCount}</dd></div>
          <div><dt>{t("pendingDecisions")}</dt><dd>{pending.length}</dd></div>
          <div><dt>{t("trackedCost")}</dt><dd>${totalCost.toFixed(2)}</dd></div>
        </dl>
        {outsideMode.length ? <p>{t("outsideModeRunning", { count: outsideMode.length })}</p> : null}
        {failedThreads.length ? <div className="project-thread-links">{failedThreads.map((thread) => (
          <Button variant="ghost" size="xs" key={thread.id} onClick={() => onOpenThread(thread.mode, thread.id)}>
            <CircleAlert /> {thread.name}
          </Button>
        ))}</div> : null}
        {batchSummary ? <p className="batch-summary">{t("batchResult", {
          completed: batchSummary.completed,
          total: batchSummary.total,
          running: batchSummary.queued + batchSummary.running,
          failed: batchSummary.failed + batchSummary.uncertain + batchSummary.canceled,
        })}{batchSummary.actualCostUsd != null || batchSummary.estimatedCostUsd != null ? <small>{t("batchCost", {
          cost: [
            batchSummary.actualCostUsd != null ? `$${batchSummary.actualCostUsd.toFixed(2)} ${t("actualCost")}` : "",
            batchSummary.estimatedCostUsd != null ? `$${batchSummary.estimatedCostUsd.toFixed(2)} ${t("estimatedCost")}` : "",
          ].filter(Boolean).join(" · "),
        })}</small> : null}</p> : null}
      </section>

      {activeThreads.flatMap((thread) => {
        const activeAttempt = activeGenerationAttempt(thread);
        return activeAttempt ? [(
        <Progress.Root className="agent-job-progress" value={activeAttempt.progress ?? null} key={activeAttempt.id}>
          <div><Progress.Label>{thread.name}</Progress.Label><Progress.Value>{() => activeAttempt.progress == null ? t("statusInProgress") : `${activeAttempt.progress}%`}</Progress.Value></div>
          <Progress.Track><Progress.Indicator /></Progress.Track>
        </Progress.Root>
        )] : [];
      })}

      {blocking && (blocking.channel ?? "agent_chat") === "agent_chat" ? (
        <div className="agent-chat-handoff" role="status">
          <MessageCircle />
          <span>{t("answerInAgentChat")}</span>
        </div>
      ) : null}
      {blocking && blocking.channel === "fruit_truck_ui" ? (
        <Button className="agent-open-decision" onClick={onOpenDecision}>
          <ExternalLink /> {t("openDecision")}
        </Button>
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
