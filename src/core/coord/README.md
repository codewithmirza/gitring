# src/core/coord

The conflict check and what comes out of it. Given one plan and the near work of other agents, this folder finds the pairs that may collide, assesses each pair, decides who adapts and writes the change request. It also holds the rules by folder.

`index.ts` re-exports the conflict-check files. Import from `../coord`. `folder-rules.ts` is imported directly.

| File | What it is for |
|---|---|
| `index.ts` | The front door: it re-exports `facts`, `rules`, `clef`, `policy` and `corrections`. |
| `facts.ts` | Steps 2 and 4 of the check: picks the near work (candidates) and writes the exact facts of each pair. |
| `rules.ts` | The rules of the road (who gives way) and the offline assessment that uses fixed numbers. Also the fallback of the model. |
| `clef.ts` | Builds the request to the conflict-check model (Clef) and reads its answer. A missing answer falls back to the rules. |
| `clef-brief.ts` | A shorter request for the same model: a few plain lines for each work copy. It reads back with `clef.ts`. |
| `policy.ts` | Turns the assessments into one verdict with the thresholds of the project: clear, correct, merge tasks, or escalate. |
| `corrections.ts` | Writes the change request from the facts, in short imperative sentences, with the same content in machine form. |
| `folder-rules.ts` | Rules by folder: who says yes to a change in a folder, and which agents may change it at all. |

## The order of the steps

1. `facts.ts` picks the candidates and writes the facts.
2. `rules.ts` gives a first assessment. `clef.ts` asks the model and falls back to the rules when it must.
3. `policy.ts` decides the verdict.
4. `corrections.ts` writes the change request for each pair that needs one.

The facts are exact. The model never replaces them. See the section "Ideas in this folder" in `../README.md` for the full story.
