# Built-in agents on the Anthropic API: the plan

Status: plan, not built (17 October 2026). Why now: the Workers AI credits are used up (BUILD.md, 15 Oct 2026), so the built-in agents, the guess of the test command and the steward sentences do not run on the live site.

## The short answer

It is a small change or a medium one, not a big migration. You choose which.

- gitring calls a model for four jobs. Two functions in one file call the model: `callClef` and `chat` in `src/platform/ai/models.ts`. Everything else goes through them, so the callers change little.
- **Path A, small (about 1 to 2 days).** Keep the `AI` binding. Send Claude models through Cloudflare AI Gateway, with your Anthropic API key stored on the gateway. Anthropic bills your key. The code already sends every model id that does not start with `@cf/` through the gateway (`isGatewayModel`, `models.ts:80`). The change is mostly configuration, plus three small fixes in `models.ts`.
- **Path B, medium (about 1 week).** Call the Anthropic Messages API from the Worker with `@anthropic-ai/sdk`, behind the same `chat()` function. This gives full control of prompt caching, thinking, JSON output and errors. It needs a new history design in the agent loop (see "The history of an agent" below).
- **The conflict check does not move.** It uses Clef, a Cloudflare decision model with typed questions and probabilities. Anthropic has nothing of that shape. When Clef cannot answer, gitring already uses its fixed rules (`course-check.ts`). Set the default to `"rules"` so that it stops calls that fail.
- **The real change is cost, not code.** A Claude token costs much more than a GLM 5.3 Flash token. The packs and `docs/PRICING.md` must change before agents run for paying people (see "Models and cost").

**Recommendation:** do Path A first. It brings the agents back this week, and the hourly budgets (`AI_AGENTS_PER_HOUR`, `AI_AGENTS_PER_USER_HOUR`) cap the spend. Measure the cost of 10 real agent runs. Move to Path B when the cost without prompt caching is too high, or when the agents need better control. Path B is the better design for the long term.

## What calls a model today

| Job | Where | Model now | Shape | With Claude |
|---|---|---|---|---|
| Conflict check (Clef) | `harbor/master/course-check.ts:148` through `callClef` | `@cf/cloudflare/clef-flash`, `clef` | Typed questions in, probabilities out | Does not move. Fixed rules decide. |
| Built-in agents (Vessel), plan step | `vessel/vessel.ts:192` through `chat` | `@cf/zai-org/glm-5.3-flash`, `glm-5.3` | Chat messages, "JSON only" in the prompt, `reasoning: "high"` | Chat, JSON output |
| Built-in agents (Vessel), work loop | `vessel/vessel.ts:228` through `chat` | same | Chat with 6 tools (OpenAI format), `reasoning: "low"`, up to 30 steps | Tool use |
| Guess of the test command | `platform/ai/guess.ts:15` through `chat` | `glm-5.3-flash` | JSON mode (`response_format`) | JSON output |
| Steward sentence | `harbor/steward.ts:377` through `chat` | `glm-5.3-flash` | One plain sentence, at most 3 each 3 minutes, off by default | Plain text |

There are no embeddings and no Vectorize, so nothing else stays behind. External agents (Claude Code, Cursor, Codex) bring their own model. gitring calls no model for them, except the conflict check on their plans.

## Path A: Claude through AI Gateway, with your key

### Set up (Cloudflare dashboard, no code)

1. In AI Gateway, open the `default` gateway (the code uses the id `default`, `models.ts:179`). Make it an authenticated gateway.
2. Provider Keys: add your Anthropic API key under the alias **`default`**. On the `AI` binding path, AI Gateway uses only the key with the alias `default`. A key under any other alias is not used, and the request goes to Unified Billing instead.
3. Settings: turn on **Require provider credentials** (`byok_only: true`). Without it, a request with no key goes to Unified Billing and uses Cloudflare credits. Those credits are used up, so the request would fail or cost money in the wrong place.

### Code changes

1. `wrangler.jsonc`: set `AGENT_MODELS` to the Claude model ids in the Cloudflare model catalog (the form is `{author}/{model}`, for example `anthropic/claude-opus-5-5`; check the exact ids in the catalog).
2. `src/core/types/settings-defaults.ts`: the same ids in `agentModels`. Set `decisionModel: "rules"`. Set `SHORT_JOB_MODEL` (`models.ts:95`) and `GUESS_MODEL` (`core/guess.ts:266`) to a Claude id.
3. `src/platform/ai/models.ts`, in `chat()` and `modelOptions()`:
   - Send no `temperature` for Claude models. Current Claude models refuse a sampling parameter (HTTP 400). The code sends `temperature` on every call now.
   - Send the effort: `reasoning: "high"` for the plan, `"low"` for routine turns. Check how the gateway passes `reasoning_effort` to Claude (step 4).
   - `contextBudget()` (`models.ts:228`): give Claude models the large budget (1M tokens of context), as GLM 5.3 has now.
   - `max_tokens`: thinking counts toward it. The plan step asks for 1,200 and the work step for 6,000. Give both more room (for example 16,000), or answers stop in the middle.
