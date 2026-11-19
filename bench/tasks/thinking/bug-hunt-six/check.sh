#!/bin/bash
# Run in the session worktree after the last prompt. Six real fixes' own tests as merged (#26171, #26172, #26180,
# #26130, #26244, #26245; the database-only file tests/db/ left out) replace whatever the session left in those
# files: each is put back to the base (569176474), then the merged changes to it are applied. Only the tests those
# pull requests added or changed are run. Checked 2026-11-17: 31 fail at the base, all pass with the six fixes.
# The last line is PASS or FAIL with pytest's summary.
for f in tests/entities/test_prompt.py tests/genai/scorers/test_scorer_utils.py tests/store/tracking/sqlalchemy_store/test_sqlalchemy_store_traces.py tests/tracing/test_fluent.py tests/utils/test_search_utils.py tests/entities/test_logged_model.py; do git checkout -q 569176474 -- "$f" 2>/dev/null || rm -f "$f"; done
git apply --whitespace=nowarn - <<'GOLD_TESTS_EOF' || { echo "FAIL | could not install the gold tests"; exit 0; }
diff --git a/tests/tracing/test_fluent.py b/tests/tracing/test_fluent.py
index 858b09562..50c960a3c 100644
--- a/tests/tracing/test_fluent.py
+++ b/tests/tracing/test_fluent.py
@@ -2024,6 +2024,7 @@ def test_span_record_exception_with_string():
 
     # Verify span status is ERROR
     assert test_span.status.status_code == SpanStatusCode.ERROR
+    assert test_span.status.description == "Exception: Something went wrong"
 
     # Verify exception event was added
     exception_events = [event for event in test_span.events if "exception" in event.name.lower()]
diff --git a/tests/genai/scorers/test_scorer_utils.py b/tests/genai/scorers/test_scorer_utils.py
index 387ef9b29..50527d376 100644
--- a/tests/genai/scorers/test_scorer_utils.py
+++ b/tests/genai/scorers/test_scorer_utils.py
@@ -189,6 +189,17 @@ def test_signature_with_defaults():
     assert recreated(2, 3) == 8  # 2^3
 
 
