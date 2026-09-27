#!/bin/sh
cd "$(dirname "$0")/.."
node src/cli.js mine-prs PostHog/posthog --before 2026-09-24T13:00:00Z --after 2026-09-21T00:00:00Z --limit 120 --repo bench/repos/posthog
node src/cli.js seed --prompts bench/data/posthog-invariant-prompts.json --repo bench/repos/posthog --model sonnet
node src/cli.js relink --repo bench/repos/posthog
node src/cli.js stats --repo bench/repos/posthog
echo ENRICH_DONE
