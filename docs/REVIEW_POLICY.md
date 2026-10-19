# Rookzen implementation review policy

Status: CONDITIONAL POLICY. In an unmerged proposal this policy is INACTIVE. Once the activation test below is satisfied, it is ACTIVE for eligible future PRs without another wording-change commit. Existing gate decisions and exact-head exceptions remain historical facts.

## Effective date and non-retroactivity

Approval in principle, permission to implement, permission to publish, and final policy adoption are separate. Activation requires BOTH: (1) an explicit GitHub comment or review by repository owner sayed710 on the policy PR adopting this policy at its exact final head SHA, and (2) that owner manually merging that same policy PR into main. Implementation/publication approval or a generic review approval alone is not adoption. A later push invalidates the head-bound adoption and requires renewed explicit adoption.

The activation receipt consists of the owner-adoption permalink and text, final PR head SHA, GitHub merged=true, merged_by.login=sayed710, merged_at, and merge_commit_sha M, with M reachable from origin/main and containing the adopted policy content. These values are obtained from GitHub and Git after merge; no future merge SHA or timestamp must be embedded in this document. Any missing or contradictory receipt leaves activation UNVERIFIED and existing gates in force. No automated status may stand in for this receipt.

Apply the activated policy only to implementation PRs whose GitHub created_at is strictly later than the policy PR merged_at and whose exact reviewed HEAD descends from policy merge commit M, verified by git merge-base --is-ancestor M <PR_HEAD> returning exit 0. A mutable GitHub base branch pointing to main is not ancestry evidence. If eligibility cannot be established, retain the previous gates until the owner explicitly decides otherwise. Record that eligibility and the activation receipt in the PR evidence. An existing PR does not become eligible through a rebase, merge of main, reopening, or later push. Ambiguous eligibility retains the existing gates pending owner decision.

PR #118 was manually merged as 25f7278a9938767d539dfe92398ee189832d82d9; its reviewed head was 2fc6a10dd7e7fdd515cc6a23f04ffd817840bfcc. Its SHA-specific owner exception remains historical, with Qodo Requirement Gaps UNVERIFIED, not zero. PR #119 remains Claude's D1-A responsibility with its existing gates. Neither PR is migrated by this policy. Any separate migration/exception for an existing PR requires explicit owner authorization identifying that PR and SHA; no new implementation or access to its worktree is authorized here.

The policy-change PR itself must satisfy the currently active gates, including Qodo Bugs=0, Rule violations=0, and substantive Requirement gaps/actionable findings=0, plus existing CI, Greptile, independent-review, thread and Git gates. Missing Qodo evidence remains UNVERIFIED/HOLD unless the owner grants a separate explicit PR-and-SHA-specific exception. This policy grants no automatic exemption and cannot authorize its own acceptance.

## Ownership and safety

The owner authorizes a task-specific coordinator and ONE primary implementation agent, with recorded scope, capabilities, worktree and file ownership. This policy does not permanently reserve orchestration or implementation to any product or model. Delegated reviewers are read-only unless the owner explicitly authorizes additional work; a reviewer must not certify its own changes as independent. Corrections return to the same authorized implementation owner unless the owner approves a documented handoff. No competing writers.

All repository implementation uses a task-owned isolated worktree, never the canonical root or another agent's worktree. Before modifications run git status, git worktree list, git branch -vv, git fetch --prune and verify current origin/main, task ownership, dependencies and concurrency. Before push complete required tests, inspect the full diff and commits, verify clean committed state, fetch again and recheck concurrency. After push fetch and prove local HEAD = remote branch HEAD = GitHub PR HEAD, divergence 0/0 and clean worktree. Never overwrite another agent's work.

Pi remains supervised read-only until separately verified and authorized for more; ZadLoop is retired. Agents never merge, push directly to main, force-push or rewrite published history. Deployment requires separate explicit owner authorization. The owner alone performs merges.

## Source of acceptance before implementation/review

The task coordinator records stable requirement IDs, original owner approval/reference, versioned ADR/specification sections, exact source commit/blob or external document revision, approved scope and explicit exclusions. An implementation is never retroactive authority. A draft specification stays DRAFT until owner-approved; source disagreements are escalated, not silently resolved in code's favor. Historical findings must be revalidated against current source and are not automatically launch requirements.

Every implementation PR includes its applicable requirement manifest or an approved versioned document reference. The input describes that PR, not an unrelated connected specification. Private source content is not published to public GitHub or granted to a provider without the owner's authorization.

## Mandatory gates for eligible PRs after activation

