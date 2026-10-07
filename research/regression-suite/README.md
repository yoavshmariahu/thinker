# Regression recall across seven repositories

Authors: Codex and Yoav. 2026-10-06.

The five-repository expansion attempted 75 paired historical-regression reviews, evenly assigned to Opus 5.5 high, GPT-6.1 Sol high, and Gemini 3.8 Flash high. Each pair and its cache-building phase use the same exact model and effort. Thinker caught 66/74 target bugs versus 53/74 for diff-only review, with 16 gains and 3 losses. 1 pair(s) remain invalid and are excluded rather than counted as misses; see summary.json for unpaired valid-arm results and costs. These totals describe a mixture of three model cohorts, not a comparison of the models.

The earlier ten Autoscaler and fifteen mitmproxy cases bring the inventory to seven repositories and 100 bugs. Across those historical and new runs, the descriptive counts are 67/99 versus 90/99. Earlier runs used different Thinker revisions. This is recall of bugs whose fixes were available during memory building, not unseen-bug detection.

## Results by repository

| Repository / cohort | Diff only | Thinker | Gains / losses | Review tokens, diff / Thinker | Review seconds, diff / Thinker |
|---|---:|---:|---:|---:|---:|
| grafana (rotated models) | 9/15 | 12/15 | 4 / 1 | 287,850 / 350,135 | 368.2 / 437.9 |
| posthog (rotated models) | 8/14 | 12/14 | 5 / 1 | 350,818 / 368,006 | 473.2 / 503.1 |
| pandas (rotated models) | 12/15 | 15/15 | 3 / 0 | 373,115 / 328,129 | 539.7 / 402.9 |
| sklearn (rotated models) | 10/15 | 13/15 | 3 / 0 | 337,304 / 307,782 | 467.0 / 374.6 |
| pydantic (rotated models) | 14/15 | 14/15 | 1 / 1 | 335,510 / 315,701 | 505.1 / 427.5 |
| autoscaler (historical Sol) | 6/10 | 9/10 | 4 / 1 | 184,927 / 191,053 | 139.5 / 178.6 |
| mitmproxy (historical Sol) | 8/15 | 15/15 | 7 / 0 | 251,938 / 268,789 | 130.5 / 200.5 |

## Separate model cohorts in the expansion

| Repository / cohort | Diff only | Thinker | Gains / losses | Review tokens, diff / Thinker | Review seconds, diff / Thinker |
|---|---:|---:|---:|---:|---:|
| opus | 18/25 | 23/25 | 6 / 1 | 171,009 / 313,604 | 358.4 / 469.1 |
| sol | 18/25 | 24/25 | 6 / 0 | 467,448 / 523,854 | 390.5 / 657.1 |
| gemini | 17/24 | 19/24 | 4 / 2 | 1,046,140 / 832,295 | 1604.2 / 1019.7 |

Each model received five cases in each repository, for 25 cases per model. Their bug sets differ, so these rates cannot rank models. See [cohorts.mjs](cohorts.mjs) for exact identifiers.

## Method and cost

The experiment used Thinker commit `1587c4348d48018fafbe0927f812dc4fcd10f324` throughout; newer changes landed during execution but were not mixed into these results. The frozen [protocol](PROTOCOL.md) and each repository's cases.json define the selection, assignment and score rule. Each model independently mined the same fifteen historical fixes in each repository, then reviewed its five assigned reversals. The intervention is the generated Thinker cache, with the product's normal review selection and prompt. Full reversed patches include upstream test removals and documentation, as in the canary. Each source corpus is copied for serving so evaluation cannot mutate its original notes.

The 225 mining operations consumed 3,701,337 reported tokens and saved/merged 328 notes (this is operation count, not unique final notes). Review tokens and latency are separate in the tables; latency is summed per-arm invocation time, not concurrent wall time. Model/provider counters differ and should not be treated as equally calibrated across models. See [summary.json](summary.json) for per-repository/model mining costs. No currency estimates are made. Invalid attempts are separate from the valid-pair tables: 8 attempt(s), 417,242 known provider-reported tokens (4 attempts have unknown usage), and 22475.1 seconds of measured wall-clock time. Two timed-out calls each span about three hours in the wall-clock records; this is not a model-compute latency estimate. See [invalid-attempts.json](invalid-attempts.json) for retained failures. Retry limits were an operational decision made after provider failures: at most three same-model attempts, preserving valid arms and original case assignments. PostHog #104706 exhausted all three baseline attempts; its valid Thinker hit is excluded from paired totals. Scikit-learn #34605 succeeded on its second baseline attempt. Later Gemini calls encountered two timeouts and authentication failures; model-list access recovered, and only unfinished arms were resumed. Failure counters reported by the product were zero on parse failure, so provider trace usage is reported separately instead.

