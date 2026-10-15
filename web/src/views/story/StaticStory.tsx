/**
 * The story as plain stacked text: the opening and seven chapters on a spine, with no drawing.
 * StorySection shows it before the story code loads and when that code fails to load. Read Chapter.tsx next.
 */
import { Chapter, Opening } from "./Chapter";
import { CHAPTERS } from "./copy";

export function StaticStory() {
  return (
    <div className="story-canvas">
      <span className="story-spine" aria-hidden="true" />
      <Opening />
      {CHAPTERS.map((chapter, index) => (
        <Chapter key={chapter.id} index={index} />
      ))}
    </div>
  );
}
