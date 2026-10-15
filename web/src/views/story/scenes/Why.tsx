/**
 * Chapter 07: seven real lines of src/price.js, line 4 chosen, and the merge record that answers why the line is there.
 * Used by Story.tsx. The code and the record are real (example.ts). The record uses the diamond for the count of change requests.
 */
import { EXAMPLE } from "../example";
import { spot } from "../place";
import { Diamond } from "./art";

export function Why() {
  const { why } = EXAMPLE;
  return (
    <>
      <div className="story-plate story-code story-place" {...spot({ x: 438, y: 14 })}>
        <ol className="story-mono">
          {why.code.map((text, index) => (
            <li key={index} data-chosen={index + 1 === why.line ? "" : undefined}>
              <span className="story-code__n" aria-hidden="true">
                {index + 1}
              </span>
              <code>{text}</code>
              {index + 1 === why.line && (
                <span className="story-code__ask" aria-hidden="true">
                  {why.button}
                </span>
              )}
            </li>
          ))}
        </ol>
        <span className="story-leader story-wide" aria-hidden="true" data-at={442} data-reveal="thread" />
      </div>
      <div className="story-plate story-record story-place" {...spot({ x: 430, y: 64, thread: true, at: 444 })}>
        <span className="story-serif story-record__task">{why.task}</span>
        <span className="story-label">{why.who}</span>
        <span className="story-mono">{why.approach}</span>
        <span className="story-record__requests">
          <Diamond size={12} />
          <span>{why.requests}</span>
          <span className="story-label">{why.status}</span>
        </span>
        <span>{why.tests}</span>
      </div>
      <span className="story-mono story-label story-main-label story-wide story-place" {...spot({ x: 452, y: 56, thread: true, at: 452 })}>
        main
      </span>
    </>
  );
}
