/**
 * What the code view shows: the address, the project data from the store, the ref on screen, and its loaded tree and diff.
 * The first hook of the model. It reads the store and the network; the hooks after it read its result.
 */
import { useMemo, useState } from "react";
import { useNow } from "../../../app/useNow";
import { useStore } from "../../../state/store";
import { useCanAct } from "../../../state/account";
import { selectLastMerges, selectMarks, selectWorkCopies } from "../annotations";
import { resolveRef, useAttemptDiff, useHarbor, useTree } from "../data";
import { useCodeLocation } from "../links";
import { useNarrow } from "./browser";
import { NO_ATTEMPTS, NO_FILES, NO_LANDINGS, NO_LAST, NO_MARKS, NO_WC } from "./empty";

export function useCodeSource() {
  const loc = useCodeLocation();
  const client = useHarbor();
  const now = useNow(30_000);
  const narrow = useNarrow();
  const canAct = useCanAct();

  const projectId = useStore((s) => s.projectId);
  const projectName = useStore((s) => s.state?.project.name ?? "the project");
  const mainSha = useStore((s) => s.state?.project.mainSha ?? "");
  const mainFiles = useStore((s) => s.state?.files ?? NO_FILES);
  const importing = useStore((s) => s.state?.project.importing ?? null);
  const github = useStore((s) => s.state?.project.settings?.github ?? null);
  const attempts = useStore((s) => s.state?.attempts ?? NO_ATTEMPTS);
  const landings = useStore((s) => s.state?.landings ?? NO_LANDINGS);
  const intents = useStore((s) => s.state?.intents);
  const workCopies = useStore((s) => (s.state ? selectWorkCopies(s.state) : NO_WC));
  const marks = useStore((s) => (s.state ? selectMarks(s.state) : NO_MARKS));
  const lastMerges = useStore((s) => (s.state ? selectLastMerges(s.state) : NO_LAST));

  const info = useMemo(() => resolveRef(loc.ref, mainSha, attempts, workCopies), [loc.ref, mainSha, attempts, workCopies]);
  const isWork = info.kind === "work";
  const diffMode = isWork && loc.view === "diff";
  const path = loc.path;

  const [retry, setRetry] = useState(0);
  const tree = useTree(client, info, mainFiles, retry);
  const treeData = tree.data;
  const workVersion = isWork ? info.wc.updatedAt : 0;
  const diff = useAttemptDiff(client, isWork ? info.ref : null, workVersion, retry);
  const diffFiles = diff?.status === "ready" ? diff.data.files : diff?.data?.files;
  const ownByPath = useMemo(() => new Map((diffFiles ?? []).map((f) => [f.path, f])), [diffFiles]);

  /* ── the commit of a merge (from History links) ── */
  const mergeOfCommit = useMemo(() => (info.kind === "commit" || info.kind === "main" ? landings.find((l) => l.mainAfter === info.sha) : undefined), [info, landings]);
  const commitChanged = useMemo(() => {
    if (!mergeOfCommit) return null;
    const a = attempts.find((x) => x.id === mergeOfCommit.attemptId);
    return a ? a.footprint?.files ?? {} : null;
  }, [mergeOfCommit, attempts]);

  return {
    loc, client, now, narrow, canAct, projectId, projectName, mainSha, mainFiles, importing, github, landings, intents, workCopies,
    marks, lastMerges, info, diffMode, path, retry, setRetry, tree, treeData, diff, diffFiles, ownByPath, mergeOfCommit,
    commitChanged,
  };
}

export type CodeSource = ReturnType<typeof useCodeSource>;
