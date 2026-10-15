/**
 * The pinned story. It is a separate chunk: StorySection loads it when the section is near the visible part.
 */
import type { RefObject } from "react";
import { StaticStory } from "./StaticStory";

export default function Story(_props: { section: RefObject<HTMLElement | null> }) {
  return <StaticStory />;
}
