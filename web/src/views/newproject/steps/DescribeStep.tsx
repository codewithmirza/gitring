/**
 * The step for "Describe what you want to build": a template, the first task and the number of built-in agents.
 */
import { useId, useState, type FormEvent } from "react";
import type { Visibility } from "../../../../../src/core/accounts";
import { pickTemplate, TEMPLATES, type TemplateId } from "../../../../../src/core/templates";
import { Segmented } from "../../../design/components";
import { openProject } from "../../../state/account";
import { RequestError } from "../../../state/github";
import { createProjectFrom } from "../../../state/projects";
import type { SourceStep } from "../draft";
import { nameFromDescription } from "../match";
import { agentsHint } from "../start-text";
import { createProblem, Problem, Quiet, Row, StepHead, type StepProps, Submit, TEMPLATE_OPTIONS, toError, useFirstField, VisibilityRow } from "./shared";

const AGENT_OPTIONS = ["0", "1", "2", "3", "4"].map((n) => ({ value: n, label: n === "0" ? "None" : n }));

export function DescribeStep({ step, form, setForm, onBack, onStep, returnTo }: StepProps & { step: Extract<SourceStep, { kind: "describe" }> }) {
  const uid = useId().replace(/:/g, "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const first = useFirstField();
  const description = form.description ?? step.text;
  const picked = pickTemplate(description);
  const v = {
    name: form.name ?? (nameFromDescription(description) || "New project"),
    template: (form.template as TemplateId | undefined) ?? picked,
    agents: form.agents ?? 1,
    visibility: form.visibility ?? ("private" as Visibility),
  };
  const empty = !description.trim();
  const summary = TEMPLATES.find((t) => t.id === v.template)?.summary ?? "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || empty) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProjectFrom({
        name: v.name.trim() || "New project",
        visibility: v.visibility,
        source: { kind: "template", template: v.template },
        firstTask: { goal: description.trim() },
        launch: v.agents,
      });
      openProject(project.id);
    } catch (err) {
      setError(toError(err));
      setBusy(false);
    }
  };

  const problem = error ? createProblem(error, returnTo, onStep) : null;
  return (
    <form className="np-step" onSubmit={submit} noValidate>
      <StepHead title="Describe it" onBack={onBack} />
      <div className="np-rows">
        <Row id={`${uid}-what`} label="What to build" hint="This text is the goal of the first task.">
          <textarea
            id={`${uid}-what`}
            className="np-in np-in--area"
            value={description}
            onChange={(e) => setForm({ description: e.target.value })}
            aria-describedby={`${uid}-what-hint`}
            rows={3}
            maxLength={4000}
          />
        </Row>
        <Row id={`${uid}-name`} label="Name">
          <Quiet id={`${uid}-name`} value={v.name} onChange={(name) => setForm({ name })} maxLength={80} inputRef={first} />
        </Row>
        <div className="np-row">
          <span className="np-row__label">
            Template
            {form.template === undefined && <span className="np-tag np-tag--guess">guess</span>}
          </span>
          <div className="np-row__value">
            <Segmented<TemplateId> label="Template" value={v.template} onChange={(template) => setForm({ template })} options={TEMPLATE_OPTIONS} />
            <span className="np-row__hint">{summary}</span>
          </div>
        </div>
        <div className="np-row">
          <span className="np-row__label">Agents</span>
          <div className="np-row__value">
            <Segmented<string> label="Built-in agents" value={String(v.agents)} onChange={(n) => setForm({ agents: Number(n) })} options={AGENT_OPTIONS} />
            <span className="np-row__hint">{agentsHint(v.agents)}</span>
          </div>
        </div>
        <VisibilityRow value={v.visibility} onChange={(visibility) => setForm({ visibility })} />
      </div>
      {problem && <Problem actions={problem.actions}>{problem.text}</Problem>}
      <Submit busy={busy} label={busy ? "Please wait…" : "Create project"} disabled={empty} why={empty ? "Describe the project first." : undefined} />
    </form>
  );
}
