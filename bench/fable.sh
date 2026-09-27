#!/bin/sh
cd "$(dirname "$0")/.."
node bench/run.js --repo posthog --tasks bench/tasks/posthog-hard.json --model fable --arm nocache,hook --reps 2 --conc 3 --tag posthog-fable --notes-dir bench/notesets/posthog-v2/notes
node bench/criteria.js grade bench/tasks/posthog-hard.json posthog-fable
echo FABLE_DONE
