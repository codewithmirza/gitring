/**
 * The Merging section of the settings: who says yes, rules by folder, and work that cannot merge.
 * Only an owner changes it. The words come from ../approval-copy.ts.
 */
import { useEffect, useState } from "react";
import { Button, Checkbox, Field, Input, Select } from "../../design/components";
import type { MemberInfo } from "../../../../src/core/accounts";
import type { ApproverRule, FolderRule, LandingMode, Person, RedoPolicy } from "../../../../src/core/types";
import { MAX_FOLDER_RULES } from "../../../../src/core/coord/folder-rules";
import {
  APPROVER_CHOICES,
  APPROVER_LEGEND,
  FOLDER_RULES_HELP,
  FOLDER_RULES_LEGEND,
  FOLDER_RULE_CHOICES,
  LANDING_CHOICES,
  LANDING_LEGEND,
  approverOf,
  folderRulesOf,
  landingOf,
  type FolderRuleKind,
} from "../approval-copy";
import { ChoiceList } from "../ChoiceList";
import { TRAIN_HELP, parseMaxTrain } from "../trains-copy";
import { STEWARD_LABEL, stewardHelp } from "../steward-copy";
import { SaveError, type SectionProps, useSave } from "./shared";

/* ───────────── words and rule rows ───────────── */

const REDO_OPTIONS: { value: RedoPolicy; label: string }[] = [
  { value: "agent-first", label: "Give it back to the same agent first, then to a built-in agent" },
  { value: "agent-only", label: "Give it back to the same agent only" },
  { value: "builtin", label: "A built-in agent does it again" },
];

const REDO_HELP: Record<RedoPolicy, string> = {
  "agent-first": "The same agent gets the work back. If it does not answer in the wait time, a built-in agent does the task again.",
  "agent-only": "The same agent gets the work back. If it does not answer, a person decides.",
  builtin: "A built-in agent does the task again at once. The work of built-in agents always goes back to a built-in agent.",
};

/** One rule by folder as the form edits it (`key` keeps the row stable while the list changes). */
interface RuleRow {
  key: string;
  pattern: string;
  kind: FolderRuleKind;
  members: Person[];
}

let ruleSeq = 0;
const newRuleRow = (r?: FolderRule): RuleRow => ({ key: `r${++ruleSeq}`, pattern: r?.pattern ?? "", kind: r?.rule ?? "owner-yes", members: r?.rule === "members" ? r.members : [] });
const ruleOf = (r: RuleRow): FolderRule => (r.kind === "members" ? { pattern: r.pattern.trim(), rule: "members", members: r.members } : { pattern: r.pattern.trim(), rule: r.kind });

/* ───────────── the section ───────────── */

