#!/bin/bash
# Run in the session worktree after the last prompt. Eleven reports, twelve real fixes' own tests as merged
# (mlflow #26171, #26172, #26180, #26130, #26244, #26245, #26109, #26181, #26192, #26204, #26007, #26283; the
# database-only file tests/db/ left out) replace whatever the session left in those files: each is put back to the
# base (569176474), then the merged changes to it are applied. Only the tests those pull requests added or changed
# are run. Checked 2026-11-17 on the base and with the twelve fixes applied (the figures are in the commit).
# The last line is PASS or FAIL with pytest's summary.
for f in tests/cli/test_traces.py tests/entities/test_logged_model.py tests/entities/test_prompt.py tests/entities/test_trace.py tests/gateway/providers/test_gemini.py tests/genai/scorers/test_scorer_utils.py tests/openai/mock_openai.py tests/openai/test_openai_autolog.py tests/pyfunc/test_pyfunc_schema_enforcement.py tests/store/tracking/sqlalchemy_store/test_sqlalchemy_store_traces.py tests/tracing/test_fluent.py tests/utils/test_search_utils.py; do git checkout -q 569176474 -- "$f" 2>/dev/null || rm -f "$f"; done
git apply --whitespace=nowarn - <<'GOLD_TESTS_EOF' || { echo "FAIL | could not install the gold tests"; exit 0; }
diff --git a/tests/cli/test_traces.py b/tests/cli/test_traces.py
index bcc88ec50..8f62c2ec4 100644
--- a/tests/cli/test_traces.py
+++ b/tests/cli/test_traces.py
@@ -118,6 +118,19 @@ def test_search_command_with_fields(runner):
         assert "OK" in result.output
 
 
