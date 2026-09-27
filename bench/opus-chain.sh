#!/bin/sh
cd "$(dirname "$0")/.."
node bench/run.js --repo posthog --tasks bench/tasks/posthog-hard.json --model opus --arm nocache,hook,pointers --reps 1 --conc 2 --tag posthog-opus --notes-dir bench/notesets/posthog-v2/notes
node bench/criteria.js grade bench/tasks/posthog-hard.json posthog-opus
echo OPUS_CHAIN_DONE
