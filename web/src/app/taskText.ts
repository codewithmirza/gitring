/** Task text helpers (no DOM, no React). */

/**
 * The title is the first line. A pasted text with many lines gives the title from its first line and the
 * goal from the rest. Without a title, the first line of the goal becomes the title.
 */
export function splitTask(title: string, goal: string): { title: string; goal: string } {
  let t = title.replace(/\r/g, "");
  let g = goal.replace(/\r/g, "").trim();
  if (t.includes("\n")) {
    const [first, ...rest] = t.split("\n");
    t = first;
    g = [rest.join("\n").trim(), g].filter(Boolean).join("\n\n");
  }
  t = t.trim();
  if (!t && g) {
    const line = g.split("\n")[0].trim();
    const sentence = /^(.{8,120}?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
    t = sentence.length > 120 ? `${sentence.slice(0, 117).trimEnd()}…` : sentence;
  }
  return { title: t.slice(0, 140), goal: g || t };
}
