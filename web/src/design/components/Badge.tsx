import type { ReactNode } from "react";
import type { AttemptStatus, IntentStatus, LandingMethod } from "../../../../src/core/types";
import { Icon, type IconName } from "../icons";
import { ATTEMPT_STATUS_TEXT, INTENT_STATUS_TEXT, METHOD_TEXT } from "../../state/format";

export type BadgeTone = "clear" | "correction" | "danger" | "caution" | "neutral" | "accent" | "method";

interface BadgeProps {
  tone?: BadgeTone;
  icon?: IconName;
  children: ReactNode;
  title?: string;
  className?: string;
}

/** Badge: icon + text, never color alone. */
export function Badge({ tone = "neutral", icon, children, title, className }: BadgeProps) {
  return (
    <span className={["b-badge", `b-badge--${tone}`, className].filter(Boolean).join(" ")} title={title}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

const METHOD_ICON: Record<LandingMethod, IconName> = {
  "fast-forward": "fastforward",
  merge: "merge",
  rederive: "rederive",
  revert: "reload",
};

export function MethodBadge({ method }: { method: LandingMethod }) {
  return (
    <Badge tone="method" icon={METHOD_ICON[method]}>
      {METHOD_TEXT[method]}
    </Badge>
  );
}

const ATTEMPT_TONE: Record<AttemptStatus, { tone: BadgeTone; icon: IconName }> = {
  declared: { tone: "neutral", icon: "compass" },
  underway: { tone: "neutral", icon: "dot" },
  submitted: { tone: "neutral", icon: "send" },
  checking: { tone: "accent", icon: "clock" },
  ready: { tone: "clear", icon: "check" },
  landing: { tone: "clear", icon: "anchor" },
  landed: { tone: "clear", icon: "anchor" },
  stale: { tone: "caution", icon: "range" },
  rederiving: { tone: "caution", icon: "rederive" },
  alternate: { tone: "neutral", icon: "layers" },
  abandoned: { tone: "neutral", icon: "park" },
  failed: { tone: "danger", icon: "cross" },
};

export function AttemptBadge({ status, failing }: { status: AttemptStatus; failing?: boolean }) {
  if (failing && status === "underway") {
    return (
      <Badge tone="danger" icon="cross">
        Tests fail
      </Badge>
    );
  }
  const t = ATTEMPT_TONE[status];
  return (
    <Badge tone={t.tone} icon={t.icon}>
      {ATTEMPT_STATUS_TEXT[status]}
    </Badge>
  );
}

const INTENT_TONE: Record<IntentStatus, { tone: BadgeTone; icon: IconName }> = {
  draft: { tone: "neutral", icon: "amend" },
  open: { tone: "neutral", icon: "ring" },
  underway: { tone: "neutral", icon: "dot" },
  judging: { tone: "caution", icon: "lighthouse" },
  landing: { tone: "clear", icon: "anchor" },
  landed: { tone: "clear", icon: "anchor" },
  parked: { tone: "neutral", icon: "park" },
  "merged-into": { tone: "neutral", icon: "merge" },
};

export function IntentBadge({ status }: { status: IntentStatus }) {
  const t = INTENT_TONE[status];
  return (
    <Badge tone={t.tone} icon={t.icon}>
      {INTENT_STATUS_TEXT[status]}
    </Badge>
  );
}
