/**
 * "Clone" in the code bar (members): a git clone command with a read token for 6 hours.
 * `CloneButton` is the button of a desktop. `ClonePanel` is the panel alone: a phone opens it from the menu of the bar.
 * The token goes in an HTTP header, never in the URL or in .git/config.
 * gitring makes the token only when the person asks for the command (a click), not when the panel opens.
 */
import { useEffect, useState } from "react";
import { Button, CodeBlock, Popover, usePopover } from "../../design/components";
import { Icon } from "../../design/icons";
import { cloneCommand, type CloneCommand } from "../../state/projects";

/** The panel with the command. A parent decides where it grows from (`anchor`) and when it shows (`open`). */
export function ClonePanel({ project, anchor, open, onClose, id }: { project: string; anchor: HTMLElement | null; open: boolean; onClose: () => void; id?: string }) {
  const [data, setData] = useState<CloneCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Another project: its own command.
  useEffect(() => {
    setData(null);
    setError(null);
  }, [project]);

  const take = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await cloneCommand(project));
    } catch (e) {
      setError((e as Error).message || "gitring did not answer. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const until = data ? new Date(data.expiresAt) : null;
  return (
    <Popover id={id} anchor={anchor} open={open} onClose={onClose} label="Clone with git" align="end" width={520}>
      <div className="cv-clone">
        <h2 className="cv-clone__title">Clone with git</h2>
        <p className="cv-clone__text">
          The command has a read token for this project. The token goes in a header, not in the URL, and it works for 6 hours. Keep it private.
        </p>
        {data ? (
          <>
            <CodeBlock shell label="Terminal" code={data.clone} copyLabel="Copy command" />
            <CodeBlock shell label="Later, in the clone" code={data.pull} copyLabel="Copy command" />
            <p className="cv-clone__text">
              The token works until {until && !Number.isNaN(until.getTime()) ? until.toLocaleString() : data.expiresAt}. Then show the command again. Agents
              get the same command with the MCP tool <span className="code-inline">gitring_clone</span>.
            </p>
          </>
        ) : (
          <Button variant="primary" icon="fork" busy={busy} onClick={() => void take()} data-autofocus>
            Show the clone command
          </Button>
        )}
        {error && (
          <p className="cv-clone__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Popover>
  );
}

export function CloneButton({ project }: { project: string }) {
  const pop = usePopover("dialog");
  return (
    <>
      <button {...pop.triggerProps} type="button" className="cv-findbtn cv-clonebtn" title="Clone this project with git">
        <Icon name="fork" size={14} />
        <span className="cv-findbtn__text">Clone</span>
      </button>
      <ClonePanel project={project} {...pop.popoverProps} />
    </>
  );
}