+def test_signature_with_parentheses_in_defaults():
+    source = "return sep.join(parts) + suffix"
+    signature = "(parts=('a', 'b'), sep=str('-'), suffix=')') -> str"
+    func_name = "join_parts"
+
+    recreated = recreate_function(source, signature, func_name)
+
+    assert recreated() == "a-b)"
+    assert recreated(("x", "y"), "+", "") == "x+y"
+
+
 def test_complex_signature():
     source = """if data is None:
     data = []
diff --git a/tests/utils/test_search_utils.py b/tests/utils/test_search_utils.py
index 7da2ae59d..6c27cdf6e 100644
--- a/tests/utils/test_search_utils.py
+++ b/tests/utils/test_search_utils.py
@@ -9,6 +9,7 @@ from mlflow.entities import (
     DatasetInput,
     InputTag,
     LifecycleStage,
+    LoggedModel,
     Metric,
     Param,
     Run,
@@ -23,7 +24,16 @@ from mlflow.entities import (
 from mlflow.entities.trace_info import TraceInfo
 from mlflow.exceptions import MlflowException
 from mlflow.utils.mlflow_tags import MLFLOW_DATASET_CONTEXT
-from mlflow.utils.search_utils import SearchTraceUtils, SearchUtils
+from mlflow.utils.search_utils import (
+    SearchEvaluationDatasetsUtils,
+    SearchExperimentsUtils,
+    SearchLoggedModelsUtils,
+    SearchMCPAccessEndpointUtils,
+    SearchMCPServerUtils,
+    SearchMCPServerVersionUtils,
+    SearchTraceUtils,
+    SearchUtils,
+)
 
 
 @pytest.mark.parametrize(
@@ -100,7 +110,7 @@ from mlflow.utils.search_utils import SearchTraceUtils, SearchUtils
         ),
         (
             "attribute.start_time >= 1234",
-            [{"type": "attribute", "comparator": ">=", "key": "start_time", "value": "1234"}],
+            [{"type": "attribute", "comparator": ">=", "key": "start_time", "value": 1234}],
         ),
         (
             "run.status = 'RUNNING'",
@@ -139,6 +149,60 @@ def test_filter(filter_string, parsed_filter):
     assert SearchUtils.parse_search_filter(filter_string) == parsed_filter
 
 
+@pytest.mark.parametrize(
+    ("search_utils", "filter_string"),
+    [
+        (SearchUtils, "attributes.start_time > 1234"),
+        (SearchExperimentsUtils, "creation_time > 1234"),
+        (SearchEvaluationDatasetsUtils, "created_time > 1234"),
+        (SearchLoggedModelsUtils, "creation_timestamp > 1234"),
+        (SearchMCPServerUtils, "created_at > 1234"),
+        (SearchMCPServerVersionUtils, "created_at > 1234"),
+        (SearchMCPAccessEndpointUtils, "created_at > 1234"),
+    ],
+)
+def test_numeric_attribute_values_are_parsed_as_integers(search_utils, filter_string):
+    [condition] = search_utils.parse_search_filter(filter_string)
+
+    assert condition["value"] == 1234
+    assert isinstance(condition["value"], int)
+
+
+def test_float_numeric_attribute_value_is_parsed_as_float():
+    [condition] = SearchUtils.parse_search_filter("attributes.start_time > 1234.5")
+
+    assert condition["value"] == 1234.5
+    assert isinstance(condition["value"], float)
+
+
+@pytest.mark.parametrize(
+    ("filter_string", "expected_model_ids"),
+    [
+        ("creation_timestamp = 1.5", []),
+        ("creation_timestamp > 1.5", ["model-2"]),
+        ("creation_timestamp >= 1.5", ["model-2"]),
+    ],
+)
+def test_float_numeric_attribute_is_not_truncated_for_logged_models(
+    filter_string, expected_model_ids
+):
+    models = [
+        LoggedModel(
+            experiment_id="0",
+            model_id=f"model-{timestamp}",
+            name=f"model-{timestamp}",
+            artifact_location=f"file:///tmp/model-{timestamp}",
+            creation_timestamp=timestamp,
+            last_updated_timestamp=timestamp,
+        )
+        for timestamp in (1, 2)
+    ]
+
+    filtered = SearchLoggedModelsUtils.filter_logged_models(models, filter_string)
+
+    assert [model.model_id for model in filtered] == expected_model_ids
+
+
 @pytest.mark.parametrize(
     ("filter_string", "parsed_filter"),
     [
@@ -473,6 +537,7 @@ def test_filter_runs_by_start_time():
     assert SearchUtils.filter(runs, "attribute.start_time >= 0") == runs
     assert SearchUtils.filter(runs, "attribute.start_time > 1") == runs[2:]
     assert SearchUtils.filter(runs, "attribute.start_time = 2") == runs[2:]
+    assert SearchUtils.filter(runs, "attribute.start_time = 1.5") == []
 
 
 def test_filter_runs_by_user_id():
diff --git a/tests/store/tracking/sqlalchemy_store/test_sqlalchemy_store_traces.py b/tests/store/tracking/sqlalchemy_store/test_sqlalchemy_store_traces.py
index 619729f0d..418c2f2fb 100644
--- a/tests/store/tracking/sqlalchemy_store/test_sqlalchemy_store_traces.py
+++ b/tests/store/tracking/sqlalchemy_store/test_sqlalchemy_store_traces.py
@@ -78,7 +78,7 @@ from mlflow.tracing.constant import (
     TraceSizeStatsKey,
     TraceTagKey,
 )
-from mlflow.tracing.utils import TraceJSONEncoder
+from mlflow.tracing.utils import TraceJSONEncoder, dump_span_attribute_value
 from mlflow.utils.file_utils import TempDir, local_file_uri_to_path
 from mlflow.utils.mlflow_tags import MLFLOW_ARTIFACT_LOCATION
 from mlflow.utils.time import get_current_time_millis
@@ -907,6 +907,42 @@ def test_search_traces_with_full_text_filter(store: SqlAlchemyStore):
     assert traces[0].trace_id == trace3_id
 
 
+@pytest.mark.skipif(IS_MSSQL, reason="MSSQL stores span content with non-ASCII escaped.")
+@pytest.mark.parametrize("text", ["café", "¿Qué es MLflow?", "什么是MLflow", "🚀 launch"])
+@pytest.mark.parametrize("key", ["trace.text", "span.content"])
+def test_search_traces_with_full_text_filter_non_ascii(store: SqlAlchemyStore, key, text):
+    exp_id = store.create_experiment("test_non_ascii_text_search")
+    trace_id = "trace_non_ascii"
+    _create_trace(store, trace_id, exp_id)
+    _create_trace(store, "trace_ascii", exp_id)
+
+    def make_span(trace_id, span_id, inputs):
+        # Serialize inputs the way the tracing SDK does, rather than with `json.dumps`
+        # defaults like `create_test_span`, which would already escape non-ASCII text.
+        otel_span = OTelReadableSpan(
+            name="chat",
+            context=create_mock_span_context(12345, span_id),
+            attributes={
+                SpanAttributeKey.REQUEST_ID: json.dumps(trace_id),
+                SpanAttributeKey.SPAN_TYPE: json.dumps("LLM"),
+                SpanAttributeKey.INPUTS: dump_span_attribute_value(inputs),
+            },
+            start_time=1_000_000_000,
+            end_time=2_000_000_000,
+            resource=_OTelResource.get_empty(),
+        )
+        return create_mlflow_span(otel_span, trace_id, "LLM")
+
+    store.log_spans(exp_id, [make_span(trace_id, 111, {"question": text})])
+    store.log_spans(exp_id, [make_span("trace_ascii", 222, {"question": "ascii only"})])
+
+    for comparator in ("LIKE", "ILIKE"):
+        traces, _ = store.search_traces([exp_id], filter_string=f'{key} {comparator} "%{text}%"')
+        assert [t.trace_id for t in traces] == [trace_id]
+
+    assert store.get_trace(trace_id).data.spans[0].inputs == {"question": text}
+
+
 def test_search_traces_with_invalid_span_attribute(store: SqlAlchemyStore):
     exp_id = store.create_experiment("test_span_error")
 
diff --git a/tests/entities/test_logged_model.py b/tests/entities/test_logged_model.py
new file mode 100644
index 000000000..522ebb624
--- /dev/null
+++ b/tests/entities/test_logged_model.py
@@ -0,0 +1,18 @@
+from mlflow.entities import LoggedModel, LoggedModelStatus
+
+
+def test_logged_model_proto_round_trip_keeps_status_message():
+    model = LoggedModel(
+        experiment_id="1",
+        model_id="m-123",
+        name="model",
+        artifact_location="file:///tmp/model",
+        creation_timestamp=1,
+        last_updated_timestamp=2,
+        status=LoggedModelStatus.FAILED,
+        status_message="Upload failed",
+    )
+
+    proto = model.to_proto()
+    assert proto.info.status_message == "Upload failed"
+    assert LoggedModel.from_proto(proto).status_message == "Upload failed"
diff --git a/tests/entities/test_prompt.py b/tests/entities/test_prompt.py
index be4d9f925..870e7910a 100644
--- a/tests/entities/test_prompt.py
+++ b/tests/entities/test_prompt.py
@@ -201,6 +201,22 @@ def test_prompt_with_model_config_dict():
     assert prompt_without_config.model_config is None
 
 
+def test_prompt_does_not_mutate_caller_tags():
+    tags = {"author": "alice"}
+    PromptVersion(
+        name="my_prompt",
+        version=1,
+        template="Hello, {{name}}!",
+        tags=tags,
+        model_config={"temperature": 0.7},
+    )
+    assert tags == {"author": "alice"}
+
+    prompt = PromptVersion(name="my_prompt", version=2, template="Hi!", tags=tags)
+    assert prompt.model_config is None
+    assert prompt.tags == {"author": "alice"}
+
+
 def test_prompt_with_model_config_instance():
     config = PromptModelConfig(model_name="gpt-5", temperature=0.7, max_tokens=1000)
     prompt = PromptVersion(
GOLD_TESTS_EOF
K="test_signature_with_parentheses_in_defaults or test_numeric_attribute_values_are_parsed_as_integers or test_float_numeric_attribute or test_search_traces_with_full_text_filter_non_ascii or test_logged_model_proto_round_trip_keeps_status_message or test_prompt_does_not_mutate_caller_tags or record_exception"
OUT=$(PYTHONPATH=. /Users/yoavshmariahu/src/thinker/bench/repos/mlflow-venv/bin/python -m pytest -q -p no:cacheprovider tests/entities/test_logged_model.py tests/entities/test_prompt.py tests/genai/scorers/test_scorer_utils.py tests/tracing/test_fluent.py tests/utils/test_search_utils.py tests/store/tracking/sqlalchemy_store/test_sqlalchemy_store_traces.py -k "$K" 2>&1); CODE=$?
[ $CODE = 0 ] && echo "PASS | $(echo "$OUT" | tail -1)" || echo "FAIL | $(echo "$OUT" | tail -1)"
