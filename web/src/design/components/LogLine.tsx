import { memo } from "react";
import type { AgentInfo, LogEntry, LogKind } from "../../../../src/core/types";
import { clock } from "../../state/format";
import { Icon, Mark, type IconName } from "../icons";
import { Callsign } from "./Callsign";

const KIND_ICON: Record<LogKind, IconName> = {
  declare: "compass",
  log: "dot",
  write: "file",
  push: "commit",
  check: "range",
  correction: "buoy",
  ack: "check",
  submit: "send",
  land: "anchor",
  stale: "range",
  rederive: "rederive",
  replot: "compass",
  decision: "lighthouse",
  intent: "amend",
  system: "info",
};

const KIND_TEXT: Record<LogKind, string> = {
  declare: "plan",
  log: "log",
  write: "write",
  push: "push",
  check: "tests",
  correction: "change request",
  ack: "acknowledge",
  submit: "submit",
  land: "merge",
  stale: "out of date",
  rederive: "redo",
  replot: "rebase",
  decision: "decision",
  intent: "task",
  system: "system",
};

interface LogLineProps {
  log: LogEntry;
  agent?: AgentInfo;
}

/** LogLine: activity row — time (mono), agent name, kind icon, message. */
export const LogLine = memo(function LogLine({ log, agent }: LogLineProps) {
  const fail = log.kind === "check" && /^Checks fail/.test(log.message);
  const cls = [
    "b-logline",
    log.kind === "correction" && "is-correction",
    log.kind === "land" && "is-land",
    log.kind === "stale" && "is-stale",
    log.kind === "decision" && "is-decision",
    fail && "is-fail",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} role="listitem">
      <time className="b-logline__time" dateTime={new Date(log.at).toISOString()}>
        {clock(log.at)}
      </time>
      <span className="b-logline__who">
        {agent ? (
          <Callsign callsign={agent.callsign} color={agent.color} model={agent.model} />
        ) : (
          <span className="b-logline__sys">
            <Mark size={14} accent={false} title="gitring" />
            gitring
          </span>
        )}
      </span>
      <span className="b-logline__kind" title={KIND_TEXT[log.kind]}>
        <Icon name={fail ? "cross" : KIND_ICON[log.kind]} title={KIND_TEXT[log.kind]} />
      </span>
      <span className="b-logline__msg">{log.message}</span>
    </div>
  );
});
