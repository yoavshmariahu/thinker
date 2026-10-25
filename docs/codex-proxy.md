# Codex context proxy

Thinker shortens old text tool results in OpenAI Responses requests. It is
**on by default** for Codex using the built-in OpenAI provider: install, `connect`,
`setup`, and updates wire it into the existing machine-wide proxy service.
This default was explicitly requested by the owner on 2026-10-25 after the live
transport test; it is not a claim of measured quality or savings improvements.

The service adds a managed `thinker_proxy` provider in `$CODEX_HOME/config.toml`
(or `~/.codex/config.toml`) and selects it. It keeps the model, reasoning effort,
other settings, and Codex's existing authentication. Requests with a ChatGPT
account header go to the ChatGPT backend; API-key requests go to the OpenAI API.
No credentials are read or stored by Thinker. HTTP/SSE is used instead of
WebSockets, and native compaction capability is retained.

A custom provider, base URL, selected configuration profile, or a provider table
that the person edited is left as configured and named in the setup output.
Restart Codex after installation or update so it reads the provider setting.

`thinker proxy off` restores the previous provider selection and removes the
managed provider table if it has not been edited. Other settings and a provider
chosen by the person are preserved. `thinker proxy on` enables it again.
`connect --no-proxy` skips enabling the service; a previously disabled service
stays off during updates. The shared service is kept alive by launchd/systemd,
with the existing prompt-hook recovery on other systems.

This is selective tool-output clearing, not OpenAI's summarizing compaction API.
Codex still owns its transcript and native compaction. Thinker changes the full
history sent to the model, leaving a placeholder where an older output was.
It makes no extra model calls and needs no agent CLI login of its own. A desktop
client that honors the same user-level provider settings can use the same route.
It cannot change an already running session that is not routed through it.

## Run a standalone proxy manually

The managed service needs no manual configuration. For a separate foreground
proxy instead, use the following OpenAI API example:

```sh
thinker proxy --protocol responses --port 8788 \
  --upstream https://api.openai.com/v1
```

In Codex's config, add a separate provider and select it for a new session:

```toml
# Keep your existing model and reasoning effort.
model_provider = "thinker_responses"

[model_providers.thinker_responses]
name = "Thinker Responses proxy"
base_url = "http://127.0.0.1:8788"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
supports_websockets = false
```

Keep the proxy running while the client uses it. To stop using it, restore your
previous `model_provider`, restart the client, then stop the foreground proxy
with Ctrl-C. `thinker proxy off` manages the existing Anthropic service, not this
separate process. No credentials are stored by the proxy.

For an existing gateway, use its exact provider base URL as `--upstream`, and
preserve its authentication, headers, model and capabilities in the new provider.
The upstream base path is prepended to the client's request path: the example
above sends `/responses` to `/v1/responses`. Do not also append `/v1` to the local
`base_url`, which would duplicate it upstream.

**ChatGPT login:** this is a different upstream from `api.openai.com`. Codex's
ChatGPT backend normally uses `https://chatgpt.com/backend-api/codex`; a custom
provider using that route needs `requires_openai_auth = true` instead of
`env_key`. Thinker forwards the client's authorization and account headers
unchanged. This route was verified on 2026-10-25 with Codex CLI 0.164.0 and
`gpt-6-astra` at high reasoning effort: the current turn kept its tool output;
after resume, the proxy shortened that older output and the backend returned a
successful answer. All three model requests returned HTTP 200. The test used
lower thresholds (`--trigger 1 --clear-at-least 1 --keep-min 0`) to exercise
clearing in a small fixture, not to measure savings or establish good defaults.
The API-key example above does not use a ChatGPT subscription. Desktop provider
support still depends on the particular app and has not been tested live.

## What gets cleared

- Only `function_call_output` and `custom_tool_call_output` text from before the
  latest user message is eligible. The entire current turn stays intact.
- At least the newest three tool outputs stay (`--keep-min n`). Calls and IDs,
  user/developer messages, reasoning and encrypted compaction items stay intact.
  Image, file and mixed-content outputs stay intact.
- Clearing starts at roughly 100,000 tokens and must remove roughly 80,000 tokens
  (`--trigger n`, `--clear-at-least n`). These are **UTF-8 request bytes divided by
  four**, not tokenizer counts. Instructions and tool schemas count toward the
  trigger; only replaceable tool-output bytes count toward the removal minimum.
- `--keep turn` is required in this mode; a numeric `--keep` is rejected.
- The proxy recomputes replacements from the full request each time. Identical
  retries and resumed histories produce identical replacements, without keeping
  a second transcript or session state on disk. A changed prefix can miss the
  provider's prompt cache; more clearing is not necessarily cheaper.
- `/responses/compact`, requests containing `compaction_trigger` or
  `context_management`, and linked server-side histories (`previous_response_id`
  or `conversation`, or inputs with `item_reference`) pass through unchanged. Unknown/non-array histories and
  compressed request bodies also pass through, with a reason in the report.
  This mode requires full-history HTTP/SSE requests; WebSocket upgrades receive
  an explicit error instructing the client to use HTTP/SSE.

Old outputs can still matter. A model may have to read them again, or miss
information. This policy has no measured quality or savings advantage over
native Codex yet. The owner requested this default without waiting for an
experiment. Any comparison of quality or savings still goes through an approved
Artemis experiment with the same model and reasoning effort in both arms.

## Inspect and verify

`thinker proxy report --json` includes a separate `responses` object: requests,
input tokens, cached input (already included in input), output tokens, bytes
removed, upstream errors, and reasons requests were left unchanged. Text reports
show these too. Bytes removed are not billed-token savings, and the report does
not apply Anthropic's cache-price weights to OpenAI usage. Logs contain counts,
model and session identifiers, not credentials or request/response content.
Codex closes SSE on the completion event, often before the HTTP response ends;
the proxy records usage and clearing on that close too, exactly once.

`--holdout 0.15` leaves a stable 15% of identified sessions unchanged. A session
comes from `session_id`, `x-codex-session-id`, or `prompt_cache_key`. With a
nonzero holdout, requests without an identifier are left unchanged.

Unit and loopback tests cover preservation, streaming, authentication headers,
upstream errors, usage, native compaction passthrough, and repeat requests:

```sh
npm test -- test/proxy-responses.test.js test/proxy.test.js
```

An optional real-client test starts the installed Codex against a loopback fake
model in a disposable home. It executes a harmless fixture command, resumes the
session, and verifies that only the older output is shortened. It uses no real
model, credentials or personal configuration:

```sh
THINKER_CODEX_PROXY_SMOKE=1 npm test -- test/proxy-codex.test.js
```

Verified this way with Codex CLI 0.164.0. A separate live ChatGPT smoke test also
verified provider acceptance and resume as described above. Neither test proves
answer quality or token savings on real coding tasks. The live test used a
private temporary login copy and settings, removed afterward; normal Codex
settings were unchanged and Thinker telemetry was disabled with `THINKER_TEST=1`.

Protocol references: [Codex provider configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
and [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction).
