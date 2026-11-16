#!/bin/bash
# Run in the session worktree after the last prompt. The pull request's own tests as merged (3472954054e9)
# replace whatever the session left in those files: each is put back to the base, then the merged change to it is
# applied. The last line is PASS or FAIL with pytest's summary.
for f in 'tests/gateway/providers/test_gemini.py' 'tests/gateway/providers/test_litellm.py'; do git checkout -q 1bb65f1c6 -- "$f" 2>/dev/null || rm -f "$f"; done
git apply --whitespace=nowarn - <<'GOLD_TESTS_EOF' || { echo "FAIL | could not install the gold tests"; exit 0; }
diff --git a/tests/gateway/providers/test_gemini.py b/tests/gateway/providers/test_gemini.py
index d61c9ba8cd0e7..9ae6a1d1b11f7 100644
--- a/tests/gateway/providers/test_gemini.py
+++ b/tests/gateway/providers/test_gemini.py
@@ -1312,6 +1312,101 @@ async def test_gemini_chat_stream(resp):
     )
 
 
+@pytest.mark.asyncio
+@pytest.mark.parametrize("split_across_chunks", [False, True])
+async def test_gemini_chat_stream_parallel_tool_calls_get_distinct_indices(split_across_chunks):
+    call_a = {"functionCall": {"name": "get_weather", "args": {"city": "Baku"}}}
+    call_b = {"functionCall": {"name": "get_time", "args": {"tz": "UTC"}}}
+    part_groups = [[call_a], [call_b]] if split_across_chunks else [[call_a, call_b]]
+    resp = [
+        line
+        for parts in part_groups
+        for line in (
+            b"data: "
+            + json.dumps({"candidates": [{"content": {"parts": parts}}]}).encode()
+            + b"\n",
+            b"\n",
+        )
+    ] + [b"data: [DONE]\n"]
+    mock_client = mock_http_client(MockAsyncStreamingResponse(resp))
+    provider = GeminiProvider(EndpointConfig(**chat_config()))
+    payload = chat_function_calling_payload(stream=True)
+
+    with mock.patch("aiohttp.ClientSession", return_value=mock_client) as mock_session:
+        chunks = [c async for c in provider.chat_stream(chat.RequestPayload(**payload))]
+
+    mock_session.assert_called_once()
+    mock_client.post.assert_called_once()
+    calls = [tc for c in chunks for tc in c.choices[0].delta.tool_calls]
+    assert [(tc.index, tc.function.name) for tc in calls] == [(0, "get_weather"), (1, "get_time")]
+    assert [json.loads(tc.function.arguments) for tc in calls] == [
+        {"city": "Baku"},
+        {"tz": "UTC"},
+    ]
+
+
+@pytest.mark.asyncio
+async def test_gemini_chat_stream_tool_call_indices_are_per_candidate():
+    call_a = {"functionCall": {"name": "get_weather", "args": {}}}
+    call_b = {"functionCall": {"name": "get_time", "args": {}}}
+    call_c = {"functionCall": {"name": "get_date", "args": {}}}
+    chunks_in = [
+        {
+            "candidates": [
+                {"content": {"parts": [call_a]}},
+                {"content": {"parts": [call_a, call_b]}},
+            ]
+        },
+        {"candidates": [{"content": {"parts": [call_c]}}, {"content": {"parts": [call_c]}}]},
+    ]
+    resp = [line for c in chunks_in for line in (b"data: " + json.dumps(c).encode() + b"\n", b"\n")]
+    resp.append(b"data: [DONE]\n")
+    mock_client = mock_http_client(MockAsyncStreamingResponse(resp))
+    provider = GeminiProvider(EndpointConfig(**chat_config()))
+    payload = chat_function_calling_payload(stream=True)
+
+    with mock.patch("aiohttp.ClientSession", return_value=mock_client) as mock_session:
+        chunks = [c async for c in provider.chat_stream(chat.RequestPayload(**payload))]
+
+    mock_session.assert_called_once()
+    mock_client.post.assert_called_once()
+    by_candidate = {0: [], 1: []}
+    for c in chunks:
+        for choice in c.choices:
+            by_candidate[choice.index] += [tc.index for tc in choice.delta.tool_calls]
+    assert by_candidate == {0: [0, 1], 1: [0, 1, 2]}
+
+
+@pytest.mark.asyncio
+async def test_gemini_chat_stream_tool_call_indices_use_candidate_api_index():
+    call_a = {"functionCall": {"name": "get_weather", "args": {}}}
+    call_b = {"functionCall": {"name": "get_time", "args": {}}}
+    # Each chunk carries a single candidate, so list position differs from the API index.
+    chunks_in = [
+        {"candidates": [{"index": 1, "content": {"parts": [call_a]}}]},
+        {"candidates": [{"index": 0, "content": {"parts": [call_a]}}]},
+        {"candidates": [{"index": 1, "content": {"parts": [call_b]}}]},
+    ]
+    resp = [line for c in chunks_in for line in (b"data: " + json.dumps(c).encode() + b"\n", b"\n")]
+    resp.append(b"data: [DONE]\n")
+    mock_client = mock_http_client(MockAsyncStreamingResponse(resp))
+    provider = GeminiProvider(EndpointConfig(**chat_config()))
+    payload = chat_function_calling_payload(stream=True)
+
+    with mock.patch("aiohttp.ClientSession", return_value=mock_client) as mock_session:
+        chunks = [c async for c in provider.chat_stream(chat.RequestPayload(**payload))]
+
+    mock_session.assert_called_once()
+    mock_client.post.assert_called_once()
+    by_candidate = {0: [], 1: []}
+    for c in chunks:
+        for choice in c.choices:
+            by_candidate[choice.index] += [
+                (tc.index, tc.function.name) for tc in choice.delta.tool_calls
+            ]
+    assert by_candidate == {0: [(0, "get_weather")], 1: [(0, "get_weather"), (1, "get_time")]}
+
+
 def chat_function_calling_stream_response():
     return [
         b'data: {"candidates": [{"content": {"parts": [{"functionCall": {"name": "get_weather", '
diff --git a/tests/gateway/providers/test_litellm.py b/tests/gateway/providers/test_litellm.py
index 3bb3fe510ad56..af2937544aeb4 100644
--- a/tests/gateway/providers/test_litellm.py
+++ b/tests/gateway/providers/test_litellm.py
@@ -260,6 +260,52 @@ async def mock_stream():
         assert call_kwargs["stream_options"]["include_usage"] is True
 
 
+@pytest.mark.asyncio
+async def test_chat_stream_keeps_parallel_tool_call_indices():
+    def make_chunk(*tool_calls):
+        chunk = mock.MagicMock()
+        chunk.id = "chunk"
+        chunk.object = "chat.completion.chunk"
+        chunk.created = 1234567890
+        chunk.model = "gpt-4o"
+        chunk.usage = None
+        choice = mock.MagicMock()
+        choice.index = 0
+        choice.finish_reason = None
+        choice.delta = mock.MagicMock(spec=["role", "content", "tool_calls"])
+        choice.delta.role = None
+        choice.delta.content = None
+        choice.delta.tool_calls = [
+            mock.MagicMock(index=i, id=id_, type="function", function=mock.MagicMock())
+            for i, id_, _, _ in tool_calls
+        ]
+        for tc, (_, _, name, args) in zip(choice.delta.tool_calls, tool_calls):
+            tc.function.name = name
+            tc.function.arguments = args
+        chunk.choices = [choice]
+        return chunk
+
+    async def mock_stream():
+        yield make_chunk((0, "call_a", "get_weather", ""))
+        yield make_chunk((1, "call_b", "get_time", ""))
+        # A later chunk carries arguments for call 1 only.
+        yield make_chunk((1, None, None, '{"tz": "UTC"}'))
+        yield make_chunk((0, None, None, '{"city": "Baku"}'))
+
+    with mock.patch("litellm.acompletion", return_value=mock_stream()) as mock_acompletion:
+        provider = LiteLLMProvider(EndpointConfig(**chat_config()), enable_tracing=True)
+        payload = {"messages": [{"role": "user", "content": "Hi"}], "stream": True}
+        chunks = [c async for c in provider.chat_stream(chat.RequestPayload(**payload))]
+
+    mock_acompletion.assert_called_once()
+    calls = [tc for c in chunks for tc in c.choices[0].delta.tool_calls]
+    assert [tc.index for tc in calls] == [0, 1, 1, 0]
+    args = {}
+    for tc in calls:
+        args[tc.index] = args.get(tc.index, "") + (tc.function.arguments or "")
+    assert args == {0: '{"city": "Baku"}', 1: '{"tz": "UTC"}'}
+
+
 @pytest.mark.asyncio
 async def test_chat_stream_forwards_zero_token_usage():
     config = chat_config()
GOLD_TESTS_EOF
OUT=$(PYTHONPATH=. /Users/yoavshmariahu/src/thinker/bench/repos/mlflow-venv/bin/python -m pytest -q -x -p no:cacheprovider 'tests/gateway/providers/test_gemini.py' 'tests/gateway/providers/test_litellm.py' 2>&1); CODE=$?
[ $CODE = 0 ] && echo "PASS | $(echo "$OUT" | tail -1)" || echo "FAIL | $(echo "$OUT" | tail -1)"
