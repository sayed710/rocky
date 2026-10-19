## Rules
- NEVER push directly to the main branch. Always push your changes to a new branch and let the user create a Pull Request.
- Always make sure to push your work to the remote repository when you are done with a task, unless told otherwise.

## Guardrails (Gambit Project)
1. docs/PROJECT_STATE.md is APPEND-ONLY.
   - NEVER delete, truncate, or rewrite existing content or milestone names.
   - Every increment: add ONE new entry, AND bump the "_Last updated_" header line at the top of the file.

2. ADRs live in docs/adr/NNNN-kebab-case-name.md — never in docs/ root.

3. Before pushing, run the FULL CI-equivalent locally, to completion, across EVERY package:
     `npm run build && npm run lint && npm test`
   - If you touch the api package: also run `npm run openapi -w @chess-platform/api` and confirm ZERO drift in packages/api/openapi.json.
   - If you touch anything under packages/realtime-gateway or its shared dependencies: rebuild and test services/gateway from a CLEAN install (`rm -rf services/gateway/node_modules && npm install --prefix services/gateway && npm run build && npm test`).

4. NO `as any`, ever. Write or reuse a proper type guard.

5. Respect package boundaries and purity:
   - @chess-platform/tournament stays dependency-free. No new deps, no real Date.now()/wall-clock reads inside the domain — inject time/clock as a parameter.
   - @chess-platform/api must never depend on @chess-platform/realtime-gateway.
   - Don't widen a shared type/union if doing so would force unrelated packages to change.

6. Branch from the LATEST origin/main. Never push to main directly — always open a PR.

7. Reuse existing patterns instead of inventing new ones.


## Review policy (conditional activation)

The evidence-based implementation gates and their activation test are documented
in [docs/REVIEW_POLICY.md](../docs/REVIEW_POLICY.md). Until the recorded owner
adoption and manual policy-PR merge satisfy that test, existing gates apply.
For eligible future PRs after activation, use exact-head Greptile plus
mandatory independently attributable requirements traceability; Qodo is no longer
a mandatory gate under that adopted policy. Preserve all historical Qodo results
and exact-head exceptions without relabeling unverified assessments as PASS.
All existing Git, full local test, scope, independent-review and owner-only-merge
rules remain in force. No branch protection or integration setting is changed.
