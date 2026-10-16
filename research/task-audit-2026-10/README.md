# Do the graders test what the request asks? (2026-10-16)

The 29 test-graded tasks in Artemis (mlflow-b2-hard 13, grafana-hard 16), audited assertion by assertion against
the request the agent is given: STATED (follows from the request), INFERABLE (the existing code decides it: a
sibling implementation, a convention), HIDDEN (pins a choice the request leaves open: a message, a shape, a
counting rule), UNPASSABLE (the tests compile against new names or signatures the request never gives). Read by
two agents from the stored gold diffs and the code at base (`mlflow-audit.json`, `grafana-audit.json`); the
mlflow verdicts were checked against the failures diagnosed by hand, and Grafana PR133206 and PR133300 by reading
the tests.

| set | clean | inferable | hidden | unpassable |
|---|---|---|---|---|
| mlflow-b2-hard (13) | 3: PR26252, PR26269, PR26291 | 3: PR26265, PR26300, PR26327 | 5: PR26270, PR26307, PR26311, PR26369, PR26442 | 2: PR26225, PR26267 |
| grafana-hard (16) | 0 | 0 | 4: PR132983, PR133112, PR133206, PR133251 | 12 |

Every mlflow session result fits: the tasks that always failed in mlflow-b2-astra-served5 are unpassable (PR26225)
or hidden (PR26270, PR26311, PR26442); the ones that always passed are clean (PR26269) or inferable (PR26300). In
the unpassable Grafana tasks the behavior asked for is mostly stated; the tests fail to compile without new private
names and changed signatures (and Artemis's testNeedsGoldSymbols check misses some, e.g. PR132983, PR133220).
Pass rates on these sets measure, for most tasks, whether the agent guessed the merged patch's unstated choices.
Six tasks (mlflow's clean and inferable ones) grade only what the request states or the code decides.
