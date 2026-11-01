# ADR-0100 — Timeout material rules are per-variant

| Field      | Value                    |
|------------|--------------------------|
| **Status** | Accepted                 |
| **Date**   | 2026-08-06               |
| **Scope**  | `packages/game`          |

---

## Context

When a player's clock runs out, the win is downgraded to a draw if the opponent could not have won
anyway — a lone king cannot force mate, so flagging against one is not a loss. `canMate` in
`packages/game/src/game.ts` implemented that test, and `endByTimeout` called it as
`canMate(this.state.position.fen(), winner)`: the FEN and the colour, and **not the variant**.

Two consequences, both live on variants the lobby offers:

1. `parseFen(fen)` defaulted to `standard`, so nothing variant-specific in the position was read.
2. The classical material test — lone king, K+N and K+B cannot force mate — was applied to variants
   where checkmate is not the win condition at all.

Measured before the change, all returning `false` (i.e. "cannot win", so the timeout became a draw):

| position | variant | correct answer |
|---|---|---|
| bare king | `kingofthehill` | can win — walk to the centre |
| bare king | `racingkings` | can win — reach the eighth rank |
| K + queen **in hand** | `crazyhouse` | can win — one drop from mate |
| K+N | `threecheck` | can win — a knight gives checks |
| K+N | `atomic` | can win — a knight delivers the explosion |

Recorded as "per-variant timeout material rules" under Milestone 2 in `docs/ROADMAP.md`.

## Decisions

### 1. `canMate` takes the variant and answers the variant's own question

The signature becomes `canMate(fen, color, variant = 'standard')`, and `endByTimeout` passes
`this.state.variant`. The default keeps every existing caller and test on the standard rule.

The rule per variant, and why:

- **`standard` / `chess960`** — checkmate reachability under FIDE Article 6.9 applies:
  a timeout is adjudicated as a draw ('insufficient_material') if and only if it is proven
  impossible for the prospective winner to deliver checkmate by any possible series of legal
  moves from the actual position. Enemy pieces can serve as enabling blockers (e.g., in KN vs KR,
  KN vs KN, or KB vs KN corner mates). Adjudication evaluates cooperative reachability via a
  bounded proof (depth 4, capacity 512 tokens). In accordance with the uncertainty bias below,
  if the search budget is exhausted or an unclosed cycle is encountered, the outcome defaults to
  possible ('timeout' win).
  **Bounded Engineering Limitation & Risk Profile**: The actual operational risk of the bounded
  proof is not deep forced mates (which uncertainty bias already resolves as a win), but rather
  deeply forced loss of the prospective winner's only mating material or dead positions requiring
  proof beyond depth 4 / capacity 512 tokens. In such positions, the solver returns unknown,
  which defaults to possible ('timeout' win), potentially awarding a win in positions that are
  actually dead under FIDE Article 6.9 / Article 5.2.2. The solver is a bounded engineering heuristic,
  not a full FIDE dead-position oracle. Shallow forced controls (e.g. single-ply Control 1 branch
  closure) are resolved, and the uncertainty bias guarantees that a player is never erroneously
  handed an unproven draw.
- **`kingofthehill`, `racingkings`** — both are won by walking a king somewhere. A player reduced to
  a bare king still holds the only piece the win condition needs, so material can never rule it out.
- **`crazyhouse`** — pieces in hand can be dropped and the board does not show them. The deciding
  point is that **a king captures like any other piece**, so even a bare king with an empty pocket can
  take something and drop it back. No material state rules a win out, which makes the guard
  inapplicable rather than merely generous.
- **`horde`** — White is a pawn army with no king and wins by mating; Black wins by capturing every
  white piece, and a king captures perfectly well on its own. As in Crazyhouse, the guard does not
  apply.
- **`threecheck`** — won by giving three checks, so the two-minor threshold is irrelevant: a single
  knight checks. Only a bare king cannot, and capturing does not help it — no capture turns a king
  into a piece that gives check.
- **`atomic`** — won by exploding the enemy king. A king may not capture without exploding itself, so
  unlike the two above, a bare king cannot even begin; any other piece can deliver the capture.

The split between the first two and the last two is a king's capture: in Crazyhouse and Horde it
makes progress toward the win, in Three-check it cannot create a checking piece, and in Atomic it is
not available at all.

### 2. Conservative in one direction, deliberately

The function answers "could this side possibly win", and where the honest answer is unclear it says
yes. The two failure modes are not symmetric: handing a draw to a player who was winning takes
something from them, while the guard exists only to spare an opponent a loss they could never have
converted. Erring toward "yes" leaves the normal timeout result intact.

The first version of this ADR stated that bias and then broke it in the same breath: `crazyhouse`
returned false for a bare king with an empty pocket, and a test asserted that draw as correct. The
reasoning that a king can capture and seed its own pocket had actually been considered and then not
applied — the stricter rule shipped anyway, with a test that locked it in. Caught in the review of
PR #97 and corrected here; `horde` had the same defect for a bare black king.

The lesson is the one the bias exists to encode: when the analysis says "this side could still find a
way", the rule has to say so too, or the guard quietly reintroduces the bug it was written to remove.

## Consequences

- A timeout in an offered variant is now resolved by that variant's rules. The most visible change:
  in King of the Hill a bare king wins on time instead of drawing.
- **Standard and Chess960 behaviour**: Originally preserved unchanged under the initial variant
  milestone (maintaining the legacy two-minor material heuristic). Under Issue #123, Standard and
  Chess960 timeout adjudication is updated to bounded cooperative reachability (fixed depth 4,
  capacity 512 tokens), evaluating whether checkmate can be delivered by any legal series of moves
  under FIDE Article 6.9 (resolving lone-minor corner mates with opponent assistance and same-color
  bishop draws). This is an engineering heuristic rather than a full FIDE dead-position oracle;
  the declared depth and token budget retains a residual false-WIN risk on deeply dead positions.
  The default argument `variant = 'standard'` continues to keep existing callers correct.
- Mutation-verified: dropping the `variant` argument at the call site fails the King of the Hill
  test.

## Out of scope

- Insufficient-material *during play* (`Position.hasInsufficientMaterial`), which already guards
  itself to `standard` and `chess960` and needed no change.
- Any change to how flagging itself is detected.
