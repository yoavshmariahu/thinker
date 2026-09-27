#!/bin/sh
cd "$(dirname "$0")/.."
node bench/run.js --repo posthog --tasks bench/tasks/posthog-hard.json --model opus --arm hook --reps 1 --conc 2 --tag posthog-opus-slim --only "PR106466-hard,PR106522-hard,PR106564-hard,PR106613-hard,PR106672-hard,PR106936-hard,PR107042-hard" --notes-dir bench/notesets/posthog-v2/notes
node bench/criteria.js grade bench/tasks/posthog-hard.json posthog-opus-slim
echo SLIM_DONE
