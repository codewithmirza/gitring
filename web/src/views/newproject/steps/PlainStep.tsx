/**
 * The steps for "git push" and "empty project": nothing to guess, only the name and the visibility.
 */
import { useId, useState, type FormEvent } from "react";
import type { Visibility } from "../../../../../src/core/accounts";
import type { ProjectSource } from "../../../../../src/core/types";
import { openProject } from "../../../state/account";
import { RequestError } from "../../../state/github";
import { createProjectFrom } from "../../../state/projects";
import { createProblem, Problem, Quiet, Row, StepHead, type StepProps, Submit, toError, useFirstField, VisibilityRow } from "./shared";

const PLAIN: Record<"push" | "empty", { title: string; text: string; source: ProjectSource }> = {
  push: {
    title: "Push with git",
    text: "gitring makes an empty repository. Then you push your repository to it with git: any repository from any host, with its history. The overview shows the command.",
    source: { kind: "push" },
  },
  empty: {
    title: "Empty project",
    text: "gitring makes a repository with a README, an AGENTS.md and a .gitignore. Write a task, and agents write the first files and tests.",
    source: { kind: "template", template: "empty" },
  },
};

export function PlainStep({ kind, form, setForm, onBack, onStep, returnTo }: StepProps & { kind: "push" | "empty" }) {
  const uid = useId().replace(/:/g, "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const first = useFirstField();
  const d = PLAIN[kind];
  const v = { name: form.name ?? "New project", visibility: form.visibility ?? ("private" as Visibility) };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProjectFrom({ name: v.name.trim() || "New project", visibility: v.visibility, source: d.source });
      openProject(project.id);
    } catch (err) {
      setError(toError(err));
      setBusy(false);
    }
  };

  const problem = error ? createProblem(error, returnTo, onStep) : null;
  return (
    <form className="np-step" onSubmit={submit} noValidate>
      <StepHead title={d.title} onBack={onBack} />
      <p className="np-step__note">{d.text}</p>
      <div className="np-rows">
        <Row id={`${uid}-name`} label="Name">
          <Quiet id={`${uid}-name`} value={v.name} onChange={(name) => setForm({ name })} maxLength={80} inputRef={first} placeholder="New project" />
        </Row>
        <VisibilityRow value={v.visibility} onChange={(visibility) => setForm({ visibility })} />
      </div>
      {problem && <Problem actions={problem.actions}>{problem.text}</Problem>}
      <Submit busy={busy} label={busy ? "Please wait…" : "Create project"} />
    </form>
  );
}