4. Before you change more, make **one live call** for each shape: plain text, JSON, and a tool call with a tool answer. Check four things: the model id is correct, `reasoning_effort` arrives as effort, tool calls and tool answers come back in the OpenAI shape that `chat()` reads, and `usage` has the token counts.
5. `src/core/plans.ts`: `tokenWeight()` knows only GLM and Kimi. Give each Claude model its weight (see "Models and cost"). Without it, a Claude token counts as 1, the same as GLM 5.3 Flash.
6. Tests that name model ids: `test/harbor/platform.test.ts`, `test/core/waitlist.test.ts` (token weights), `test/github/projects.test.ts`, `test/core/guess.test.ts`, `test/worker/guess-model.test.ts` (it asserts `reasoning_effort` and `temperature`), `test/vessel/models.test.ts`.

### What Path A cannot do

- **Prompt caching.** The OpenAI-shaped request has no `cache_control`. An agent sends its whole history again on each of up to 30 steps, so without the cache each step pays the full input price again. This is the main reason for Path B.
- **Thinking across turns.** Through the OpenAI shape, Claude's thinking does not come back into the history. Each turn thinks again from the visible history. This costs some quality, but it also means that the trim of old turns (below) causes no errors.
- **Refusal fallback and typed errors.** The error comes back as text. The regular expression in `vessel.ts:233` (`/429|rate|capacity|busy|3040|5035/`) must also catch the Claude errors (429, and 529 "overloaded").

## Path B: the Anthropic Messages API directly

Use the official SDK, `@anthropic-ai/sdk`. It uses `fetch`, so it runs in a Worker (`nodejs_compat` is already on). Check the bundle size with `wrangler deploy --dry-run`.

### 1. A Claude provider inside `models.ts`

Keep the signatures of `chat()` and `ChatResult`, so that the callers do not change. Inside, for a Claude model id:

- **System prompt:** the first `system` message becomes the top-level `system` field.
- **Tools:** each `ToolDef` (`{type: "function", function: {name, description, parameters}}`) becomes `{name, description, input_schema}`. Add `strict: true` with `additionalProperties: false` on each schema, so that the arguments always match. Then `safeArgs` (`vessel.ts:489`) needs no loose JSON parse.
- **Tool calls:** an assistant `tool_calls` entry becomes a `tool_use` block (`id`, `name`, `input` as an object, not a string).
- **Tool answers:** the `role: "tool"` messages after one assistant turn become `tool_result` blocks in **one** user message. Several user messages make the model stop parallel calls.
- **`toolChoice`:** use `auto` only. Current Claude models refuse a forced tool (`any` or `tool`) with HTTP 400. The code uses `auto` now, so nothing changes.
- **Effort:** `reasoning` becomes `output_config: {effort}`: `"high"` for the plan, `"low"` for routine turns. Thinking is always on for Claude Opus 5.5. Effort is the control, and its default is `medium`, so always send it.
- **JSON:** the guess (`json: true`) and the plan step become structured output (`output_config.format` with a JSON schema). Then `parseJsonLoose` is only a fallback.
- **No `temperature`**, as in Path A.
- **Usage:** `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` take the place of `prompt_tokens` and `completion_tokens` (`vessel.ts:75`, `countTokens`).
- **Errors:** use the SDK error classes (`Anthropic.RateLimitError`, `Anthropic.APIError` with `status`) in place of the regular expression in `vessel.ts:233`. The SDK retries 429 and 5xx two times by itself. Set `maxRetries` so the retries stay inside the vessel timeouts (150 s and 240 s).
- **Refusal:** `stop_reason: "refusal"` is a normal answer (HTTP 200) with no useful content. Read `stop_reason` before the content, and count a refusal as a failed turn. On Claude Opus 5.5, turn on the server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
- `ANTHROPIC_API_KEY` comes from `env`. Model ids that start with `@cf/` keep the old Workers AI path, so self-hosters with Workers AI credits change nothing.

### 2. The history of an agent (the hard part)

The vessel builds its history itself and keeps it in Durable Object storage (`VesselState.messages`). Two functions change old turns:

- `trimMessages` (`vessel.ts:524`) keeps the brief and the latest 24 messages, and removes turns from the middle.
- `withOpenRequests` (`vessel.ts:542`) puts a "STILL OPEN" message after the brief, in the middle of the history.

With Claude, each assistant turn has `thinking` blocks, and these must go back unchanged on the next call. A thinking block is tied to everything before it. When an earlier turn changes, the API refuses the request with HTTP 400. This applies to every Anthropic account created on or after 31 August 2026. For an older account it applies when you opt in, and you should build for it anyway. It also keeps the prompt cache warm. The replacements:

