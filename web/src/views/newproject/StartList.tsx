/**
 * The first view of a new project: one field to describe the project, then the list of sources.
 * The field says "Describe what you want to build". gitring picks a template, writes the first task and starts a built-in
 * agent; the next step shows each choice. The sources come in this order: Template, Empty, Upload a folder, Push with git,
 * Import from a git URL. The person's GitHub repositories come last, as one import among others: the list when GitHub is
 * connected, else a small "Connect GitHub" link.
 */
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
import { Button } from "../../design/components";
import { Icon } from "../../design/icons";
import { githubConnectUrl } from "../../state/github";
import type { MeWithInstall } from "../../state/account";
import { GithubMark } from "./marks";
import { CONNECT_GITHUB_NOTE, DESCRIBE_HINT, DESCRIBE_LABEL, DESCRIBE_WAIT, SOURCES, type StartKind } from "./start-text";

export type { StartKind } from "./start-text";

interface StartListProps {
  me: MeWithInstall;
  /** The text of the describe field (the draft keeps it). */
  description: string;
  onDescription: (text: string) => void;
  /** The person sends the description: the next step shows gitring's choices. */
  onDescribe: (text: string) => void;
  onPick: (kind: StartKind) => void;
  /** The GitHub repository list (shown when GitHub is connected). */
  github: ReactNode;
  /** Where GitHub sends the person back after "Connect GitHub". */
  returnTo: string;
  autoFocus?: boolean;
}

export function StartList({ me, description, onDescription, onDescribe, onPick, github, returnTo, autoFocus }: StartListProps) {
  const uid = useId().replace(/:/g, "");
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (description.trim()) onDescribe(description.trim());
  };

  // GitHub is optional: the deployment may have no GitHub app, and the person may not connect it.
  const hasGithub = me.providers.github;
  const connected = me.github?.connected !== false;

  return (
    <div className="np-start">
      <form className="np-describe" onSubmit={submit}>
        <label className="np-describe__label" htmlFor={`${uid}-describe`}>
          {DESCRIBE_LABEL}
        </label>
        <div className="np-describe__field">
          <input
            ref={input}
            id={`${uid}-describe`}
            data-autofocus
            className="np-search__input np-describe__input"
            type="text"
            value={description}
            onChange={(e) => onDescription(e.target.value)}
            placeholder="A JSON API for my shop, with tests"
            aria-describedby={`${uid}-describe-wait ${uid}-describe-hint`}
            autoComplete="off"
            enterKeyHint="next"
            maxLength={4000}
          />
          <Button type="submit" variant="primary" iconRight="arrow-right" disabled={!description.trim()} aria-describedby={`${uid}-describe-wait`}>
            Next
          </Button>
        </div>
        <p className="np-describe__wait" id={`${uid}-describe-wait`}>
          {description.trim() ? "" : DESCRIBE_WAIT}
        </p>
        <p className="np-describe__hint" id={`${uid}-describe-hint`}>
          {DESCRIBE_HINT}
        </p>
      </form>

      <div className="np-group" role="group" aria-labelledby={`${uid}-sources`}>
        <div id={`${uid}-sources`} className="np-group__head">
          Or start from
        </div>
        <ul className="np-starts">
          {SOURCES.map((s) => (
            <li key={s.kind}>
              <button type="button" className="np-opt np-start__opt" onClick={() => onPick(s.kind)}>
                <Icon name={s.icon} className="np-opt__icon" />
                <span className="np-opt__main">
                  <span className="np-opt__title">{s.title}</span>
                  <span className="np-opt__text">{s.text}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {hasGithub && (
        <section className="np-group np-start__github" aria-labelledby={`${uid}-gh`}>
          <h3 id={`${uid}-gh`} className="np-group__head">
            <GithubMark size={12} /> Your GitHub repositories
          </h3>
          {connected ? (
            github
          ) : (
            <p className="np-note">
              <a className="np-linkbtn" href={githubConnectUrl(returnTo)}>
                Connect GitHub
              </a>{" "}
              {CONNECT_GITHUB_NOTE}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
