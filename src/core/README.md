# src/core

The pure logic of gitring. Nothing here touches a Worker, a Durable Object, storage or the network. Each function takes data in and gives data out. The project coordinator (`src/harbor/`), the Worker (`src/worker/`) and the web app all import these files, so a person and an agent see the same rules in the same words. This is also why the tests of this folder are fast.

Read `docs/CODE-STYLE.md` first. It lists the plain names (task, work copy, plan, change request, merge) and the code names that stay in the stored data (intent, attempt, course, correction, landing).

## Folders

| Folder | What it is for |
|---|---|
| `types/` | The domain types, one file for each domain. `types.ts` is the front door. |
| `analysis/` | Reading code: symbols, the import graph, the distance between two plans, the real changes of a work copy. |
| `coord/` | The conflict check: facts, rules of the road, the model, the policy and the change requests. Also the rules by folder. |
| `git/` | Git objects, snapshots of a tree and commits that cost the size of the change. |
| `land/` | Composing work onto main: the merge ladder, what a merge carries, and trains of independent work. |
| `text/` | The line diff and the 3-way merge. |

## Files

| File | What it is for |
|---|---|
| `types.ts` | The front door of the domain types. It re-exports every file of `types/`. |
| `accounts.ts` | Roles, projects, people and access: the types and small helpers that the Worker, the registry and the web app share. |
| `approvals.ts` | The rules for "a person must say yes before this work merges": when to ask, who may answer, what to say. |
| `guess.ts` | Guesses how a repository installs and tests itself, from its lockfiles, manifests and scripts. |
| `history.ts` | The answers to "why is this line here": line blame, the changes of a file, a search of main, and a compare of two versions. |
| `inbox.ts` | The inbox of a person: everything that waits for them in the projects where they may act. |
| `logbook.ts` | The why-record of each merge: the commit message, the git note and the optional task file in the repository. |
| `plans.ts` | The planned paid packs and their prices, for the waitlist page and the admin view. It has nothing to do with the plan of an agent. |
| `repo-rules.ts` | Rules for code that comes from outside: which remotes gitring imports, and which files it reads as text. |
| `templates.ts` | The starter templates of a new project, each with tests for the gitring test runner. |
| `timeline.ts` | The whole history of a project as one ordered list, in pages. The replay reads it. |
| `waitlist.ts` | The waitlist gate: who may use this gitring, and the record of interest that each waiting person leaves. |

## Ideas in this folder

### The conflict check

An agent sends a plan before it writes code. A plan names the files and the symbols that the agent will change, and the symbols that it will only call. gitring compares this plan with the plans and the real changes of the other work copies. It does not refuse the plan. If two agents are about to collide, gitring sends a change request to the one that must adapt. The agent keeps its work and continues.

gitring runs the check when an agent declares a plan, logs, writes or pushes, when main moves, and when a task changes. The steps are these.

1. **Measure the distance.** gitring gives each other work copy a distance from 0 to 5 (`analysis/range.ts`).
   - 0: the same lines, or a symbol that both change.
   - 1: one side changes a symbol (or its signature) that the other side uses.
   - 2: the same file, other lines and other symbols.
   - 3: two files that are one import apart.
   - 4: two files that are two imports apart.
   - 5: no link.

   The symbol reader (`analysis/symbols.ts`) finds the symbols. The import graph (`analysis/graph.ts`) counts the import steps. The real changes (`analysis/footprint.ts`) add the lines, the signature changes and the uses that a plan cannot know yet.
2. **Pick the candidates.** Only near work goes on (`coord/facts.ts`). A work copy is a candidate when its distance is 3 or less, or when the distance fell since the last check (the two are closing in). The list has at most 20. Work of the same agent and work on the same task are not candidates. The work copies of one task are alternatives, not traffic.
3. **Write the facts.** For each candidate pair gitring writes plain facts: the shared files, the shared symbols, the interface hits, the overlapping lines, the distance, and how much the two task titles look alike. The facts are exact. No model is involved. Every other step reads them.
4. **Assess each pair.** Two sources give the same answer shape: the chance of a collision, the level of interference (0 none, 4 contradictory), the chance that the two tasks are duplicates, and the side that adapts.
   - The rules (`coord/rules.ts`) use fixed numbers for each distance and each fact. They work offline. They are also the fallback.
   - The conflict-check model (`coord/clef.ts`, `coord/clef-brief.ts`) reads the facts and answers with a probability for each choice. If the call fails, or an answer is missing, the rules answer. The setting `decisionModel` picks the model, or only the rules. gitring does not call the model when the call cannot change the verdict (`modelCannotChangeVerdict`).
5. **Decide who adapts.** Six rules of the road decide, in this order: landed work has the right of way (R1); work that waits to merge stands on against active work (R2); the side that changes an interface stands on (R3); a task with high priority stands on (R5); the plan that was declared first stands on (R4); the smaller change adapts (R6). The model may pick a side. R1 and R2 always win, and every choice names a rule.
6. **Apply the policy.** `coord/policy.ts` turns the assessments into one verdict with the thresholds of the project.
   - `clear`: no pair needs a change.
   - `correct`: send change requests to the side that adapts.
   - `merge-intents`: the task is a duplicate of another task.
   - `escalate`: the model is not sure and the risk is high, so a person decides. Both agents continue while they wait.
7. **Write the change request.** `coord/corrections.ts` writes the text from the facts, in short imperative sentences that end with "Continue your work." The same content also goes out in machine form: the lines to avoid and the signatures to use.

The facts are exact and a person can check them. The model adds judgement on top of the facts and never replaces them.

### Merging without surprise

Work joins main one piece at a time (`land/`). gitring tries the cheapest way first: a fast-forward, then a 3-way merge of each file (`text/merge3.ts`), and when that fails, a redo on the new main. Several independent work copies can merge in one train that is tested once (`land/train.ts`). Every merge writes its why-record (`logbook.ts`).
