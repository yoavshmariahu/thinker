# thinker for LangChain agents

One line wires thinker into an agent built with LangChain or LangGraph:

```python
from thinker_langchain import Thinker

agent = create_agent(model, tools, middleware=[Thinker("http://thinker:7000")])
```

That line does two things, always together:

- **Sends the agent's model calls through thinker's proxy**, which removes finished tool results from the
  context as it grows. Each run is tagged with its own session (the LangGraph `thread_id` when there is one).
- **Fires thinker's hooks** where a coding agent fires them: when a prompt arrives, before and after each
  tool call, and when the run ends. The run is recorded in the agent's own workspace inside thinker.

## Running thinker beside the agent

thinker runs in its own container (`docker/thinker` in the thinker repository):

```yaml
services:
  thinker:
    build: { context: path/to/thinker, dockerfile: docker/thinker/Dockerfile }
    volumes: [thinker-data:/data]
  agent:
    build: .
volumes:
  thinker-data:
```

`Thinker(url, name="support-bot")` names the agent; each name gets its own workspace under `/data/agents`.

## What to know

- If thinker cannot be reached, the agent runs as it would without the middleware. A hook never fails a tool
  call, and the model is only rerouted while thinker answers.
- Only Anthropic models (`ChatAnthropic`) are rerouted through the proxy. With another provider's model the
  hooks still fire and the model is left alone.
- The before-tool hook can answer for a tool (thinker's delegation). No delegation rule exists yet for a
  framework agent's tools, so today it always lets the call through.
- Add LangChain's own prompt caching (`AnthropicPromptCachingMiddleware`) as you normally would; thinker
  works with it.

## Tests

```bash
pip install -e '.[test]' && pytest
```

The tests run a real LangChain agent against a local stand-in for thinker and the model; nothing is sent anywhere.