1. All applicable mandatory CI and required local tests pass, including real-service/security/concurrency verification where applicable. Skipped required tests and setup failures are not passes.
2. Greptile completes a real code review of the exact final published SHA; all unresolved actionable findings, blocking or non-blocking, are corrected or explicitly disposed of by the owner. Inspect review results and findings, not merely the green check or5/5 score. Record review/check IDs, SHA and completion. A failed/skipped/old-head review is not clearance.
3. Explicit requirements-to-implementation-and-tests assessment covers EVERY applicable approved requirement. Each row records ID/source, exact file/line, named test/observable runtime evidence, reviewer identity and exact SHA, PASS/FAIL/UNVERIFIED/NOT APPLICABLE, actionable severity and disposition. PASS needs actual assertions or justified static evidence, not a green suite alone. NOT APPLICABLE needs explicit scope reasoning, never a hidden deferral. Missing important evidence remains UNVERIFIED and blocks readiness.
4. Required independent engineering review completed through the existing verified model hierarchy. The authorized primary implementation agent must be independently inspected using a genuinely distinct model, through the applicable owner-approved task template and established review hierarchy; session separation alone is not model independence. For Codex engineering, retain the existing Gemini3.8FlashHigh -> genuine quota/model unavailability only Claude Sonnet4.6Thinking -> genuine Claude quota block Codex strict self-review hierarchy; auth/config/invocation failure is not a fallback. Any fallback is explicitly labeled and never invented as independent-model proof. Strict self-review alone cannot satisfy a required independent-model gate without a separate explicit owner exception.
5. Unresolved review threads =0, including inspected valid supplementary findings. CodeRabbit supplementary: inspect/fix valid findings when available, never wait solely for absence. Graphite not mandatory.
6. Fresh Git concurrency check before publication; after publication fetch and prove local HEAD = remote branch HEAD = GitHub PR HEAD, divergence0/0 and clean task worktree. The task coordinator independently validates the handoff and evidence without claiming reviewer-model independence for its own analysis. Owner alone decides merge.

For eligible PRs after activation, Qodo is no longer a mandatory reviewer/gate. This does not disable its integration or erase findings: any genuine Qodo finding that runs remains actionable and must be assessed. Historical Bugs/Rules counts, UNKNOWN requirement coverage and PR118's narrow owner exception are not rewritten. No claim Qodo assessed an unreported category.

## Greptile requirements evidence versus independent assessment

Repository context/rules can direct Greptile to approved ADRs/specifications. Actual source use and exact-head output must be checked. General code understanding, a context filename, a high confidence score,0comments or no actionable finding does not prove a per-requirement assessment or execution of tests.

Credit Greptile for a requirement only when its actual output supports the specific clause and source. If it supplies no full matrix, a separate distinct-model engineering reviewer performs the evidence-backed assessment and is named separately. This is the normal two-part gate after activation, not an exception or a claim that Greptile performed missing work. The task coordinator checks every row and binding. One independent supervisor report may serve both engineering review and requirements assessment if both are substantive and clearly recorded; no duplicate model review is required merely for separate headings.

Runtime evidence can be reused when source hashes, commands, assertions, environment, outputs and exits establish applicability. Distinguish durable repository tests from retained external probes; if neither adequately covers a required case, mark UNVERIFIED and execute only the missing targeted check. Do not rerun all green suites without a reason.

## Efficient exact-head cycle

Before dispatch, confirm ownership and no equivalent active review. Supply correct versioned requirements once. Let one supported automatic review or one manual request complete; do not duplicate provider triggers. Preserve actual results and source bindings. Route confirmed corrections to the same authorized implementation owner, then independently inspect them and renew affected gates.

Every new push invalidates earlier exact-head acceptance. A prior immutable requirements document can remain the source, but the task coordinator must obtain review/evidence that genuinely binds the changed final SHA; old green comments cannot be copied forward. Even an unchanged-source metadata commit needs explicit reviewed-content/commit binding under the gate, not assumed equivalence. Avoid artificial commits and repetitive full reviews.

Record provider execution failure, scope mismatch, source retrieval failure or absent evidence as UNVERIFIED/HOLD. No fake status, automatic waiver, fabricated zero or silent reduction of branch protection.

## Inputs and automation boundary

Prefer version-controlled repository ADRs/specifications plus `.greptile/files.json` context selection; `.greptile/rules.md` may request per-ID traceability, but natural-language instructions do not guarantee output. Keep approval status and scope explicit so historical ADR deferrals do not override later owner authorization or expand it.

Manual verification remains mandatory for authority, source use, completeness, evidence quality, severity/disposition and final owner decision. Automated collectors may archive SHA/check/comment/thread IDs, source/test hashes and schema completeness; they cannot certify requirement correctness or invent provider-stage success. Any later checker is a separately approved narrow implementation PR and must fail closed when evidence is incomplete. Do not create a status impersonating Greptile.

Adoption does not change provider account connections, org settings, billing, auto-approval, branch protection or security permissions. Those require separately presented owner approval. No permanent fleet configuration is introduced.
