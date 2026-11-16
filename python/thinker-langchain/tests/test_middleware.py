"""The middleware against a stand-in for thinker: a local server that is both the hook service and
the model endpoint, so a real LangChain agent runs end to end and nothing is sent anywhere."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from langchain.agents import create_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool

from thinker_langchain import Thinker


class Stand:
    """Records every hook and model request; answers the model with one tool call, then text."""

    def __init__(self, deny=None, context=None):
        self.hooks, self.model_calls, self.deny, self.context = [], [], deny, context
        stand = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, obj):
                raw = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self._send({"ok": True, "version": "test"} if self.path == "/thinker/health" else {})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                if self.path.startswith("/thinker/hook/"):
                    event = self.path.rsplit("/", 1)[1]
                    stand.hooks.append((event, body))
                    if event == "prompt" and stand.context:
                        return self._send({"context": stand.context})
                    if event == "pretool" and stand.deny:
                        return self._send({"decision": "deny", "reason": stand.deny})
                    return self._send({})
                stand.model_calls.append({"headers": dict(self.headers), "body": body})
                asked = any(isinstance(m.get("content"), list) and any(b.get("type") == "tool_result" for b in m["content"]) for m in body["messages"])
                content = [{"type": "text", "text": "Paris is sunny."}] if asked else [{"type": "tool_use", "id": "toolu_1", "name": "weather", "input": {"city": "Paris"}}]
                self._send({"id": "msg_1", "type": "message", "role": "assistant", "model": body["model"], "content": content,
                            "stop_reason": "end_turn" if asked else "tool_use", "usage": {"input_tokens": 5, "output_tokens": 5}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


ran = []


@tool
def weather(city: str) -> str:
    """The weather in a city."""
    ran.append(city)
    return f"sunny in {city}"


def agent_for(url, **kw):
    # the model as a developer would write it: pointed nowhere in particular
    model = ChatAnthropic(model="claude-haiku-5-5", api_key="k", base_url="http://127.0.0.1:9", max_retries=0)
    return create_agent(model, [weather], system_prompt="You answer briefly.", middleware=[Thinker(url, **kw)])


@pytest.fixture
def stand():
    ran.clear()
    s = Stand()
    yield s
    s.close()


def test_one_line_wires_the_proxy_and_every_hook(stand):
    out = agent_for(stand.url, name="demo").invoke({"messages": [{"role": "user", "content": "Weather in Paris?"}]})
    assert out["messages"][-1].content == "Paris is sunny."
    assert ran == ["Paris"]
    # the model went through thinker, not to the address it was built with, on one session for the run
    assert len(stand.model_calls) == 2
    sessions = {c["headers"].get("x-session-id") for c in stand.model_calls}
    assert len(sessions) == 1 and next(iter(sessions)).startswith("lc-")
    # the hooks, in the order a coding agent fires them
    assert [e for e, _ in stand.hooks] == ["prompt", "pretool", "tool", "stop"]
    by = dict(stand.hooks)
    session = next(iter(sessions))
    assert all(b["session"] == session and b["client"] == "langchain" and b["name"] == "demo" for _, b in stand.hooks)
    assert by["prompt"]["prompt"] == "Weather in Paris?"
    assert by["pretool"]["tool"] == "weather" and by["pretool"]["input"] == {"city": "Paris"} and by["pretool"]["call_id"] == "toolu_1"
    assert by["tool"]["output"] == "sunny in Paris" and by["tool"]["output_chars"] == 14
    assert by["stop"]["answer"] == "Paris is sunny."
    # private state stays out of what the agent returns
    assert "thinker_session" not in out and "thinker_context" not in out


def test_a_thread_is_a_session(stand):
    from langgraph.checkpoint.memory import InMemorySaver

    model = ChatAnthropic(model="claude-haiku-5-5", api_key="k", max_retries=0)
    agent = create_agent(model, [weather], middleware=[Thinker(stand.url)], checkpointer=InMemorySaver())
    agent.invoke({"messages": [{"role": "user", "content": "Weather in Paris?"}]}, {"configurable": {"thread_id": "thread-7"}})
    assert {c["headers"].get("x-session-id") for c in stand.model_calls} == {"thread-7"}
    assert {b["session"] for _, b in stand.hooks} == {"thread-7"}


def test_thinker_can_answer_for_a_tool(stand):
    stand.deny = "thinker read this through a subagent: it is sunny."
    out = agent_for(stand.url).invoke({"messages": [{"role": "user", "content": "Weather in Paris?"}]})
    assert ran == [], "the tool did not run"
    tool_message = next(m for m in out["messages"] if m.type == "tool")
    assert tool_message.content == stand.deny and tool_message.tool_call_id == "toolu_1"
    # an answered call has no result of its own to record
    assert [e for e, _ in stand.hooks] == ["prompt", "pretool", "stop"]


def test_what_the_prompt_hook_serves_is_in_every_call_the_same(stand):
    stand.context = "How this team works: answer in one line."
    agent_for(stand.url).invoke({"messages": [{"role": "user", "content": "Weather in Paris?"}]})
    systems = [json.dumps(c["body"]["system"]) for c in stand.model_calls]
    assert len(systems) == 2 and systems[0] == systems[1]
    assert "You answer briefly." in systems[0] and "answer in one line" in systems[0]


def test_async_runs_fire_the_same_hooks(stand):
    import asyncio

    out = asyncio.run(agent_for(stand.url).ainvoke({"messages": [{"role": "user", "content": "Weather in Paris?"}]}))
    assert out["messages"][-1].content == "Paris is sunny."
    assert [e for e, _ in stand.hooks] == ["prompt", "pretool", "tool", "stop"]


def test_without_thinker_the_agent_is_untouched():
    # nothing listens here: no hook fires and the model keeps its own address, so the failure below is the
    # model's own (it was pointed at a dead port), not one this middleware added
    mw = Thinker("http://127.0.0.1:9")
    assert mw.available() is False
    model = ChatAnthropic(model="claude-haiku-5-5", api_key="k", base_url="http://127.0.0.1:9", max_retries=0)
    assert mw._routed_model(model, "s") is not model  # routing itself works...
    from langchain.agents.middleware import ModelRequest

    request = ModelRequest(model=model, messages=[], system_message=None, tool_choice=None, tools=[], response_format=None, state={"messages": []}, runtime=None)
    assert mw._prepare(request) is request  # ...and is not applied while thinker is away
