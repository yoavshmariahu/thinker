#!/bin/bash
# Run in the session worktree after the last prompt. The pull request's own tests as merged (785a36ae9a95)
# replace whatever the session left in those files: each is put back to the base, then the merged change to it is
# applied. The last line is PASS or FAIL with pytest's summary.
for f in 'tests/entities/test_span.py'; do git checkout -q 1bb65f1c6 -- "$f" 2>/dev/null || rm -f "$f"; done
git apply --whitespace=nowarn - <<'GOLD_TESTS_EOF' || { echo "FAIL | could not install the gold tests"; exit 0; }
diff --git a/tests/entities/test_span.py b/tests/entities/test_span.py
index a1559fb3ae3c4..17bfd16216349 100644
--- a/tests/entities/test_span.py
+++ b/tests/entities/test_span.py
@@ -1,4 +1,6 @@
+import copy
 import json
+import pickle
 from datetime import datetime
 from unittest import mock
 
@@ -16,10 +18,12 @@
 import mlflow
 from mlflow.entities import LiveSpan, Span, SpanEvent, SpanStatus, SpanStatusCode, SpanType
 from mlflow.entities.span import (
+    LazySpan,
     NoOpSpan,
     create_mlflow_span,
 )
 from mlflow.exceptions import MlflowException
+from mlflow.tracing.attachments import Attachment
 from mlflow.tracing.constant import TRACE_ID_V4_PREFIX
 from mlflow.tracing.provider import _get_tracer, trace_disabled
 from mlflow.tracing.utils import build_otel_context, encode_span_id, encode_trace_id
@@ -1574,3 +1578,151 @@ def test_span_get_raises_helpful_attribute_error():
         _ = noop_span.get
     with pytest.raises(AttributeError, match=expected_pattern):
         noop_span.get("name")
