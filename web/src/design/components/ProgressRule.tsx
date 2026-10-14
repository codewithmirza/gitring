/** Loading: a hairline progress rule, not a spinner. */
export function ProgressRule({ label = "Please wait" }: { label?: string }) {
  return <div className="b-progress" role="progressbar" aria-label={label} aria-busy="true" />;
}