[model-pins.patch](model-pins.patch) is an experiment-only adapter patch that pins effort and captures provider traces; it is not a production feature change. Provider fallback is disabled. Opus identity is checked against returned modelUsage; Gemini and Sol rely on explicit invocation when their CLIs omit a model echo. [audit.json](audit.json) records identity, immutable notes and manifest checks. Each cohort contains full review reports, mined notes, usage and trace audits. Raw provider traces are preserved in provider-traces.tar.gz; extract it in this directory before running audit.mjs.

## Ground truth and scoring

Each case is a real upstream fix with a clean reverse patch against a pinned base. Codex manually matches warning/error findings to the historical mechanism and changed production locations (including removal anchors, ±6 lines). Each repository's scores.json records matching finding indexes and rationale. Mere proximity, deleted-test complaints and unrelated warnings are not detections. Empty results remain misses. Model errors are invalid and never counted as misses.

[reproduce.py](reproduce.py) provides focused source-mechanism checks across all five repositories: 6 reproduce the failure on reversed source and pass on fixed source. These extract actual source with dependencies/test doubles; they are not full upstream integration tests. The pandas Excel probe also extracts the pinned upstream Index.take implementation, because the locally installed pandas 2.x version has older fill semantics. See [reproductions.json](reproductions.json). The complete Thinker test suite passed with telemetry disabled: 486 passed, 5 skipped, 0 failed at the experiment revision. The rebased report branch also passed all 500 tests (495 passed, 5 skipped, 0 failed); see thinker-tests-current.txt.

## Limits and next measurement

This selected sample favors compact, recently fixed, reversible bugs and has one sample per arm. No clean-change controls were run, so false-positive rates are unknown. Learning from the target fixes is intentional for this recall study but prevents claims about prospective bug discovery. A next study should freeze caches before held-out changes and include clean controls, with the same cases repeated across all models if model ranking is desired.

The planned efficiency study will begin later with three tasks per model (Sol, Opus and Gemini Flash), each with and without Thinker: eighteen runs. It will pin the latest Thinker revision at its start and collect fresh correctness, token, tool-call and latency measurements. No efficiency calls are part of this study.

## Reproduction

Use a fresh Thinker worktree at the recorded commit, apply model-pins.patch, obtain repository clones at their cases.json base commits, and adjust clone paths in run-suite.mjs. With authenticated CLIs:

```sh
THINKER_TEST=1 THINKER_TELEMETRY=off THINKER_LOG=local node research/regression-suite/run-suite.mjs
THINKER_TEST=1 node research/regression-suite/inspect.mjs
THINKER_TEST=1 node research/regression-suite/audit.mjs
THINKER_TEST=1 node research/regression-suite/summarize.mjs
THINKER_TEST=1 node research/regression-suite/write-report.mjs
```

The harness resumes existing valid checkpoints. Use a separate output directory or remove only copied result artifacts when intentionally starting a new independent sample. Manual semantic scores must be reassessed for new model outputs. All test/evaluation/setup processes must inherit THINKER_TEST=1.

## Observed product failure

Grafana #132940 exposed a postprocessing failure: Opus returned a correct regression finding while correcting a secondary inaccurate detail in the same note. `src/review.js:680` removes every finding tied to a note listed as outdated, so the final report lost the valid bug finding. This is counted as an end-to-end miss, not a model recognition failure. [Raw evidence and diagnosis](miss-analysis.json) are preserved. The benchmark does not patch or rerun this behavior. Two other Grafana misses, plus Pydantic #13515 and PostHog #103110 under Gemini, retrieved the relevant notes but accepted the reverted implementation as the current policy, marking the protective notes outdated. These are review-reasoning failures rather than retrieval misses.

A static broken-reference warning in both arms also matched the English word `drawn` in pandas documentation to a removed test helper. That incidental false positive is excluded from target detection and preserved in [non-target-observations.json](non-target-observations.json); it does not establish a false-positive rate.

## Case inventory

