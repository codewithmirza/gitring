/**
 * The General settings: the name, who can see the project, and the repository (its id, branch and git address).
 * The repository part names the host of main, because Settings is the page that needs it.
 */
import { useEffect, useState } from "react";
import { Button, CodeBlock, Field, Input, Segmented } from "../../design/components";
import type { Visibility } from "../../../../src/core/accounts";
import { loadProjects, updateProject } from "../../state/account";
import { type RunSave } from "./shared";

interface Props {
  projectId: string;
  owner: boolean;
  title: string;
  visibility: Visibility;
  branch: string;
  remote: string | undefined;
  busy: string | null;
  run: RunSave;
}

export function GeneralSection({ projectId, owner, title, visibility, branch, remote, busy, run }: Props) {
  const [name, setName] = useState(title);
  useEffect(() => setName(title), [title]);
  return (
    <>
      <section className="st-sec" aria-labelledby="st-general">
        <h2 className="page__h2" id="st-general">
          General
        </h2>
        <div className="st-row">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!owner} maxLength={80} />
          </Field>
          {owner && (
            <Button
              busy={busy === "name"}
              disabled={!name.trim() || name.trim() === title}
              onClick={() => void run("name", () => updateProject(projectId, { name: name.trim() }).then(() => loadProjects()), "Name saved")}
            >
              Save name
            </Button>
          )}
        </div>
        <Segmented<Visibility>
          label="Who can see it"
          value={visibility}
          disabled={!owner}
          onChange={(v) => owner && v !== visibility && void run("vis", () => updateProject(projectId, { visibility: v }).then(() => loadProjects()), v === "public" ? "The project is public" : "The project is private")}
          options={[
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
        />
        <p className="np__help">{visibility === "private" ? "Only members see this project." : "Anyone with the link can view it. Only members can change it."}</p>
      </section>

      <section className="st-sec" aria-labelledby="st-repo">
        <h2 className="page__h2" id="st-repo">
          Repository
        </h2>
        <p className="np__help">gitring keeps the main repository of the project. Only gitring writes its main branch. Agents and people merge work through tasks.</p>
        <dl className="st-facts">
          <div>
            <dt>Project id</dt>
            <dd className="voice-agent">{projectId}</dd>
          </div>
          <div>
            <dt>Main branch</dt>
            <dd className="voice-agent">{branch}</dd>
          </div>
        </dl>
        {remote && <CodeBlock label="Git address of main" code={remote} copyLabel="Copy address" />}
      </section>
    </>
  );
}