+
+
+_CLONE_OPS = [
+    copy.deepcopy,
+    lambda x: pickle.loads(pickle.dumps(x)),
+]
+
+
+@pytest.mark.parametrize("clone", _CLONE_OPS)
+def test_span_deepcopy_and_pickle(clone):
+    att = Attachment(content_type="image/png", content_bytes=b"fake-image-bytes")
+    with mlflow.start_span("test_span", span_type=SpanType.LLM) as live_span:
+        live_span.set_inputs({"prompt": "hello", "image": att})
+        live_span.set_outputs({"response": "world"})
+        live_span.set_attributes({"model": "gpt-4", "custom_attr": 42})
+        live_span.add_event(SpanEvent("test_event", 123456789, {"event_key": "val"}))
+
+    span = live_span.to_immutable_span()
+    assert att.id in span._attachments
+
+    cloned_span = clone(span)
+    assert isinstance(cloned_span, Span)
+    assert cloned_span is not span
+    assert cloned_span.to_dict() == span.to_dict()
+    assert cloned_span.name == span.name
+    assert cloned_span.inputs == span.inputs
+    assert cloned_span.outputs == span.outputs
+    assert cloned_span.trace_id == span.trace_id
+    assert cloned_span.span_id == span.span_id
+    assert cloned_span.attributes == span.attributes
+
+    # Mutating clone's attributes should not mutate original
+    cloned_span.attributes["model"] = "gpt-3.5"
+    assert span.attributes["model"] == "gpt-4"
+
+    # Attachment is preserved and decoupled
+    assert att.id in cloned_span._attachments
+    assert cloned_span._attachments[att.id] is not span._attachments[att.id]
+    assert cloned_span._attachments[att.id].content_bytes == b"fake-image-bytes"
+    assert cloned_span._attachments[att.id].content_type == "image/png"
+
+
+def test_span_shallow_copy():
+    with mlflow.start_span("test_span") as live_span:
+        live_span.set_inputs({"prompt": "hello"})
+    span = live_span.to_immutable_span()
+
+    copied_span = copy.copy(span)
+    assert isinstance(copied_span, Span)
+    assert copied_span is not span
+    assert copied_span._span is span._span
+    assert copied_span.to_dict() == span.to_dict()
+
+
+def test_lazy_span_shallow_copy():
+    with mlflow.start_span("lazy_test") as live_span:
+        live_span.set_inputs({"query": "SELECT 1"})
+    span = live_span.to_immutable_span()
+
+    lazy_span = LazySpan(span.to_dict())
+    copied_lazy = copy.copy(lazy_span)
+    assert isinstance(copied_lazy, LazySpan)
+    assert copied_lazy is not lazy_span
+    assert copied_lazy.__dict__["_materialized"] is False
+    assert copied_lazy.inputs == span.inputs
+    assert copied_lazy.__dict__["_materialized"] is True
+
+
+@pytest.mark.parametrize("clone", _CLONE_OPS)
+def test_lazy_span_deepcopy_and_pickle_unmaterialized(clone):
+    with mlflow.start_span("lazy_test", span_type=SpanType.TOOL) as live_span:
+        live_span.set_inputs({"query": "SELECT 1"})
+        live_span.set_outputs({"rows": 1})
+    span = live_span.to_immutable_span()
+
+    lazy_span = LazySpan(span.to_dict())
+    assert lazy_span.__dict__["_materialized"] is False
+
+    cloned_lazy = clone(lazy_span)
+    assert isinstance(cloned_lazy, LazySpan)
+    assert cloned_lazy is not lazy_span
+    assert cloned_lazy.__dict__["_materialized"] is False
+    assert lazy_span.__dict__["_materialized"] is False
+
+    assert cloned_lazy.inputs == span.inputs
+    assert cloned_lazy.__dict__["_materialized"] is True
+    assert cloned_lazy.to_dict() == span.to_dict()
+
+
+def test_live_span_deepcopy_and_pickle_raises():
+    with mlflow.start_span("live_test") as live_span:
+        copied_live = copy.copy(live_span)
+        assert isinstance(copied_live, LiveSpan)
+        assert copied_live is not live_span
+        assert copied_live._span is live_span._span
+
+        err_deepcopy = r"cannot be deepcopied while active\. Call `span\.to_immutable_span\(\)`"
+        with pytest.raises(TypeError, match=rf"'LiveSpan' {err_deepcopy}"):
+            copy.deepcopy(live_span)
+
+        err_pickle = r"cannot be pickled while active\. Call `span\.to_immutable_span\(\)`"
+        with pytest.raises(TypeError, match=rf"'LiveSpan' {err_pickle}"):
+            pickle.dumps(live_span)
+
+
+@pytest.mark.parametrize("clone", _CLONE_OPS)
+def test_lazy_span_deepcopy_and_pickle_materialized(clone):
+    with mlflow.start_span("lazy_mat_test") as live_span:
+        live_span.set_inputs({"data": [1, 2, 3]})
+        live_span.set_outputs({"result": 6})
+    span = live_span.to_immutable_span()
+
+    lazy_span = LazySpan(span.to_dict())
+    _ = lazy_span.inputs
+    assert lazy_span.__dict__["_materialized"] is True
+
+    cloned_lazy = clone(lazy_span)
+    assert isinstance(cloned_lazy, LazySpan)
+    assert cloned_lazy.to_dict() == span.to_dict()
+    assert cloned_lazy.inputs == span.inputs
+
+
+@pytest.mark.parametrize("clone", _CLONE_OPS)
+def test_noop_span_deepcopy_and_pickle(clone):
+    noop = NoOpSpan()
+    cloned_noop = clone(noop)
+    assert isinstance(cloned_noop, NoOpSpan)
+    assert cloned_noop.trace_id == noop.trace_id
+
+
+@pytest.mark.parametrize("clone", _CLONE_OPS)
+def test_trace_deepcopy_and_pickle(clone):
+    with mlflow.start_span("trace_test_root") as root:
+        root.set_inputs({"question": "test deepcopy"})
+        root.set_outputs({"answer": "success"})
+        trace_id = root.trace_id
+
+    trace = mlflow.get_trace(trace_id, flush=True)
+    assert trace is not None
+    assert len(trace.data.spans) == 1
+
+    cloned_trace = clone(trace)
+    assert cloned_trace is not trace
+    assert cloned_trace.trace_id == trace.trace_id
+    assert len(cloned_trace.data.spans) == 1
+    assert cloned_trace.data.spans[0].name == "trace_test_root"
+    assert cloned_trace.data.spans[0].inputs == {"question": "test deepcopy"}
+    assert cloned_trace.data.spans[0].outputs == {"answer": "success"}
GOLD_TESTS_EOF
OUT=$(PYTHONPATH=. /Users/yoavshmariahu/src/thinker/bench/repos/mlflow-venv/bin/python -m pytest -q -x -p no:cacheprovider 'tests/entities/test_span.py' 2>&1); CODE=$?
[ $CODE = 0 ] && echo "PASS | $(echo "$OUT" | tail -1)" || echo "FAIL | $(echo "$OUT" | tail -1)"