export function MergingSection({ projectId, owner, settings, onSaved, members }: SectionProps & { members: MemberInfo[] | null }) {
  // A server from before `landing` sends only `autoLand`; a server from before `approver` sends neither.
  const savedLanding = landingOf(settings);
  const savedApprover = approverOf(settings);
  const savedRules = JSON.stringify(folderRulesOf(settings));
  const [landing, setLanding] = useState<LandingMode>(savedLanding);
  const [approver, setApprover] = useState<ApproverRule>(savedApprover);
  const [intentsInRepo, setIntentsInRepo] = useState(settings.intentsInRepo);
  // A server from before the steward sends no `steward`: off.
  const savedSteward = Boolean(settings.steward);
  const [steward, setSteward] = useState(savedSteward);
  const [redo, setRedo] = useState<RedoPolicy>(settings.redo ?? "agent-first");
  const [wait, setWait] = useState(String(settings.redoWaitMinutes ?? 15));
  const [rules, setRules] = useState<RuleRow[]>(() => folderRulesOf(settings).map((r) => newRuleRow(r)));
  const [tried, setTried] = useState(false);
  const [train, setTrain] = useState(String(settings.maxTrain ?? 8));
  const { busy, error, setError, save } = useSave(projectId, onSaved);

  // Reset the form only when these values change on the server (a save in another section keeps this draft).
  useEffect(() => {
    setLanding(savedLanding);
    setApprover(savedApprover);
    setIntentsInRepo(settings.intentsInRepo);
    setSteward(savedSteward);
    setRedo(settings.redo ?? "agent-first");
    setWait(String(settings.redoWaitMinutes ?? 15));
    setTrain(String(settings.maxTrain ?? 8));
    setRules(folderRulesOf(settings).map((r) => newRuleRow(r)));
    setTried(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedLanding, savedApprover, settings.intentsInRepo, savedSteward, settings.redo, settings.redoWaitMinutes, settings.maxTrain, savedRules]);

  const change = (key: string, patch: Partial<RuleRow>) => setRules((l) => l.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const badRule = (r: RuleRow) => !r.pattern.trim() || (r.kind === "members" && !r.members.length);
  // The people a "members" rule can name: members and owners who signed in once (a pending invite has no account yet).
  const people: Person[] = (members ?? []).filter((m) => m.userId && !m.pending && m.role !== "viewer").map((m) => ({ id: m.userId!, name: m.name }));
  const dirty =
    landing !== savedLanding ||
    approver !== savedApprover ||
    intentsInRepo !== settings.intentsInRepo ||
    steward !== savedSteward ||
    redo !== (settings.redo ?? "agent-first") ||
    train !== String(settings.maxTrain ?? 8) ||
    (redo === "agent-first" && wait !== String(settings.redoWaitMinutes ?? 15)) ||
    JSON.stringify(rules.map(ruleOf)) !== savedRules;
  const submit = () => {
    const minutes = Number(wait);
    if (redo === "agent-first" && (!Number.isInteger(minutes) || minutes < 5 || minutes > 120)) {
      setError("Give a wait time from 5 to 120 minutes.");
      return;
    }
    const maxTrain = parseMaxTrain(train);
    if (maxTrain === undefined) {
      setError("Give a train size from 1 to 16.");
      return;
    }
    setTried(true);
    if (rules.some(badRule)) {
      setError("Each rule needs a pattern. A rule for members needs at least one member.");
      return;
    }
    // `landing` replaces the old `autoLand`: the server keeps `autoLand` equal to it, so the form never writes `autoLand`.
    void save({ landing, approver, intentsInRepo, steward, redo, maxTrain, ...(redo === "agent-first" ? { redoWaitMinutes: minutes } : {}), folderRules: rules.map(ruleOf) }, "Merge settings saved");
  };

  return (
    <section className="st-sec" aria-labelledby="st-merging">
      <h2 className="page__h2" id="st-merging">
        Merging
      </h2>
      <ChoiceList legend={LANDING_LEGEND} choices={LANDING_CHOICES} value={landing} onChange={setLanding} disabled={!owner} />
      <ChoiceList legend={APPROVER_LEGEND} choices={APPROVER_CHOICES} value={approver} onChange={setApprover} disabled={!owner} />
      <fieldset className="st-rules" disabled={!owner}>
        <legend className="b-field__label st-choice__legend">{FOLDER_RULES_LEGEND}</legend>
        <p className="np__help">{FOLDER_RULES_HELP}</p>
        {rules.length === 0 && <p className="np__help">No rules yet: the choices above decide for every folder.</p>}
        <ul className="st-rules__list">
          {rules.map((r, i) => (
            <li key={r.key} className="st-rule">
              <div className="st-row">
                <Field label={`Rule ${i + 1}: folder or pattern`} error={tried && !r.pattern.trim() ? "Give a folder or a pattern, for example migrations/**." : undefined}>
                  <Input className="voice-agent" value={r.pattern} onChange={(e) => change(r.key, { pattern: e.target.value })} placeholder="migrations/**" autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Who says yes" help={FOLDER_RULE_CHOICES.find((c) => c.value === r.kind)?.help}>
                  <Select value={r.kind} onChange={(e) => change(r.key, { kind: e.target.value as FolderRuleKind })}>
                    {FOLDER_RULE_CHOICES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {r.kind === "members" && (
                <fieldset className="st-hook__events">
                  <legend className="b-field__label">Members</legend>
                  {people.length === 0 && <span className="np__help">No member has signed in yet.</span>}
                  {people.map((m) => (
                    <Checkbox
                      key={m.id}
                      label={m.name}
                      checked={r.members.some((x) => x.id === m.id)}
                      onChange={(e) => change(r.key, { members: e.target.checked ? [...r.members.filter((x) => x.id !== m.id), m] : r.members.filter((x) => x.id !== m.id) })}
                    />
                  ))}
                  {tried && !r.members.length && <span className="st-error">Choose at least one member.</span>}
                </fieldset>
              )}
              {owner && (
                <div className="st-actions">
                  <Button size="sm" variant="ghost" icon="close" onClick={() => setRules((l) => l.filter((x) => x.key !== r.key))}>
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {owner && (
          <div className="st-actions">
            <Button size="sm" icon="plus" disabled={rules.length >= MAX_FOLDER_RULES} onClick={() => setRules((l) => [...l, newRuleRow()])} title={rules.length >= MAX_FOLDER_RULES ? `At most ${MAX_FOLDER_RULES} rules.` : undefined}>
              Add a rule
            </Button>
          </div>
        )}
      </fieldset>
      <div className="st-checks">
        <Checkbox
          label={
            <>
              Write a task file into the repository on each merge (<span className="voice-agent">.gitring/intents/…</span>)
            </>
          }
          checked={intentsInRepo}
          disabled={!owner}
          onChange={(e) => setIntentsInRepo(e.target.checked)}
        />
        <Checkbox label={STEWARD_LABEL} checked={steward} disabled={!owner} onChange={(e) => setSteward(e.target.checked)} />
        <p className="np__help">{stewardHelp(steward)}</p>
      </div>
      <div className="st-row">
        <Field label="When the work of an outside agent cannot merge" help={REDO_HELP[redo]}>
          <Select value={redo} disabled={!owner} onChange={(e) => setRedo(e.target.value as RedoPolicy)}>
            {REDO_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {redo === "agent-first" && (
          <Field label="Wait time (minutes)" help="5 to 120.">
            <Input type="number" min={5} max={120} step={1} inputMode="numeric" value={wait} disabled={!owner} onChange={(e) => setWait(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="st-row">
        <Field label="Largest train (work copies)" help={TRAIN_HELP}>
          <Input type="number" min={1} max={16} step={1} inputMode="numeric" value={train} disabled={!owner} onChange={(e) => setTrain(e.target.value)} />
        </Field>
      </div>
      {owner && (
        <div>
          <Button busy={busy} disabled={!dirty} onClick={submit}>
            Save merge settings
          </Button>
        </div>
      )}
      <SaveError error={error} />
    </section>
  );
}