| Now | With Claude |
|---|---|
| `trimMessages` removes old turns | Server-side context editing (beta `context-management-2025-06-27`, `clear_tool_uses_20250919`) clears old tool results. Or use server-side compaction (beta `compact-2026-01-12`). Neither one counts as a change to the history. |
| `withOpenRequests` puts a message in the middle | Add the open change request as a text block after the `tool_result` blocks of the newest user message. Leave the earlier copies in place. |
| The system prompt and the tools are built for each call | Build them once when the vessel starts, and keep them byte for byte the same. |

`VesselState.messages` then holds Anthropic content blocks (with the thinking blocks), not OpenAI messages. At deploy, a vessel that runs has the old shape. Let those vessels finish on the old path, or stop them and start them again.

### 3. Prompt caching

Put `cache_control: {type: "ephemeral"}` at the top level of each agent call. The tools, the system prompt and the brief are the same on each step, so each step reads them from the cache. Cache reads on Claude Opus 5.5 cost $0.20 per million tokens, against $4 for normal input. Check `usage.cache_read_input_tokens` on the second step of a run. When it is 0, something in the prefix changes on each call.

### 4. Configuration

- `wrangler secret put ANTHROPIC_API_KEY`. Add `ANTHROPIC_API_KEY?: string` to `src/worker/env.ts`, and a line to `.dev.vars.example`.
- The local run (`npm run dev:local`) has no `AI` binding. With the key in `.dev.vars`, built-in agents can run locally for the first time. This makes them easier to test.
- `/api/health` reports `ai: Boolean(env.AI)` (`worker/app.ts:44`). Also report whether a key is set.
- The model ids go in the same places as in Path A, and in the allowlist (`harbor/master/tasks.ts:188`, `harbor/support/settings-rules.ts:31`).

### 5. Tests

The tests stub the binding as `{ run }` and assert the OpenAI shape: `test/vessel/models.test.ts`, `test/vessel/vessel.test.ts`, `test/worker/guess-model.test.ts`, `test/core/guess.test.ts`, `test/harbor/steward.test.ts`, `test/github/projects.test.ts`. Add a stub of the Anthropic client next to them, and keep the old stubs for the `@cf/` path. Add one test that runs a vessel for many steps and checks that each request starts with the same bytes as the request before it. That test protects the history rule above.

## Models and cost (a decision for you)

| Model | Input, per million tokens | Output | Cache read |
|---|---|---|---|
| Claude Opus 5.5 (`claude-opus-5-5`) | $4.00 | $20.00 | $0.20 |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2.00 | $10.00 | $0.20 |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | $0.10 (prompts up to 100K) | $0.50 | |
| Now: GLM 5.3 Flash (Workers AI) | $0.15 | $0.50 | $0.03 |
| Now: GLM 5.3 (Workers AI) | $1.40 | $4.40 | $0.26 |

The default of this plan is Claude Opus 5.5 for the agents. It is the strongest model for agentic coding. The current setup has two tiers: Flash for most work and short jobs, the full model for hard work. Which Claude models fill those tiers is your choice.

With the mix of `docs/PRICING.md` (90 parts input, 10 parts output), a million agent tokens cost about:

- Claude Opus 5.5: $5.60 without the cache, about $2.90 when 80% of the input comes from the cache.
- Claude Sonnet 5.5: $2.80 without the cache, about $1.50 with it.
- Claude Haiku 5.5: about $0.14.
- Now, GLM 5.3 Flash: $0.185.

These are estimates. Thinking tokens count as output, so the output share can be higher than 10 parts. Measure 10 real runs before you set prices. `UNIT_COST.millionTokens` ($0.20, `core/plans.ts:132`) and `tokenWeight()` set what an agent token costs a pack. Both must change, and so must the token numbers of the packs in `docs/PRICING.md`.

## Words that must change

- **Privacy page** (`src/worker/legal.ts:26`): it says that Cloudflare runs the AI models (Workers AI), and that built-in agents send project text to them. With Claude, Anthropic processes that text. Name Anthropic before the first call goes live, and read the text with whoever owns the legal pages.
- `README.md` (lines 9, 74, 80, 93, 175, 267, 707, 711), `docs/SELF-HOST.md` (Workers AI is a requirement there), `docs/PRICING.md`, the note in `BUILD.md:56`, `docs/design/landing-story.md:73`, and the UI words in `web/src/app/TopBar.tsx:146` and `web/src/views/HomeView.tsx:267`.

## Decisions for you

1. Path A first, or straight to Path B.
2. Which Claude model for each tier (agent work, hard work, short jobs).
3. The new pack prices and token numbers.
4. The privacy text.

## Order of work

1. Decide 1 to 4 above.
2. Path A: dashboard set-up, the small code changes, one live call for each shape, then 10 real agent runs with the token counts.
3. Words: the privacy page first, then the other documents.
4. If Path B: the provider in `models.ts`, then the new history in `vessel.ts` with its test, then caching. Check `cache_read_input_tokens` and the cost of 10 runs again.
