#!/bin/bash
# Run in the session worktree after the last prompt. The pull request's own tests as merged (311bbbd3cc65)
# replace whatever the session left in those files: each is put back to the base, then the merged change to it is
# applied. The last line is PASS or FAIL with pytest's summary.
for f in 'tests/gateway/providers/test_typesafe.py' 'tests/server/test_gateway_api.py' 'tests/utils/test_providers.py'; do git checkout -q 1bb65f1c6 -- "$f" 2>/dev/null || rm -f "$f"; done
git apply --whitespace=nowarn - <<'GOLD_TESTS_EOF' || { echo "FAIL | could not install the gold tests"; exit 0; }
diff --git a/tests/gateway/providers/test_typesafe.py b/tests/gateway/providers/test_typesafe.py
index 8fad0bcdd..21e96b548 100644
--- a/tests/gateway/providers/test_typesafe.py
+++ b/tests/gateway/providers/test_typesafe.py
@@ -6,6 +6,7 @@ from fastapi import HTTPException
 
 from mlflow.exceptions import MlflowException
 from mlflow.gateway.config import EndpointConfig, TypeSafeConfig
+from mlflow.gateway.constants import TYPESAFE_API_BASE_URL
 from mlflow.gateway.exceptions import AIGatewayException
 from mlflow.gateway.provider_registry import provider_registry
 from mlflow.gateway.providers.base import PassthroughAction
@@ -49,6 +50,31 @@ def test_typesafe_api_key_config(monkeypatch):
         TypeSafeConfig(typesafe_api_key=None)
 
 
+@pytest.mark.asyncio
+async def test_typesafe_api_base_config(provider):
+    assert provider.base_url == TYPESAFE_API_BASE_URL
+
+    custom_provider = TypeSafeProvider(
+        EndpointConfig(
+            name="custom-jev-evaluator",
+            endpoint_type="llm/v1/chat",
+            model={
+                "provider": "typesafe",
+                "name": "jev-1.13.0",
+                "config": {
+                    "typesafe_api_key": "typesafe-test-key",
+                    "typesafe_api_base": "https://typesafe.example.com/v1",
+                },
+            },
+        )
+    )
+    assert custom_provider.base_url == "https://typesafe.example.com/v1"
+
+    with patch("mlflow.gateway.providers.typesafe.send_request", return_value={}) as send:
+        await custom_provider.passthrough(PassthroughAction.TYPESAFE_SYSTEM_ONE, {})
+    assert send.await_args.kwargs["base_url"] == "https://typesafe.example.com/v1"
+
+
 @pytest.mark.parametrize(
     ("question", "answer"),
     [
diff --git a/tests/server/test_gateway_api.py b/tests/server/test_gateway_api.py
index 4b595ca1c..e3511caf0 100644
--- a/tests/server/test_gateway_api.py
+++ b/tests/server/test_gateway_api.py
@@ -34,6 +34,7 @@ from mlflow.gateway.config import (
     OpenAIAPIType,
     OpenAIConfig,
     PortkeyConfig,
+    TypeSafeConfig,
     VertexAIConfig,
 )
 from mlflow.gateway.constants import MLFLOW_GATEWAY_DURATION_HEADER, MLFLOW_GATEWAY_OVERHEAD_HEADER
@@ -170,6 +171,20 @@ def test_build_endpoint_config_vertex_ai_reads_anthropic_betas_from_auth_config(
     assert config.model.config.vertex_anthropic_betas == expected
 
 
+def test_build_endpoint_config_typesafe_reads_api_base_from_auth_config():
+    model_config = GatewayModelConfig(
+        model_definition_id="md-test",
+        provider="typesafe",
+        model_name="jev-1.13.0",
+        secret_value={"api_key": "typesafe-test-key"},
+        auth_config={"api_base": "https://typesafe.example.com/v1"},
+    )
+    config = _build_endpoint_config("test-ep", model_config, EndpointType.LLM_V1_CHAT)
+
+    assert isinstance(config.model.config, TypeSafeConfig)
+    assert config.model.config.typesafe_api_base == "https://typesafe.example.com/v1"
+
+
 def test_create_provider_from_endpoint_name_openai(store: SqlAlchemyStore):
     # Create test data
     secret = store.create_gateway_secret(
diff --git a/tests/utils/test_providers.py b/tests/utils/test_providers.py
index d32558138..bc93d0092 100644
--- a/tests/utils/test_providers.py
+++ b/tests/utils/test_providers.py
@@ -91,7 +91,14 @@ def test_typesafe_models_and_credentials(monkeypatch):
     assert config["auth_modes"][0]["secret_fields"] == [
         {"name": "api_key", "type": "string", "description": "TypeSafe API Key", "required": True}
     ]
-    assert config["auth_modes"][0]["config_fields"] == []
+    assert config["auth_modes"][0]["config_fields"] == [
+        {
+            "name": "api_base",
+            "type": "string",
+            "description": "TypeSafe API Base URL (defaults to https://api.typesafe.ai/v1)",
+            "required": False,
+        }
+    ]
 
     input_cost, output_cost = cost_per_token(
         model="jev-preview",
GOLD_TESTS_EOF
OUT=$(PYTHONPATH=. /Users/yoavshmariahu/src/thinker/bench/repos/mlflow-venv/bin/python -m pytest -q -x -p no:cacheprovider 'tests/gateway/providers/test_typesafe.py' 'tests/server/test_gateway_api.py' 'tests/utils/test_providers.py' 2>&1); CODE=$?
[ $CODE = 0 ] && echo "PASS | $(echo "$OUT" | tail -1)" || echo "FAIL | $(echo "$OUT" | tail -1)"
