# OpenCode investigation outcomes — coordinator publication summary

These are collected results from the original OpenCode Plan session, not new execution by this archive publisher.

## Pinned-main reproduction provenance

The reviewer independently compared the exact bytes of all42 frozen files with their Git blobs at `4ccf8f48869335e06ac1b1de467d2161869f8fd7`; all matched. Manifest blob IDs and lengths matched. Build metadata listed35 inputs:33 production modules, one pinned fake-socket test seam and the external harness. Runtime external requires were Node built-ins. The clean inspection checkout remained `dbf44d9a4207af6cf6096935693198a8a4954ff0`, distinct from extracted main.

Recorded bundle/runner/harness SHA256 values were not independently recomputed. Independent current source-byte comparison is not historical cryptographic attestation of every artifact. TAP and observations agree on15cases/7PASS/8 behavioral assertion failures/zero skips; the initial bundling setup failure was separate. No PostgreSQL/Redis, network or multi-process proof follows.

The final CLI collection exited1 after a WebSocket1006 transport close, following substantive review output. It is **not** a successful CLI exit receipt, a model-quota failure, a behavioral test execution or grounds to discard the completed byte comparison. No retry or policy/allowlist change was made for publication.

## PR107 versus current main

At inspection, main was `4ccf8f4`, PR107 was `7f65bde` and their merge base was `2f94dab`. The reviewer found83 changed main paths and24 changed PR paths, with no shared path. This is a path-level assessment, not an executed merge or runtime compatibility proof.

Main's historical integrated count was4180; PR107's earlier local run was4075. Neither proves an integrated PR107-on-current-main run. Root workspace tests cover19 packages; the deployable gateway service has separate acceptance coverage. No merge/rebase/checkout/test or production edit was performed by this integration review. Later PR107 publication/gates must be checked at their new head independently.
