#!/bin/bash
# Run in the session worktree after the last prompt. The pull request's own tests as merged (248e2939ebac)
# replace whatever the session left in those files: each is put back to the base, then the merged change to it is
# applied. The last line is PASS or FAIL with pytest's summary.
for f in 'tests/gateway/providers/test_anthropic.py'; do git checkout -q 1bb65f1c6 -- "$f" 2>/dev/null || rm -f "$f"; done
git apply --whitespace=nowarn - <<'GOLD_TESTS_EOF' || { echo "FAIL | could not install the gold tests"; exit 0; }
diff --git a/tests/gateway/providers/test_anthropic.py b/tests/gateway/providers/test_anthropic.py
index 24cd52cffb438..cdd4cb538fc09 100644
--- a/tests/gateway/providers/test_anthropic.py
+++ b/tests/gateway/providers/test_anthropic.py
@@ -1,3 +1,4 @@
+import json
 from unittest import mock
 
 import pytest
@@ -906,6 +907,118 @@ async def test_chat_function_calling_stream():
         )
 
 
+def _sse(event):
+    return [b"data: " + json.dumps(event).encode() + b"\n", b"\n"]
+
+
+def _tool_use_stream(blocks):
+    """blocks: list of ("text", str) or ("tool", id, name, partial_json)."""
+    events = [
+        {
+            "type": "message_start",
+            "message": {
+                "id": "test-id",
+                "model": "claude-2.1",
+                "usage": {"input_tokens": 25, "output_tokens": 1},
+            },
+        }
+    ]
+    for i, block in enumerate(blocks):
+        if block[0] == "text":
+            start = {"type": "text", "text": ""}
+            delta = {"type": "text_delta", "text": block[1]}
+        else:
+            start = {"type": "tool_use", "id": block[1], "name": block[2], "input": {}}
+            delta = {"type": "input_json_delta", "partial_json": block[3]}
+        events += [
+            {"type": "content_block_start", "index": i, "content_block": start},
+            {"type": "content_block_delta", "index": i, "delta": delta},
+            {"type": "content_block_stop", "index": i},
+        ]
+    events.append({
+        "type": "message_delta",
+        "delta": {"stop_reason": "tool_use", "stop_sequence": None},
+        "usage": {"output_tokens": 15},
+    })
+    return [line for e in events for line in _sse(e)]
+
+
+async def _stream_tool_calls(blocks):
+    config = chat_config()
+    with mock.patch(
+        "aiohttp.ClientSession.post",
+        return_value=MockAsyncStreamingResponse(_tool_use_stream(blocks)),
+    ):
+        provider = AnthropicProvider(EndpointConfig(**config))
+        payload = chat_function_calling_payload(stream=True)
+        return [c async for c in provider.chat_stream(chat.RequestPayload(**payload))]
+
+
+def _merge_tool_calls(chunks):
+    calls = {}
+    for chunk in chunks:
+        assert [c.index for c in chunk.choices] == [0]
+        for tc in chunk.choices[0].delta.tool_calls or []:
+            call = calls.setdefault(tc.index, {"name": None, "arguments": ""})
+            call["name"] = call["name"] or tc.function.name
+            call["arguments"] += tc.function.arguments or ""
+    return calls
+
+
+@pytest.mark.asyncio
+async def test_chat_stream_parallel_tool_calls():
+    chunks = await _stream_tool_calls([
+        ("tool", "toolu_1", "get_weather", '{"city": "Paris"}'),
+        ("tool", "toolu_2", "get_time", '{"tz": "UTC"}'),
+    ])
+    assert _merge_tool_calls(chunks) == {
+        0: {"name": "get_weather", "arguments": '{"city": "Paris"}'},
+        1: {"name": "get_time", "arguments": '{"tz": "UTC"}'},
+    }
+    assert len([c for c in chunks if c.choices[0].finish_reason]) == 1
+
+
+@pytest.mark.asyncio
+async def test_chat_stream_three_parallel_tool_calls():
+    chunks = await _stream_tool_calls([
+        ("tool", "toolu_1", "get_weather", '{"city": "Paris"}'),
+        ("tool", "toolu_2", "get_time", '{"tz": "UTC"}'),
+        ("tool", "toolu_3", "get_weather", '{"city": "Tokyo"}'),
+    ])
+    assert _merge_tool_calls(chunks) == {
+        0: {"name": "get_weather", "arguments": '{"city": "Paris"}'},
+        1: {"name": "get_time", "arguments": '{"tz": "UTC"}'},
+        2: {"name": "get_weather", "arguments": '{"city": "Tokyo"}'},
+    }
+    assert len([c for c in chunks if c.choices[0].finish_reason]) == 1
+
+
+@pytest.mark.asyncio
+async def test_chat_stream_text_then_tool_call():
+    chunks = await _stream_tool_calls([
+        ("text", "Let me check."),
+        ("tool", "toolu_1", "get_weather", '{"city": "Paris"}'),
+    ])
+    assert _merge_tool_calls(chunks) == {
+        0: {"name": "get_weather", "arguments": '{"city": "Paris"}'},
+    }
+    assert len([c for c in chunks if c.choices[0].finish_reason]) == 1
+
+
+@pytest.mark.asyncio
+async def test_chat_stream_text_between_tool_calls():
+    chunks = await _stream_tool_calls([
+        ("tool", "toolu_1", "get_weather", '{"city": "Paris"}'),
+        ("text", "Also checking the time."),
+        ("tool", "toolu_2", "get_time", '{"tz": "UTC"}'),
+    ])
+    assert _merge_tool_calls(chunks) == {
+        0: {"name": "get_weather", "arguments": '{"city": "Paris"}'},
+        1: {"name": "get_time", "arguments": '{"tz": "UTC"}'},
+    }
+    assert len([c for c in chunks if c.choices[0].finish_reason]) == 1
+
+
 def embedding_config():
     return {
         "name": "embeddings",
GOLD_TESTS_EOF
OUT=$(PYTHONPATH=. /Users/yoavshmariahu/src/thinker/bench/repos/mlflow-venv/bin/python -m pytest -q -x -p no:cacheprovider 'tests/gateway/providers/test_anthropic.py' 2>&1); CODE=$?
[ $CODE = 0 ] && echo "PASS | $(echo "$OUT" | tail -1)" || echo "FAIL | $(echo "$OUT" | tail -1)"
