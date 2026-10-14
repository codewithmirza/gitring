/**
 * One reason of a merge question as text. The names of the changed functions show in the mono voice, as code.
 * Used by the card of the tray, the decisions list and the inbox. The sentence comes from the server: it never changes here.
 */

const PARAMETERS = /^(The parameters of )(.+?)( change\..*)$/;

export function ReasonText({ text }: { text: string }) {
  const match = PARAMETERS.exec(text);
  if (!match) return <>{text}</>;
  const [, lead, list, tail] = match;
  // "a, b, c and 2 more": the names, then the count of the others in plain words.
  const more = /( and \d+ more)$/.exec(list)?.[1] ?? "";
  const names = (more ? list.slice(0, -more.length) : list).split(", ");
  return (
    <>
      {lead}
      {names.map((name, i) => (
        <span key={name}>
          {i > 0 && ", "}
          <code className="code-inline">{name}</code>
        </span>
      ))}
      {more}
      {tail}
    </>
  );
}
