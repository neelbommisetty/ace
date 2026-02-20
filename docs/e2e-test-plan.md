# E2E Test Plan

## Purpose

Ensure the ace CLI works end-to-end for the primary user workflow: setup, project init, question generation, testing, feedback, scoring, reset, and dispute.

## Scope

Covers CLI behavior, filesystem side effects, and successful command sequencing for a local workspace. Focuses on flows a user runs with the installed CLI and on this repo when run via `npm run ace`.

## Out of Scope

Performance benchmarking, network reliability, and LLM model quality. UI-level rendering beyond terminal output formatting.

## Environments

- Node.js LTS compatible with repo `package.json` engines
- macOS and Linux shells
- Clean temp workspace per run
- Automated E2E runs use `ACE_E2E_MOCK_LLM=1`, optional `ACE_MOCK_LLM_MODE`, and `ace init --skip-install` plus a `node_modules` symlink

## Test Data

- A temp workspace directory
- Sample `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in a secure test environment
- A known question slug for deterministic tests

## E2E Scenarios

1. Setup stores config
Steps: run `ace setup`; enter provider and key; confirm `~/.ace/config.json` is created and contains the provider without exposing secrets in logs.

2. Init bootstraps workspace
Steps: run `ace init`; verify `questions/` created; verify `package.json`, `vitest` config, and `node_modules` exist; run `npm test` to ensure no failures.

3. Generate creates a question folder
Steps: run `ace generate`; select a category and topic; verify `questions/<category>/<slug>/` created with `README.md`, `scorecard.json`, and correct solution/test filenames.

4. Test runs a single question
Steps: run `ace test <slug>`; verify vitest runs only the target question test and exits with success.

5. Feedback runs on a solution
Steps: implement a minimal correct solution; run `ace feedback <slug>`; verify feedback is generated and stored or printed according to CLI output.

6. Score updates scorecard
Steps: run `ace score <slug>` after tests pass; verify `scorecard.json` updated with the expected fields.

7. Reset restores defaults
Steps: modify solution and scorecard; run `ace reset <slug>`; verify solution restored to starter content and `scorecard.json` reset.

8. Dispute edits a test file
Steps: run `ace dispute <slug>`; provide a corrected assertion; verify the test file is updated and the change is scoped to the question folder.

9. All-questions flow
Steps: run `ace test --all`; verify all question tests execute and failures are summarized.

## Reporting

Record pass/fail per scenario, CLI exit codes, and any unexpected filesystem changes. Attach command logs when failures occur.

## Maintenance

Update this plan when a code change introduces a new user flow, changes CLI behavior, or adds new testable functionality.
