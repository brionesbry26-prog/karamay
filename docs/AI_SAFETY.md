# AI safety design

## Layers

1. **Deterministic risk check** (`src/safety/crisis.ts`). This runs on every chat message before anything else. It uses English, Filipino and Taglish patterns, normalises text (accents, repeated letters, curly quotes), and excludes idioms ("patay na patay ako sa kanya", "I could kill for a coffee", "die laughing").
   - **urgent** (explicit intent, or ideation plus immediacy or means words): a fixed template reply in the user's language is returned **without calling the AI**. It does not consume quota and works while the AI is off, paused, over budget or over quota.
   - **concern** (ideation, self-harm or abuse without immediacy): the AI is called with an added safety instruction, and the response carries `showResources: true`. If the AI is unavailable, over quota or over budget, the template is returned instead.
2. **System instructions** (`src/ai/prompts.ts`). These make the model:
   - not a therapist; no diagnosis
   - honest about its limits; no claims of confidentiality, monitoring or having contacted anyone
   - encouraging of trusted people over dependence or isolation
   - respectful of stopping or changing topic
   - mirroring the user's language mix and following the mode rules
   - restricted to only the verified hotlines
3. **Provider safety filters.** Gemini safety settings are `BLOCK_MEDIUM_AND_ABOVE` for harassment, hate, sexual and dangerous content. A blocked prompt or response becomes a gentle fallback (or the safety template for concern-level messages).
4. **Always-available resources.** These are static in `index.html` (they work without JavaScript), in the footer of every page, in `/api/crisis-resources` (no session or quota needed), and exempt from abuse cooldowns.

## Prompt injection

- User content goes in `contents`, never in the system instruction.
- No tools or function calling are configured (asserted in `gemini.test.ts`).
- Output is plain text, rendered with `textContent`.
- No server action is ever taken based on model output.
- Only the requester's own recent turns are in context.
- Tests: `ai.test.ts` scenarios 14–15.

## Known limitations (be honest about these)

- Keyword detection misses indirect phrasing. Documented false negatives in `crisis.test.ts`:
  - "gusto ko nang magpahinga habambuhay"
  - "sana hindi na lang ako ipinanganak"
  - "I won't be a burden much longer"
  
  These rely on the model's safety instructions, which are also imperfect.
- It can over-trigger. For example, "I've been suicidal before but I'm okay now" is classified urgent because it contains "now".
- Detection looks only at the newest message, not at risk building up over a conversation.
- KARAMAY has no human monitoring, cannot contact emergency services, and must never imply that it does.
- There is no human-support channel yet. Before launch, provide a monitored contact (e.g. a support email answered by trained staff, with clear response times), and list it in the app.

## Before launch (human review required)

- A licensed mental-health professional familiar with Filipino culture should review the templates, the system prompt and the test phrases.
- Re-verify the hotline numbers (`RUNBOOKS.md` §8).
- Red-team the live model with Filipino and Taglish crisis phrasing in staging, and record the results.
- Decide whether to add a model-based risk classifier as a second layer. If added, it must not delay or block the urgent template.
