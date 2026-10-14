# Planned packs and prices

These are planned prices. gitring charges nobody today and has no payment code. The waitlist only learns which pack people would use. The numbers live in one file, `src/core/plans.ts`. The interest page, the owner page and the tests read it. Change a price there, and then change this page.

Prices were checked on 14 Oct 2026. Cloudflare prices come from developers.cloudflare.com. Competitor prices come from third-party price lists, so check each one before you rely on it.

## The packs

| Pack | Each month | People | Projects | Merges | Container test runs | Built-in agent tokens | Storage |
|---|---|---|---|---|---|---|---|
| Explorer | Free | 3 | 1 | 50 | 50 | 0.5 million | 0.5 GB |
| Builder | $15 | 3 | 5 | 500 | 500 | 5 million | 5 GB |
| Team | $99 | 10 | 25 | 3,000 | 3,000 | 30 million | 25 GB |
| Scale | $399 | 50 | 100 | 15,000 | 15,000 | 150 million | 100 GB |
| Enterprise | From $1,500 | by contract | by contract | by contract | by contract | by contract | by contract |

- Agents are free. Only people count as people.
- Tests in the worker runner (Dynamic Workers) are free. Only a test run in a container counts.
- One token of GLM 5.3 Flash counts as 1. One token of GLM 5.3 counts as 9. One token of a Kimi model counts as 7. A dearer model uses up the pack faster.
- Explorer stops at its limit. It never charges.

### Use above the included amount

| Pack | Each extra merge | Each extra container test run | Each extra million tokens | Each extra GB |
|---|---|---|---|---|
| Builder | $0.02 | $0.015 | $0.60 | $1.50 |
| Team | $0.02 | $0.015 | $0.60 | $1.50 |
| Scale | $0.018 | $0.013 | $0.50 | $1.25 |

Each of these is about 3 times what the unit costs gitring. Enterprise has its own rates.

## What gitring pays Cloudflare

| Service | Price used |
|---|---|
| Workers Paid plan | $5 each month for the whole account. It includes 10 million requests and 30 million CPU milliseconds. Then $0.30 for each million requests and $0.02 for each million CPU milliseconds. |
| Durable Objects | 1 million requests included, then $0.15 per million. 400,000 GB-seconds included, then $12.50 per million GB-seconds. SQLite storage: 50 million rows written included, then $1.00 per million. 5 GB stored included, then $0.20 per GB-month. Rows read cost almost nothing. |
| Artifacts (git storage) | 10,000 operations included, then $0.15 per 1,000. 1 GB included, then $0.50 per GB-month. A third-party report says billing starts on 14 Oct 2026. Check this. |
| Workers AI | $0.011 per 1,000 neurons. GLM 5.3 Flash: $0.15 per million input tokens ($0.03 cached) and $0.50 per million output tokens. GLM 5.3: $1.40 input ($0.26 cached) and $4.40 output. Kimi K2.7 Code: $0.95 input and $4.00 output. |
| Containers | $0.0000025 per GiB-second of memory, $0.00002 per vCPU-second of active CPU and $0.00000007 per GB-second of disk. The `standard-1` size has 4 GiB of memory, half a vCPU and 8 GB of disk. |

The $5 base is shared by all customers. It is not part of the unit costs below.

## What one unit costs gitring

These are estimates from the prices above. Measure them after launch, with the counters that gitring keeps.

- **A merge costs about $0.006.** About 150 Durable Object requests ($0.00002), 600 rows written ($0.0006), 15 Artifacts operations ($0.0023), a little CPU, and the conflict-check model at about 20,000 tokens of GLM 5.3 Flash ($0.003).
- **A container test run costs about $0.005.** Three minutes on `standard-1`: memory $0.0018, CPU at most $0.0018, disk $0.0001, and about $0.001 of storage and requests.
- **A million built-in agent tokens cost about $0.20.** An agent loop is mostly input. With 90 parts input and 10 parts output, GLM 5.3 Flash costs $0.185 for a million tokens without the cache. GLM 5.3 costs $1.70, about 9 times more. This is why a GLM 5.3 token counts as 9.
- **A GB of code and history costs about $0.50 each month.** This is the Artifacts price. Durable Object storage is cheaper ($0.20).

## Margin

A pack costs gitring the most when its person spends all of the included use. The table shows that worst case, and the cost at half use. Half use is more usual.

| Pack | Price | Cost at full use | Margin at full use | Cost at half use | Margin at half use |
|---|---|---|---|---|---|
| Explorer | $0 | $0.90 | a cost of learning | $0.45 | a cost of learning |
| Builder | $15 | $9.00 | 40% | $4.50 | 70% |
| Team | $99 | $51.50 | 48% | $25.75 | 74% |
| Scale | $399 | $245 | 39% | $122.50 | 69% |

A card payment fee of about 3% and $0.30 comes on top. The prices have room for it. The test in `test/core/waitlist.test.ts` fails when a paid pack has less than 50% on top of its cost at full use.

## Competitors

| Product | Price | What it covers |
|---|---|---|
| GitHub Team | $4 for each person each month | Hosting and review. No agent fleet. |
| GitHub Copilot Business | $19 for each person each month | AI help in the editor. Since 1 Jun 2026 it uses credits. |
| GitHub Copilot Pro+ and Enterprise | $39 for each person each month | More credits. Enterprise needs GitHub Enterprise Cloud (about $21 more). |
| GitLab Premium | $29 for each person each month | Hosting, CI and review. |
| Sourcegraph Enterprise | about $49 for each person each month (one source) | Code search. |
| Devin | Reports differ. Older: $20 start and $2.25 for each agent compute unit, and $500 for Team. Newer: Pro $20, Teams $80, Max $200. | One agent that works alone. |

A team of 10 people on GitHub Team and Copilot Business pays $230 each month. The same team on GitLab Premium pays $290. The gitring Team pack costs $99 for 10 people and any number of agents. The pack does not replace those products, but it gives a team a price to compare.

## What counts as use today

gitring keeps counters only. Nothing stops work when a counter passes a limit, and nothing is charged.

- Merges: a landing on main.
- Test runs: a run in a container (the hourly budget of container runs applies as before).
- Agent tokens: the tokens of each model call of a built-in agent, times the weight of the model.

`GET /api/projects/<id>/usage` shows the counters of a project for a month. They live in the Directory, in the table `usage`.

## Before the packs go live

1. Decide the payment service, and add it behind these counters.
2. Decide what happens at a limit: stop, or charge the overage rates.
3. Measure the real unit costs and change `UNIT_COST` in `src/core/plans.ts`.
4. Check the Cloudflare and competitor prices again.
