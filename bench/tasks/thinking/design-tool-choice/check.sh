#!/bin/bash
# Run in the session worktree after the last prompt. The pull request's own tests as merged (c233876f76ff)
# replace whatever the session left in those files: each is put back to the base, then the merged change to it is
# applied. The last line is PASS or FAIL with pytest's summary.
for f in 'tests/gateway/providers/test_gemini.py' 'tests/gateway/providers/test_vertex_ai.py'; do git checkout -q 1bb65f1c6 -- "$f" 2>/dev/null || rm -f "$f"; done
git apply --whitespace=nowarn - <<'GOLD_TESTS_EOF' || { echo "FAIL | could not install the gold tests"; exit 0; }
diff --git a/tests/gateway/providers/test_gemini.py b/tests/gateway/providers/test_gemini.py
index 9ae6a1d1b11f7..e249b57cee673 100644
--- a/tests/gateway/providers/test_gemini.py
+++ b/tests/gateway/providers/test_gemini.py
@@ -485,6 +485,74 @@ def chat_function_calling_payload(stream: bool = False):
     return payload
 
 
+@pytest.mark.parametrize("stream", [False, True])
+@pytest.mark.parametrize(
+    ("tool_choice", "expected_config"),
+    [
+        (None, None),
+        ("auto", None),
+        ("none", {"mode": "NONE"}),
+        ("required", {"mode": "ANY"}),
+        (
+            {"type": "function", "function": {"name": "get_weather"}},
+            {"mode": "ANY", "allowedFunctionNames": ["get_weather"]},
+        ),
+    ],
+)
+@pytest.mark.asyncio
+async def test_gemini_chat_tool_choice(tool_choice, expected_config, stream):
+    provider = GeminiProvider(EndpointConfig(**chat_config()))
+    payload = chat_function_calling_payload(stream=stream)
+    payload["tool_choice"] = tool_choice
+    payload["tools"].append({
+        "type": "function",
+        "function": {
+            "name": "get_forecast",
+            "description": "Get a weather forecast.",
+            "parameters": {"type": "object", "properties": {}},
+        },
+    })
+    response = (
+        MockAsyncStreamingResponse(chat_stream_response())
+        if stream
+        else MockAsyncResponse(fake_chat_response())
+    )
+    mock_client = mock_http_client(response)
+    with mock.patch("aiohttp.ClientSession", return_value=mock_client):
+        request = chat.RequestPayload(**payload)
+        if stream:
+            chunks = [chunk async for chunk in provider.chat_stream(request)]
+            assert chunks
+        else:
+            await provider.chat(request)
+
+    mock_client.post.assert_called_once()
+    sent_payload = mock_client.post.call_args.kwargs["json"]
+    assert len(sent_payload["tools"][0]["functionDeclarations"]) == 2
+    assert "tool_choice" not in sent_payload
+    if expected_config is None:
+        assert "toolConfig" not in sent_payload
+    else:
+        assert sent_payload["toolConfig"] == {"functionCallingConfig": expected_config}
+
+
+@pytest.mark.parametrize("tools", [None, []])
+@pytest.mark.parametrize(
+    "tool_choice",
+    ["auto", "none", "required", {"type": "function", "function": {"name": "get_weather"}}],
+)
+def test_gemini_tool_choice_without_tools(tools, tool_choice):
+    payload = {
+        "messages": [{"role": "user", "content": "Hello"}],
+        "tools": tools,
+        "tool_choice": tool_choice,
+    }
+    config = EndpointConfig(**chat_config())
+    result = GeminiAdapter.chat_to_model(payload, config)
+    assert "tools" not in result
+    assert "toolConfig" not in result
+
+
 @pytest.mark.asyncio
 async def test_gemini_chat_function_calling():
     config = chat_config()
diff --git a/tests/gateway/providers/test_vertex_ai.py b/tests/gateway/providers/test_vertex_ai.py
index bc63f4626abf5..59ab71176e1a0 100644
--- a/tests/gateway/providers/test_vertex_ai.py
+++ b/tests/gateway/providers/test_vertex_ai.py
@@ -290,6 +290,36 @@ async def test_chat_tool_calling_preserves_thought_signature():
     assert part["thoughtSignature"] == "opaque_thought_sig_token"
 
 
+@pytest.mark.parametrize("stream", [False, True])
+@pytest.mark.asyncio
+async def test_chat_tool_choice(stream):
+    provider = _make_provider()
+    payload = _tool_calling_second_turn_payload()
+    payload["messages"] = payload["messages"][:1]
+    payload["stream"] = stream
+    payload["tool_choice"] = {"type": "function", "function": {"name": "get_weather"}}
+    response = _chat_response()
+    mock_response = (
+        MockAsyncStreamingResponse([f"data: {json.dumps(response)}\n\n".encode()])
+        if stream
+        else MockAsyncResponse(response)
+    )
+    mock_client = mock_http_client(mock_response)
+    with mock.patch("aiohttp.ClientSession", return_value=mock_client):
+        request = chat.RequestPayload(**payload)
+        if stream:
+            chunks = [chunk async for chunk in provider.chat_stream(request)]
+            assert chunks
+        else:
+            await provider.chat(request)
+
+    mock_client.post.assert_called_once()
+    sent_payload = mock_client.post.call_args.kwargs["json"]
+    assert sent_payload["toolConfig"] == {
+        "functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["get_weather"]}
+    }
+
+
 @pytest.mark.asyncio
 async def test_chat_stream_tool_calling_omits_function_call_id():
     provider = _make_provider()
GOLD_TESTS_EOF
OUT=$(PYTHONPATH=. /Users/yoavshmariahu/src/thinker/bench/repos/mlflow-venv/bin/python -m pytest -q -x -p no:cacheprovider 'tests/gateway/providers/test_gemini.py' 'tests/gateway/providers/test_vertex_ai.py' 2>&1); CODE=$?
[ $CODE = 0 ] && echo "PASS | $(echo "$OUT" | tail -1)" || echo "FAIL | $(echo "$OUT" | tail -1)"
