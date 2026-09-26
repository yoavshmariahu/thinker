#!/bin/sh
# adversarial chain, then rerank/irrelevant arms on the clean repo
set -x
cd "$(dirname "$0")/.." || exit 1
node bench/adversarial.js apply
node bench/run.js --repo click --tasks bench/tasks/click-adv.json --arm nocache,hook,naive --reps 2 --conc 3 --tag click-adv --notes-dir bench/runs/click-adv-notes-orig
node bench/adversarial.js verify
node bench/run.js --repo click --tasks bench/tasks/click-adv.json --arm hook --reps 2 --conc 3 --tag click-adv-verified --notes-dir bench/runs/click-adv-notes-verified
node bench/adversarial.js revert
node bench/run.js --repo click --model sonnet --arm rerank,irrelevant --reps 2 --conc 3 --tag click-v3 --irrelevant-notes "$PWD"/bench/repos/mitmproxy/.thinker/notes