| Case | Cohort | Historical bug | Diff only | Thinker |
|---|---|---|---:|---:|
| [grafana-132418](https://github.com/grafana/grafana/pull/132418) | opus | FieldOverrides: Don't write panel field config onto shared source frames (#132418) | hit | hit |
| [grafana-133093](https://github.com/grafana/grafana/pull/133093) | gemini | Dashboards: Preserve Dashboard datasource references in v2 exports (#133093) | hit | hit |
| [grafana-133023](https://github.com/grafana/grafana/pull/133023) | gemini | Alerting: Support missing-series resolution counts above the SMALLINT limit (#133023) | miss | miss |
| [grafana-133033](https://github.com/grafana/grafana/pull/133033) | sol | OpenFeature: Don't let wildcard namespace override eval context (#133033) | hit | hit |
| [grafana-132979](https://github.com/grafana/grafana/pull/132979) | gemini | Modals: Fixes cut focus (#132979) | miss | hit |
| [grafana-132877](https://github.com/grafana/grafana/pull/132877) | gemini | Combobox: Ensure useComboboxFloat does not cause excessive rerenders (#132877) | hit | hit |
| [grafana-132966](https://github.com/grafana/grafana/pull/132966) | gemini | router: handle aggregate discovery format from apiextensions (#132966) | hit | hit |
| [grafana-132940](https://github.com/grafana/grafana/pull/132940) | opus | Dashboards: Fix v2 save failing with resourceVersion set on create (#132940) | hit | miss |
| [grafana-132860](https://github.com/grafana/grafana/pull/132860) | opus | fix(logs): remove \B alternation from key regex to prevent catastrophic backtracking (#132860) | miss | hit |
| [grafana-131837](https://github.com/grafana/grafana/pull/131837) | opus | Dashboards: Fix query variable refresh reset to onDashboardLoad on v2 UI import (#131837) | miss | hit |
| [grafana-132572](https://github.com/grafana/grafana/pull/132572) | sol | Flamegraph: Fix NaN/undefined diff tooltip in sandwich view (#132572) | hit | hit |
| [grafana-132648](https://github.com/grafana/grafana/pull/132648) | sol | Frontend: Fix MutableDataFrame for ESM strict mode (#132648) | hit | hit |
| [grafana-131464](https://github.com/grafana/grafana/pull/131464) | opus | Annotations: fix ensureTags never deleting removed tag links (#131464) | hit | hit |
| [grafana-132082](https://github.com/grafana/grafana/pull/132082) | sol | Dashboards: Fix for panels with lower min height than row height (#132082) | miss | miss |
| [grafana-130358](https://github.com/grafana/grafana/pull/130358) | sol | Explore: Preserve datasource type in trace-to-logs and trace-to-metrics queries (#130358) | miss | hit |
| [posthog-105736](https://github.com/PostHog/posthog/pull/105736) | gemini | fix(bigquery): stop key file field names blocking source setup (#105736) | hit | miss |
| [posthog-105852](https://github.com/PostHog/posthog/pull/105852) | opus | fix(tasks): give a codex turn one trace id (#105852) | miss | hit |
| [posthog-104706](https://github.com/PostHog/posthog/pull/104706) | gemini | fix(warehouse-sources): stop reporting a quiet schema as a stalled schedule (#104706) | invalid | hit |
| [posthog-91352](https://github.com/PostHog/posthog/pull/91352) | opus | fix(messaging): stop merge tags inserting double quotes (#91352) | hit | hit |
| [posthog-105660](https://github.com/PostHog/posthog/pull/105660) | opus | fix(prompts): cap the label-referencing parent listing (#105660) | hit | hit |
| [posthog-105551](https://github.com/PostHog/posthog/pull/105551) | opus | fix(replay-vision): evict stale connections before async activities run (#105551) | miss | hit |
| [posthog-105799](https://github.com/PostHog/posthog/pull/105799) | sol | fix(workflows): size audiences during read-only impersonation (#105799) | miss | hit |
| [posthog-105133](https://github.com/PostHog/posthog/pull/105133) | opus | fix(ingestion): drop latest_processed_timestamp_ms series on partition revoke (#105133) | miss | hit |
| [posthog-105670](https://github.com/PostHog/posthog/pull/105670) | sol | fix(insights): sort unordered insight list on an indexed column (#105670) | hit | hit |
| [posthog-105737](https://github.com/PostHog/posthog/pull/105737) | sol | fix(insights): stop the insight editor auto-saving on a chart-type change (#105737) | hit | hit |
| [posthog-105409](https://github.com/PostHog/posthog/pull/105409) | gemini | fix(alerts): report the real outcome when an AI detector check fails (#105409) | hit | hit |
| [posthog-105690](https://github.com/PostHog/posthog/pull/105690) | gemini | fix(insights): honor 0 decimal places in data viz formatting (#105690) | hit | hit |
| [posthog-96235](https://github.com/PostHog/posthog/pull/96235) | sol | fix(workflows): accept issued invocation ids when cancelling runs (#96235) | hit | hit |
| [posthog-105707](https://github.com/PostHog/posthog/pull/105707) | sol | fix(conversations): finish support drafts that end without json (#105707) | miss | hit |
| [posthog-103110](https://github.com/PostHog/posthog/pull/103110) | gemini | fix(mcp-store): report a tool listing that never produced tools (#103110) | miss | miss |
| [pandas-70526](https://github.com/pandas-dev/pandas/pull/70526) | gemini | BUG: Styler.background_gradient colors NaN as the lowest value when vmin == vmax (GH#47695) (#70526) | hit | hit |
| [pandas-70631](https://github.com/pandas-dev/pandas/pull/70631) | opus | BUG: IntervalIndex raising Cython TypeError for RangeIndex and non-interval EA input (GH#68343) (#70631) | hit | hit |
| [pandas-69446](https://github.com/pandas-dev/pandas/pull/69446) | gemini | BUG: to_excel wrote NaN MultiIndex column label as last level value (GH#62340) (#69446) | hit | hit |
| [pandas-69961](https://github.com/pandas-dev/pandas/pull/69961) | gemini | BUG: honor date formats in OpenpyxlWriter (#69961) | hit | hit |
| [pandas-70404](https://github.com/pandas-dev/pandas/pull/70404) | sol | BUG: parallel read_csv raised on a quoted newline at a chunk boundary (#70404) | miss | hit |
| [pandas-70515](https://github.com/pandas-dev/pandas/pull/70515) | sol | BUG: Series.mode(dropna=False) raising TypeError for boolean dtype (#70515) | miss | hit |
| [pandas-70493](https://github.com/pandas-dev/pandas/pull/70493) | opus | BUG: hash_pandas_object raised on mixed-type values with non-ASCII bytes (GH#27215) (#70493) | hit | hit |
| [pandas-69445](https://github.com/pandas-dev/pandas/pull/69445) | sol | BUG: retain DatetimeIndex freq in concat regardless of input order (GH#64253) (#69445) | hit | hit |
| [pandas-70403](https://github.com/pandas-dev/pandas/pull/70403) | sol | BUG: parallel read_csv lost or added a row after a bare CR in the header (#70403) | hit | hit |
| [pandas-70228](https://github.com/pandas-dev/pandas/pull/70228) | sol | BUG: bar subplots draw date labels on inner shared-x axes (follow-up to GH#62992) (#70228) | hit | hit |
| [pandas-69026](https://github.com/pandas-dev/pandas/pull/69026) | opus | BUG: replace silently discards a compiled regex on ArrowDtype strings (#69026) | hit | hit |
| [pandas-68929](https://github.com/pandas-dev/pandas/pull/68929) | gemini | BUG: DataFrame.clip with an extension-dtype array/Index bound degrades to object (#68929) | miss | hit |
| [pandas-70405](https://github.com/pandas-dev/pandas/pull/70405) | opus | BUG: read_csv ignored encoding_errors for text buffers on the C and pyarrow engines (#70405) | hit | hit |
| [pandas-68637](https://github.com/pandas-dev/pandas/pull/68637) | gemini | BUG: treat an iterator as scalar-like in Categorical comparisons (GH#31646) (#68637) | hit | hit |
| [pandas-70300](https://github.com/pandas-dev/pandas/pull/70300) | opus | BUG: isin on pyarrow dtypes raising for mixed values (#70300) | hit | hit |
| [scikit-learn-35042](https://github.com/scikit-learn/scikit-learn/pull/35042) | gemini | FIX Fix `from sklearn.model_selection import *` (#35042) | hit | hit |
| [scikit-learn-34965](https://github.com/scikit-learn/scikit-learn/pull/34965) | opus | FIX SpectralEmbedding to work with sparse array backend with large indices  (#34965) | hit | hit |
| [scikit-learn-35043](https://github.com/scikit-learn/scikit-learn/pull/35043) | sol | FIX divide by zero in linesearch of newton solver (#35043) | hit | hit |
| [scikit-learn-34513](https://github.com/scikit-learn/scikit-learn/pull/34513) | opus | Fix Pandas output path fails to reject infinite values during transform   (#34513) | hit | hit |
| [scikit-learn-34959](https://github.com/scikit-learn/scikit-learn/pull/34959) | opus | MNT Fix _weighted_percentile with nans and average=True (#34959) | hit | hit |
| [scikit-learn-34837](https://github.com/scikit-learn/scikit-learn/pull/34837) | sol | MNT Don't cache the signature of the bound callback hook (#34837) | hit | hit |
| [scikit-learn-34779](https://github.com/scikit-learn/scikit-learn/pull/34779) | sol | FIX array API classification metrics with pandas  labels (#34779) | hit | hit |
| [scikit-learn-34746](https://github.com/scikit-learn/scikit-learn/pull/34746) | gemini | FIX Have progressbar timers stop when task is finished in meta-estimators. (#34746) | miss | hit |
| [scikit-learn-34475](https://github.com/scikit-learn/scikit-learn/pull/34475) | sol | FIX LinearDiscriminantAnalysis support for mixed namespace/device array API inputs (#34475) | miss | hit |
| [scikit-learn-34605](https://github.com/scikit-learn/scikit-learn/pull/34605) | gemini | FIX indexable with dataframes (#34605) | hit | hit |
| [scikit-learn-34480](https://github.com/scikit-learn/scikit-learn/pull/34480) | gemini | FIX PoissonRegressor mixed namespace/device array API inputs (#34480) | miss | miss |
| [scikit-learn-34263](https://github.com/scikit-learn/scikit-learn/pull/34263) | opus | FIX Set default transform_input of Pipeline to ["X_val"] (#34263) | miss | miss |
| [scikit-learn-34188](https://github.com/scikit-learn/scikit-learn/pull/34188) | sol | Fix metadata routed to correct consumer in `BaggingClassifier.predict_proba` (#34188) | hit | hit |
| [scikit-learn-34051](https://github.com/scikit-learn/scikit-learn/pull/34051) | opus | FIX check_array with narwhals.DataFrame input (#34051) | miss | hit |
| [scikit-learn-33260](https://github.com/scikit-learn/scikit-learn/pull/33260) | gemini | MNT Fix NMF error with SciPy dev after SVD output memory layout change (#33260) | hit | hit |
| [pydantic-13912](https://github.com/pydantic/pydantic/pull/13912) | gemini | Handle OS errors during `ZoneInfo` validation (#13912) | hit | hit |
| [pydantic-13892](https://github.com/pydantic/pydantic/pull/13892) | gemini | Don't apply `ser_json_timedelta` to all datetime types in serialization inference (#13892) | hit | hit |
| [pydantic-13825](https://github.com/pydantic/pydantic/pull/13825) | sol | Do not mutate `model_config` attribute (#13825) | hit | hit |
| [pydantic-13850](https://github.com/pydantic/pydantic/pull/13850) | opus | Catch `OverflowError` during `ByteSize` validation (#13850) | hit | hit |
| [pydantic-13785](https://github.com/pydantic/pydantic/pull/13785) | sol | Fix race conditions in freethreaded build (#13785) | hit | hit |
| [pydantic-13767](https://github.com/pydantic/pydantic/pull/13767) | sol | Fix Mypy plugin crash with import cycle (#13767) | hit | hit |
| [pydantic-13711](https://github.com/pydantic/pydantic/pull/13711) | sol | Don't apply serialization temporal formats to validation JSON schemas (#13711) | hit | hit |
| [pydantic-13702](https://github.com/pydantic/pydantic/pull/13702) | opus | Do not drop include/exclude if serializer wasn't called (#13702) | hit | hit |
| [pydantic-13629](https://github.com/pydantic/pydantic/pull/13629) | opus | Fix missing GC traversal in `pydantic-core` for `GeneralFieldsSerializer` (#13629) | hit | hit |
| [pydantic-13604](https://github.com/pydantic/pydantic/pull/13604) | opus | Fix support for callable discriminators with PEP 695 type aliases (#13604) | hit | hit |
| [pydantic-13552](https://github.com/pydantic/pydantic/pull/13552) | gemini | Avoid double-wrapping polymorphism trampoline for model serializers (#13552) | miss | hit |
| [pydantic-13537](https://github.com/pydantic/pydantic/pull/13537) | gemini | Fix `SecretStr` equality comparison raising `TypeError` on non-ASCII values (#13537) | hit | hit |
| [pydantic-13515](https://github.com/pydantic/pydantic/pull/13515) | gemini | Don't error on unhashable generic arguments on generic Pydantic models (#13515) | hit | miss |
| [pydantic-13452](https://github.com/pydantic/pydantic/pull/13452) | opus | Fix `Interval` zero bounds silently dropped in pipeline API (#13452) | hit | hit |
| [pydantic-13436](https://github.com/pydantic/pydantic/pull/13436) | sol | Do not ignore timezone offset when using `'seconds'/'milliseconds'` `temporal_mode` (#13436) | hit | hit |
