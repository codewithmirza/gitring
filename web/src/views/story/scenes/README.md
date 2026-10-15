# views/story/scenes

One file for each chapter of the story: the drawing that stands under its text. Each scene is a few parts placed on the canvas (`../place.ts`), and in the stacked layout the same parts become plain rows. The strings in the plates are real output of the product (`../example.ts`).

- `art.tsx`: the small drawings (diamond, hull, node glyph, gate mark, join dot), built from the design system.
- `Start.tsx`: chapter 01. A sentence, a template and one tool call join the first point of main.
- `Connect.tsx`: chapter 02. One URL, and three hulls on main named by the apps.
- `Plans.tsx`: chapter 03. Two agents leave main on dashed plan lines, with a note for each plan.
- `Compare.tsx`: chapter 04. The parcel, the distance line, the diamond and the real change request.
- `Merge.tsx`: chapter 05. Test gates, and the two merges, one after the other.
- `Ask.tsx`: chapter 06. The gate, the real question and the three places to answer.
- `Why.tsx`: chapter 07. The real lines of code, line 4 chosen, and its merge record.
