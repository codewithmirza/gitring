/** Loading: a hairline progress rule, not a spinner. */
export function ProgressRule({ label = "Loading" }: { label?: string }) {
  return <div className="b-progress" role="progressbar" aria-label={label} aria-busy="true" />;
}
