/**
 * Placeholder for the code view (/code, /code/:ref/<path>). The performance builder writes the real view:
 * a tree of main or a work copy, the file, its diff per work copy, and marks where agents work.
 * The route gives the ref and the path: useRoute() → { name: "code", ref?, path? }; "?view=diff" asks for the diff.
 */
import { EmptyState } from "../design/components";
import { Link, useRoute } from "../app/router";

export function CodeView() {
  const route = useRoute();
  const ref = route.name === "code" ? (route.ref ?? "main") : "main";
  const path = route.name === "code" ? route.path : undefined;
  return (
    <div className="page">
      <h1 className="page__title" tabIndex={-1}>
        Code
      </h1>
      <p className="page__lede">
        <span className="voice-agent">{ref}</span>
        {path ? (
          <>
            {" "}
            · <span className="voice-agent">{path}</span>
          </>
        ) : null}
      </p>
      <EmptyState text="The code view shows the files of main and of each work copy here." action={<Link to="/overview">Open the overview</Link>} />
    </div>
  );
}