+def test_search_command_strips_spaces_in_order_by(runner):
+    with mock.patch("mlflow.cli.traces.TracingClient") as mock_client:
+        mock_client.return_value.search_traces.return_value = PagedList([], None)
+        result = runner.invoke(
+            commands,
+            ["search", "--experiment-id", "1", "--order-by", "timestamp_ms DESC, status"],
+        )
+
+    assert result.exit_code == 0
+    _, kwargs = mock_client.return_value.search_traces.call_args
+    assert kwargs["order_by"] == ["timestamp_ms DESC", "status"]
+
+
 def test_get_command_with_fields(runner):
     trace_location = TraceLocation(
         type=TraceLocationType.MLFLOW_EXPERIMENT,
@@ -158,6 +171,19 @@ def test_delete_command(runner):
         assert "Deleted 5 trace(s)" in result.output
 
 
+def test_delete_command_strips_spaces_in_trace_ids(runner):
+    with mock.patch("mlflow.cli.traces.TracingClient") as mock_client:
+        mock_client.return_value.delete_traces.return_value = 2
+        result = runner.invoke(
+            commands,
+            ["delete", "--experiment-id", "1", "--trace-ids", "tr-1, tr-2"],
+        )
+
+    assert result.exit_code == 0
+    _, kwargs = mock_client.return_value.delete_traces.call_args
+    assert kwargs["trace_ids"] == ["tr-1", "tr-2"]
+
+
 def test_field_validation_error(runner):
     trace_location = TraceLocation(
         type=TraceLocationType.MLFLOW_EXPERIMENT,
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
diff --git a/tests/entities/test_trace.py b/tests/entities/test_trace.py
index 817fcc2c7..dffe2219d 100644
--- a/tests/entities/test_trace.py
+++ b/tests/entities/test_trace.py
@@ -590,3 +590,19 @@ def test_trace_from_dict_load_old_trace():
     assert trace.data.spans[0].outputs == "def"
     assert trace.data.spans[0].start_time_ns == 1761106494524157000
     assert trace.data.spans[0].end_time_ns == 1761106494584860000
+
+
+def test_trace_repr_and_trace_id():
+    trace_info = create_test_trace_info("tr-12345")
+    trace = Trace(info=trace_info, data=TraceData())
+
+    # Verify repr outputs valid Python representation with quotes
+    assert repr(trace) == "Trace(trace_id='tr-12345')"
+
+    # Verify trace_id property matches trace.info.trace_id
+    assert trace.trace_id == "tr-12345"
+    assert trace.trace_id == trace.info.trace_id
+
+    # Verify defensive repr when info is None
+    trace_no_info = Trace(info=None, data=TraceData())
+    assert repr(trace_no_info) == "Trace(trace_id=None)"
diff --git a/tests/gateway/providers/test_gemini.py b/tests/gateway/providers/test_gemini.py
index c8352703d..bffaee470 100644
--- a/tests/gateway/providers/test_gemini.py
+++ b/tests/gateway/providers/test_gemini.py
@@ -1070,6 +1070,49 @@ def test_gemini_function_call_thought_signature_response(part):
     assert choice.message.tool_calls[0].thought_signature == "sig_token"
 
 
+def _mixed_parts_response(parts):
+    return {
+        "candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
+        "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
+    }
+
+
+_TEXT_PART = {"text": "Let me look that up."}
+_CALL_PART = {"functionCall": {"name": "get_weather", "args": {"city": "Baku"}, "id": "call_1"}}
+
+
+@pytest.mark.parametrize(
+    "parts",
+    [[_TEXT_PART, _CALL_PART], [_CALL_PART, _TEXT_PART]],
+    ids=["text-then-call", "call-then-text"],
+)
+def test_gemini_chat_mixed_text_and_function_call_parts(parts):
+    config = EndpointConfig(**chat_config())
+    resp = GeminiAdapter.model_to_chat(_mixed_parts_response(parts), config)
+
+    message = resp.choices[0].message
+    assert message.content == "Let me look that up."
+    assert [(c.id, c.function.name, c.function.arguments) for c in message.tool_calls] == [
+        ("call_1", "get_weather", '{"city": "Baku"}')
+    ]
+
+
+@pytest.mark.parametrize(
+    "parts",
+    [[_TEXT_PART, _CALL_PART], [_CALL_PART, _TEXT_PART]],
+    ids=["text-then-call", "call-then-text"],
+)
+def test_gemini_chat_streaming_mixed_text_and_function_call_parts(parts):
+    config = EndpointConfig(**chat_config())
+    resp = GeminiAdapter.model_to_chat_streaming(_mixed_parts_response(parts), config)
+
+    delta = resp.choices[0].delta
+    assert delta.content == "Let me look that up."
+    assert [(c.id, c.function.name, c.function.arguments) for c in delta.tool_calls] == [
+        ("call_1", "get_weather", '{"city": "Baku"}')
+    ]
+
+
 def chat_stream_response():
     return [
         b'data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":null}],"'
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
diff --git a/tests/openai/mock_openai.py b/tests/openai/mock_openai.py
index 1fd9aa935..3fa3293a4 100644
--- a/tests/openai/mock_openai.py
+++ b/tests/openai/mock_openai.py
@@ -12,6 +12,7 @@ from mlflow.types.chat import ChatCompletionRequest
 EMPTY_CHOICES = "EMPTY_CHOICES"
 LIST_CONTENT = "LIST_CONTENT"
 AZURE_ANNOTATIONS = "AZURE_ANNOTATIONS"
+EMPTY_STREAM = "EMPTY_STREAM"
 
 app = fastapi.FastAPI()
 
@@ -188,6 +189,8 @@ async def chat(payload: ChatCompletionRequest):
             content = (
                 f"data: {json.dumps(d)}\n\n" async for d in chat_response_stream_empty_choices()
             )
+        elif EMPTY_STREAM == payload.messages[0].content:
+            content = iter(["data: [DONE]\n\n"])
         elif AZURE_ANNOTATIONS == payload.messages[0].content:
             content = (
                 f"data: {json.dumps(d)}\n\n"
diff --git a/tests/openai/test_openai_autolog.py b/tests/openai/test_openai_autolog.py
index 31b893d87..dd642e11f 100644
--- a/tests/openai/test_openai_autolog.py
+++ b/tests/openai/test_openai_autolog.py
@@ -28,7 +28,12 @@ from mlflow.tracing.constant import (
 )
 from mlflow.version import IS_TRACING_SDK_ONLY
 
-from tests.openai.mock_openai import AZURE_ANNOTATIONS, EMPTY_CHOICES, LIST_CONTENT
+from tests.openai.mock_openai import (
+    AZURE_ANNOTATIONS,
+    EMPTY_CHOICES,
+    EMPTY_STREAM,
+    LIST_CONTENT,
+)
 from tests.tracing.helper import get_traces, skip_when_testing_trace_sdk
 
 MOCK_TOOLS = [
@@ -509,6 +514,23 @@ async def test_chat_completions_streaming_empty_choices(client):
     assert trace.info.status == "OK"
 
 
+@pytest.mark.asyncio
+async def test_chat_completions_streaming_no_chunks(client):
+    mlflow.openai.autolog()
+    stream = client.chat.completions.create(
+        messages=[{"role": "user", "content": EMPTY_STREAM}],
+        model="gpt-4o-mini",
+        stream=True,
+    )
+
+    chunks = [chunk async for chunk in await stream] if client._is_async else list(stream)
+    assert chunks == []
+
+    trace = mlflow.get_trace(mlflow.get_last_active_trace_id())
+    assert trace.info.status == "OK"
+    assert trace.data.spans[0].outputs is None
+
+
 @pytest.mark.asyncio
 async def test_chat_completions_streaming_ignores_azure_annotation_chunks(client):
     mlflow.openai.autolog()
diff --git a/tests/pyfunc/test_pyfunc_schema_enforcement.py b/tests/pyfunc/test_pyfunc_schema_enforcement.py
index 2b262ed5e..949655919 100644
--- a/tests/pyfunc/test_pyfunc_schema_enforcement.py
+++ b/tests/pyfunc/test_pyfunc_schema_enforcement.py
@@ -2732,6 +2732,76 @@ def test_pyfunc_model_schema_enforcement_nested_array(data, schema):
     pd.testing.assert_frame_equal(prediction, df)
 
 
+@pytest.mark.parametrize(
+    ("complex_type", "values"),
+    [
+        (Array(DataType.string), [["a"], ["b"], ["c"], ["d"]]),
+        (
+            Object([Property("value", DataType.string)]),
+            [{"value": value} for value in "abcd"],
+        ),
+        (Map(value_type=DataType.string), [{"key": value} for value in "abcd"]),
+    ],
+)
+@pytest.mark.parametrize("named", [False, True])
+@pytest.mark.parametrize(
+    "index", [range(4), pd.Index(["first", "second", "third", "fourth"], name="row_id")]
+)
+def test_pyfunc_model_preserves_nondefault_dataframe_index(complex_type, values, named, index):
+    df = pd.DataFrame({"scalar": [1.0, 2.0, 3.0, 4.0], "complex": values}, index=index)
+    filtered_df = df.iloc[2:]
+    schema = Schema([
+        ColSpec(DataType.double, name="scalar" if named else None),
+        ColSpec(complex_type, name="complex" if named else None),
+    ])
+    model = Model()
+    model.signature = ModelSignature(inputs=schema)
+    pyfunc_model = PyFuncModel(model_meta=model, model_impl=TestModel())
+
+    pd.testing.assert_frame_equal(pyfunc_model.predict(filtered_df), filtered_df)
+
+
+@pytest.mark.parametrize("named", [False, True])
+def test_pyfunc_model_preserves_nondefault_dataframe_index_scalar_only(named):
+    df = pd.DataFrame(
+        {"scalar": [1, 2, 3, 4]},
+        index=pd.Index(["first", "second", "third", "fourth"], name="row_id"),
+        dtype=np.int32,
+    )
+    filtered_df = df.iloc[2:]
+    schema = Schema([ColSpec(DataType.double, name="scalar" if named else None)])
+    model = Model()
+    model.signature = ModelSignature(inputs=schema)
+    pyfunc_model = PyFuncModel(model_meta=model, model_impl=TestModel())
+
+    pd.testing.assert_frame_equal(pyfunc_model.predict(filtered_df), filtered_df.astype(float))
+
+
+@pytest.mark.parametrize("named", [False, True])
+def test_loaded_pyfunc_model_preserves_nondefault_dataframe_index(tmp_path, named):
+    class IdentityModel(mlflow.pyfunc.PythonModel):
+        def predict(self, context, model_input, params=None):
+            return model_input
+
+    df = pd.DataFrame(
+        {"scalar": [3.0, 4.0], "complex": [["c"], ["d"]]},
+        index=pd.Index(["third", "fourth"], name="row_id"),
+    )
+    schema = Schema([
+        ColSpec(DataType.double, name="scalar" if named else None),
+        ColSpec(Array(DataType.string), name="complex" if named else None),
+    ])
+    model_path = tmp_path / "model"
+    mlflow.pyfunc.save_model(
+        path=model_path,
+        python_model=IdentityModel(),
+        signature=ModelSignature(inputs=schema),
+        pip_requirements=["mlflow"],
+    )
+
+    pd.testing.assert_frame_equal(mlflow.pyfunc.load_model(model_path).predict(df), df)
+
+
 @pytest.mark.parametrize(
     ("data", "schema"),
     [
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
GOLD_TESTS_EOF
K="test_signature_with_parentheses_in_defaults or test_numeric_attribute_values_are_parsed_as_integers or test_float_numeric_attribute or test_search_traces_with_full_text_filter_non_ascii or test_logged_model_proto_round_trip_keeps_status_message or test_prompt_does_not_mutate_caller_tags or record_exception or test_delete_command_strips_spaces_in_trace_ids or test_search_command_strips_spaces_in_order_by or mixed_text_and_function_call_parts or preserves_nondefault_dataframe_index or test_trace_repr_and_trace_id or test_chat_completions_streaming_no_chunks"
OUT=$(PYTHONPATH=. /Users/yoavshmariahu/src/thinker/bench/repos/mlflow-venv/bin/python -m pytest -q -p no:cacheprovider tests/cli/test_traces.py tests/entities/test_logged_model.py tests/entities/test_prompt.py tests/entities/test_trace.py tests/gateway/providers/test_gemini.py tests/genai/scorers/test_scorer_utils.py tests/openai/test_openai_autolog.py tests/pyfunc/test_pyfunc_schema_enforcement.py tests/store/tracking/sqlalchemy_store/test_sqlalchemy_store_traces.py tests/tracing/test_fluent.py tests/utils/test_search_utils.py -k "$K" 2>&1); CODE=$?
[ $CODE = 0 ] && echo "PASS | $(echo "$OUT" | tail -1)" || echo "FAIL | $(echo "$OUT" | tail -1)"
