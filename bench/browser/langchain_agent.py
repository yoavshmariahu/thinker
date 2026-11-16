#!/usr/bin/env python3
"""A browser agent built on LangChain, for the bench: the same tasks, on a stack that is not a coding agent.

The bench gives it one turn in the environment (bench.mjs, `agent`) and reads one JSON object from stdout in
the shape Claude Code prints, so a session of this agent is recorded and compared like any other.

    BENCH_PROMPT, BENCH_MODEL, BENCH_MAX_TURNS, BENCH_SESSION, BENCH_NAME   the turn
    BENCH_MCP            {"mcpServers": {...}}: the browser server, the same one every arm gets
    BENCH_THINKER_URL    set by an arm that runs thinker (proxy-arm.sh): the agent is then wired the standard
                         way, with the one middleware line. Unset: the agent as its developer wrote it.

Both ways the agent caches its prompt with LangChain's own middleware, as a developer who cares what it
costs would: thinker is measured against that, never against an agent that caches nothing.
"""
import asyncio
import contextlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python", "thinker-langchain"))

from langchain.agents import create_agent  # noqa: E402
from langchain_anthropic import ChatAnthropic  # noqa: E402
from langchain_anthropic.middleware import AnthropicPromptCachingMiddleware  # noqa: E402
from langchain_core.messages import AIMessage  # noqa: E402
from langchain_mcp_adapters.client import MultiServerMCPClient  # noqa: E402
from langchain_mcp_adapters.tools import load_mcp_tools  # noqa: E402
from langgraph.errors import GraphRecursionError  # noqa: E402

SYSTEM = (
    "You operate a web browser through the browser tools. An action answers with a link to the page; "
    "call browser_snapshot to see the page as it now is. Work only through the browser, and when the task "
    "is done reply with the answer it asks for."
)


def usage_of(messages):
    """Token counters summed over the run's model calls, in the names Claude Code reports them under."""
    u = {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0}
    calls = 0
    for m in messages:
        meta = getattr(m, "usage_metadata", None) if isinstance(m, AIMessage) else None
        if not meta:
            continue
        calls += 1
        details = meta.get("input_token_details") or {}
        read, write = int(details.get("cache_read") or 0), int(details.get("cache_creation") or 0)
        u["cache_read_input_tokens"] += read
        u["cache_creation_input_tokens"] += write
        # LangChain's input_tokens is the whole prompt; the API's is what was neither read nor written
        u["input_tokens"] += max(0, int(meta.get("input_tokens") or 0) - read - write)
        u["output_tokens"] += int(meta.get("output_tokens") or 0)
    return u, calls


async def run():
    started = time.time()
    servers = {
        name: {"transport": "stdio", "command": s["command"], "args": s.get("args", []), **({"env": s["env"]} if s.get("env") else {})}
        for name, s in (json.loads(os.environ.get("BENCH_MCP") or "{}").get("mcpServers") or {}).items()
    }
    # One session with each server for the whole run. The adapter's `get_tools()` opens a new session for
    # every call, which for a browser server is a new browser: the page navigated to is gone by the next
    # call (seen 2026-11-15: every snapshot was about:blank).
    async with contextlib.AsyncExitStack() as stack:
        client, tools = MultiServerMCPClient(servers), []
        for name in servers:
            tools += await load_mcp_tools(await stack.enter_async_context(client.session(name)))
        await drive(tools, started)


async def drive(tools, started):
    middleware = [AnthropicPromptCachingMiddleware(ttl="5m")]
    thinker = os.environ.get("BENCH_THINKER_URL")
    if thinker:
        from thinker_langchain import Thinker

        # the standard wiring: this one entry sends the model through thinker and fires its hooks
        middleware.append(Thinker(thinker, name=os.environ.get("BENCH_NAME") or "bench"))
    # the model as written: Anthropic's own address, whatever this machine's environment says
    model = ChatAnthropic(model=os.environ["BENCH_MODEL"], base_url="https://api.anthropic.com", max_tokens=8000, max_retries=2)
    agent = create_agent(model, tools, system_prompt=SYSTEM, middleware=middleware)
    max_turns = int(os.environ.get("BENCH_MAX_TURNS") or 150)
    messages, out = [], {"type": "result", "session_id": os.environ.get("BENCH_SESSION"), "is_error": False, "subtype": "success"}
    try:
        state = await agent.ainvoke({"messages": [{"role": "user", "content": os.environ["BENCH_PROMPT"]}]}, {"recursion_limit": 2 * max_turns + 10})
        messages = state["messages"]
        last = next((m for m in reversed(messages) if isinstance(m, AIMessage)), None)
        content = last.content if last else ""
        out["result"] = content if isinstance(content, str) else "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    except GraphRecursionError:
        out.update(is_error=True, subtype="error_max_turns", result="")
    except Exception as e:  # the record says what broke; the bench marks the session invalid
        out.update(is_error=True, subtype=f"exception {type(e).__name__}", result=str(e)[:400])
    usage, calls = usage_of(messages)
    out.update(usage=usage, num_turns=calls, duration_ms=int((time.time() - started) * 1000), thinker=bool(thinker))
    print(json.dumps(out))


if __name__ == "__main__":
    asyncio.run(run())
