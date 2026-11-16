#!/bin/bash
# Run in the session worktree after the last prompt. The pull request's own tests as merged (8d383877adbc)
# replace whatever the session left in those files: each is put back to the base, then the merged change to it is
# applied. The last line is PASS or FAIL with pytest's summary.
for f in 'tests/data/test_evaluation_dataset.py' 'tests/data/test_huggingface_dataset_and_source.py'; do git checkout -q 1bb65f1c6 -- "$f" 2>/dev/null || rm -f "$f"; done
git apply --whitespace=nowarn - <<'GOLD_TESTS_EOF' || { echo "FAIL | could not install the gold tests"; exit 0; }
diff --git a/tests/data/test_evaluation_dataset.py b/tests/data/test_evaluation_dataset.py
index 256bbc03a51b1..dbb3a1af47623 100644
--- a/tests/data/test_evaluation_dataset.py
+++ b/tests/data/test_evaluation_dataset.py
@@ -1,10 +1,21 @@
 import numpy as np
 import pytest
 
-from mlflow.data.evaluation_dataset import convert_data_to_mlflow_dataset
+import mlflow
+from mlflow.data.evaluation_dataset import (
+    _hash_array_like_obj_as_bytes,
+    convert_data_to_mlflow_dataset,
+)
 from mlflow.exceptions import MlflowException
 
 
+def _ragged_array(rows):
+    # np.array() can't build an object array of uneven-length arrays directly.
+    arr = np.empty(len(rows), dtype=object)
+    arr[:] = [np.array(row) for row in rows]
+    return arr
+
+
 @pytest.mark.parametrize("data", [[[1], [2], [3]], [1, 2, 3]])
 def test_convert_list_data_with_numpy_targets(data):
     targets = np.array([1, 2, 3])
@@ -36,3 +47,39 @@ def test_convert_empty_list_uses_standard_evaluation_dataset_validation():
 
     with pytest.raises(MlflowException, match="2-dimensional"):
         dataset.to_evaluation_dataset()
+
+
+@pytest.mark.parametrize(
+    ("rows_a", "rows_b"),
+    [
+        ([[{"a": 1}, {"a": 2}], [{"a": 3}]], [[{"a": 1}], [{"a": 2}, {"a": 3}]]),
+        ([[1, 2], [3]], [[1], [2, 3]]),
+    ],
+)
+def test_hash_array_like_obj_as_bytes_with_ragged_nested_arrays(rows_a, rows_b):
+    hash_a = _hash_array_like_obj_as_bytes(_ragged_array(rows_a))
+
+    assert hash_a == _hash_array_like_obj_as_bytes(_ragged_array(rows_a))
+    assert hash_a != _hash_array_like_obj_as_bytes(_ragged_array(rows_b))
+
+
+@pytest.mark.parametrize("missing_idx", [0, 1])
+@pytest.mark.parametrize("missing", [None, float("nan")])
+def test_hash_array_like_obj_as_bytes_with_ragged_nested_arrays_and_missing_rows(
+    missing, missing_idx
+):
+    data = _ragged_array([[{"a": 1}, {"a": 2}], [{"a": 3}]])
+    data[missing_idx] = missing
+
+    assert _hash_array_like_obj_as_bytes(data) == _hash_array_like_obj_as_bytes(data.copy())
+
+
+def test_from_numpy_with_ragged_nested_targets():
+    features = np.array([[1], [2]])
+    targets_a = _ragged_array([[{"a": 1}, {"a": 2}], [{"a": 3}]])
+    targets_b = _ragged_array([[{"a": 1}], [{"a": 2}, {"a": 3}]])
+
+    eval_dataset_a = mlflow.data.from_numpy(features, targets=targets_a).to_evaluation_dataset()
+    eval_dataset_b = mlflow.data.from_numpy(features, targets=targets_b).to_evaluation_dataset()
+
+    assert eval_dataset_a.hash != eval_dataset_b.hash
diff --git a/tests/data/test_huggingface_dataset_and_source.py b/tests/data/test_huggingface_dataset_and_source.py
index 36bd0cea55438..53012b6671b38 100644
--- a/tests/data/test_huggingface_dataset_and_source.py
+++ b/tests/data/test_huggingface_dataset_and_source.py
@@ -275,6 +275,44 @@ def test_to_evaluation_dataset():
     assert np.array_equal(evaluation_dataset.labels_data, dataset.ds.to_pandas()["label"].values)
 
 
+def test_to_evaluation_dataset_with_nested_variable_length_arrays():
+    data = {
+        "id": ["1", "2"],
+        "expected_results": [
+            [
+                {
+                    "id": "1",
+                    "text": (
+                        "The main idea of the document is to provide an overview of the project."
+                    ),
+                },
+                {
+                    "id": "2",
+                    "text": (
+                        "The expected outcomes of the project were to gain insights and "
+                        "develop a robust solution."
+                    ),
+                },
+            ],
+            [
+                {
+                    "id": "3",
+                    "text": "Another result.",
+                }
+            ],
+        ],
+    }
+
+    ds = datasets.Dataset.from_dict(data)
+    dataset = mlflow.data.from_huggingface(ds, targets="expected_results")
+
+    evaluation_dataset = dataset.to_evaluation_dataset()
+    evaluation_dataset_2 = dataset.to_evaluation_dataset()
+
+    assert isinstance(evaluation_dataset, EvaluationDataset)
+    assert evaluation_dataset.hash == evaluation_dataset_2.hash
+
+
 def test_from_huggingface_dataset_with_sample_source():
     source_uri = "test:/my/test/uri"
     source = SampleDatasetSource._resolve(source_uri)
GOLD_TESTS_EOF
OUT=$(PYTHONPATH=. /Users/yoavshmariahu/src/thinker/bench/repos/mlflow-venv/bin/python -m pytest -q -x -p no:cacheprovider 'tests/data/test_evaluation_dataset.py' 'tests/data/test_huggingface_dataset_and_source.py' 2>&1); CODE=$?
[ $CODE = 0 ] && echo "PASS | $(echo "$OUT" | tail -1)" || echo "FAIL | $(echo "$OUT" | tail -1)"
