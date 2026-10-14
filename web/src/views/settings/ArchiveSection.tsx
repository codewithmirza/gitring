/**
 * The Archive settings (owners only): take the project out of every list and stop its agents.
 * The button confirms in place. A saved archive reloads the page, so that the socket of the project goes away.
 */
import { InlineConfirm, toast } from "../../design/components";
import { archiveProject } from "../../state/account";

export function ArchiveSection({ projectId, title }: { projectId: string; title: string }) {
  return (
    <section className="st-sec st-danger" aria-labelledby="st-danger">
      <h2 className="page__h2" id="st-danger">
        Archive
      </h2>
      <p className="np__help">The project leaves every list, and agents stop. gitring keeps its repository.</p>
      <div>
        <InlineConfirm
          label="Archive project"
          size="md"
          variant="danger"
          box
          timeout={0}
          consequence={`Archive ${title}? It leaves every list at once.`}
          confirmLabel="Archive"
          onConfirm={async () => {
            try {
              await archiveProject(projectId);
              // A full load: the archived project's socket and state go away.
              location.href = "/projects";
            } catch (e) {
              toast({ tone: "danger", title: "The project was not archived", text: (e as Error).message });
            }
          }}
        />
      </div>
    </section>
  );
}
