#!/bin/bash
# The site knows the answer (bench/browser/site.mjs:CHECKS). Last line: pass, or fail with the reason.
curl -s --max-time 20 --data-binary @"$BENCH_ANSWER" "$BENCH_SITE/s/$BENCH_ID/__check/mixer-ratio" || echo "fail: the site did not answer"
