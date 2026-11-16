"""The middleware. See the package docstring for what it is for.

The hook service's contract (src/hook-service.js in the thinker repository), all JSON over HTTP:

    GET  <url>/thinker/health                 -> {"ok": true, "version": "..."}
    POST <url>/thinker/hook/prompt   {session, prompt}                       -> {"context": "..."}?
    POST <url>/thinker/hook/pretool  {session, tool, input, call_id}         -> {"decision": "deny", "reason": "..."}?
    POST <url>/thinker/hook/tool     {session, tool, input, output, call_id} -> {}
    POST <url>/thinker/hook/stop     {session, answer}                       -> {}

Every body also carries `client: "langchain"` and the agent's `name` where it has one.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Annotated, Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware, AgentState, ModelRequest, ToolCallRequest
from langchain.agents.middleware.types import PrivateStateAttr
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from typing_extensions import NotRequired

log = logging.getLogger("thinker")

DEFAULT_URL = "http://127.0.0.1:7000"
# A tool result is sent to the after-tool hook up to this many characters: the hook records what the
# call was and how large its answer was, and the proxy sees the full text in the conversation anyway.
OUTPUT_CAP = 200_000
# Before a tool, thinker may hand the call to a subagent and answer with its report, which takes as
# long as the subagent does. Every other hook is bookkeeping and gets a short wait.
PRETOOL_TIMEOUT = 300.0
HOOK_TIMEOUT = 15.0
HEALTH_TIMEOUT = 2.0
HEALTH_TTL = 30.0


class ThinkerState(AgentState):
    """What the middleware keeps on a run. Private: never part of the agent's input or output."""

    thinker_session: NotRequired[Annotated[str, PrivateStateAttr]]
    thinker_context: NotRequired[Annotated[str, PrivateStateAttr]]


def _text(content: Any) -> str:
    """The text of a message's content, whether a string or a list of blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "\n".join(parts)
    return "" if content is None else str(content)


def _thread_id() -> str | None:
    """The LangGraph thread this run belongs to, if the caller gave one: a thread is a session."""
    try:
        from langgraph.config import get_config

        value = (get_config().get("configurable") or {}).get("thread_id")
        return str(value) if value else None
    except Exception:  # outside a graph, or a LangGraph without the accessor
        return None


class Thinker(AgentMiddleware):
    """Routes the agent's model through thinker's proxy and fires thinker's hooks.

    Args:
        url: where the thinker container is serving, e.g. ``http://thinker:7000`` in compose.
        name: a label for this agent in thinker's records; defaults to the middleware's own name.
    """

    state_schema = ThinkerState

    def __init__(self, url: str = DEFAULT_URL, *, name: str | None = None) -> None:
        super().__init__()
        self.url = url.rstrip("/")
        self.agent = name
        self._up: bool | None = None
        self._checked = 0.0
        self._lock = threading.Lock()
        self._routed: dict[tuple[int, str], Any] = {}
        self._warned = False

    # ---- talking to thinker -------------------------------------------------------------------

    def _post(self, event: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
        """One hook call. Never raises: a hook that fails is a hook that said nothing."""
        payload = {"client": "langchain", **({"name": self.agent} if self.agent else {}), **body}
        try:
            req = urllib.request.Request(
                f"{self.url}/thinker/hook/{event}",
                data=json.dumps(payload, default=str).encode(),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (the url is the operator's)
                raw = res.read()
            out = json.loads(raw) if raw else {}
            return out if isinstance(out, dict) else {}
        except Exception as e:  # unreachable, slow, or not JSON
            log.debug("thinker hook %s said nothing: %s", event, e)
            return {}

    def available(self) -> bool:
        """Whether thinker answers, asked at most every HEALTH_TTL seconds."""
        now = time.monotonic()
        with self._lock:
            if self._up is not None and now - self._checked < HEALTH_TTL:
                return self._up
        try:
            with urllib.request.urlopen(f"{self.url}/thinker/health", timeout=HEALTH_TIMEOUT) as res:  # noqa: S310
                up = bool(json.loads(res.read() or b"{}").get("ok"))
        except Exception:
            up = False
        with self._lock:
            self._up, self._checked = up, now
        if not up and not self._warned:
            self._warned = True
            log.warning("thinker is not reachable at %s; the agent runs without it", self.url)
        return up

    # ---- the session ---------------------------------------------------------------------------

    @staticmethod
    def _session(state: Any) -> str:
        return (state or {}).get("thinker_session") or _thread_id() or "langchain"

    def _routed_model(self, model: Any, session: str) -> Any:
        """The same model, sent through the proxy and tagged with this run's session.

        Only a model that names an Anthropic endpoint is rerouted: the proxy's door for another
        provider is a different route, and a model sent to the wrong one would simply fail.
        """
        if not hasattr(model, "anthropic_api_url"):
            return model
        key = (id(model), session)
        with self._lock:
            hit = self._routed.get(key)
        if hit is not None:
            return hit
        headers = {**(getattr(model, "default_headers", None) or {}), "x-session-id": session}
        routed = model.model_copy(update={"anthropic_api_url": self.url, "default_headers": headers})
        # the copy carries the original's built clients; drop them so it builds its own for the new address
        for attr in dir(type(routed)):
            if isinstance(getattr(type(routed), attr, None), functools.cached_property):
                routed.__dict__.pop(attr, None)
        with self._lock:
            if len(self._routed) > 256:
                self._routed.clear()
            self._routed[key] = routed
        return routed

    # ---- prompt submitted ----------------------------------------------------------------------

    def before_agent(self, state: ThinkerState, runtime: Any) -> dict[str, Any] | None:
        session = _thread_id() or state.get("thinker_session") or f"lc-{uuid.uuid4()}"
        update: dict[str, Any] = {"thinker_session": session}
        if self.available():
            prompt = next((_text(m.content) for m in reversed(state.get("messages", [])) if isinstance(m, HumanMessage)), "")
            said = self._post("prompt", {"session": session, "prompt": prompt}, HOOK_TIMEOUT)
            # What thinker serves on a prompt (the profile, where there is one). Kept for the whole run and
            # placed in the system prompt on every call, so the cached prefix is the same from call to call.
            if said.get("context") and not state.get("thinker_context"):
                update["thinker_context"] = str(said["context"])
        return update

    async def abefore_agent(self, state: ThinkerState, runtime: Any) -> dict[str, Any] | None:
        return await asyncio.to_thread(self.before_agent, state, runtime)

    # ---- every model call: through the proxy ---------------------------------------------------

    def _prepare(self, request: ModelRequest) -> ModelRequest:
        if not self.available():
            return request
        state = request.state or {}
        overrides: dict[str, Any] = {"model": self._routed_model(request.model, self._session(state))}
        context = state.get("thinker_context")
        if context:
            current = request.system_message
            if current is None:
                overrides["system_message"] = SystemMessage(content=context)
            elif isinstance(current.content, str):
                overrides["system_message"] = SystemMessage(content=f"{current.content}\n\n{context}")
            else:
                overrides["system_message"] = SystemMessage(content=[*current.content, {"type": "text", "text": context}])
        return request.override(**overrides)

    def wrap_model_call(self, request: ModelRequest, handler: Callable[[ModelRequest], Any]) -> Any:
        return handler(self._prepare(request))

    async def awrap_model_call(self, request: ModelRequest, handler: Callable[[ModelRequest], Awaitable[Any]]) -> Any:
        return await handler(await asyncio.to_thread(self._prepare, request))

    # ---- before and after each tool ------------------------------------------------------------

    def _before_tool(self, request: ToolCallRequest) -> ToolMessage | None:
        if not self.available():
            return None
        call = request.tool_call
        said = self._post(
            "pretool",
            {"session": self._session(request.state), "tool": call.get("name"), "input": call.get("args"), "call_id": call.get("id")},
            PRETOOL_TIMEOUT,
        )
        if said.get("decision") == "deny" and said.get("reason"):
            # thinker answered for the tool: its words are the result the model reads
            return ToolMessage(content=str(said["reason"]), tool_call_id=call.get("id"), name=call.get("name"))
        return None

    def _after_tool(self, request: ToolCallRequest, result: Any) -> None:
        if not self.available():
            return
        call = request.tool_call
        output = _text(result.content) if isinstance(result, ToolMessage) else ""
        self._post(
            "tool",
            {
                "session": self._session(request.state),
                "tool": call.get("name"),
                "input": call.get("args"),
                "call_id": call.get("id"),
                "output": output[:OUTPUT_CAP],
                "output_chars": len(output),
                "error": getattr(result, "status", None) == "error",
            },
            HOOK_TIMEOUT,
        )

    def wrap_tool_call(self, request: ToolCallRequest, handler: Callable[[ToolCallRequest], Any]) -> Any:
        answered = self._before_tool(request)
        if answered is not None:
            return answered
        result = handler(request)
        self._after_tool(request, result)
        return result

    async def awrap_tool_call(self, request: ToolCallRequest, handler: Callable[[ToolCallRequest], Awaitable[Any]]) -> Any:
        answered = await asyncio.to_thread(self._before_tool, request)
        if answered is not None:
            return answered
        result = await handler(request)
        await asyncio.to_thread(self._after_tool, request, result)
        return result

    # ---- the run ends --------------------------------------------------------------------------

    def after_agent(self, state: ThinkerState, runtime: Any) -> dict[str, Any] | None:
        if self.available():
            answer = next((_text(m.content) for m in reversed(state.get("messages", [])) if isinstance(m, AIMessage)), "")
            self._post("stop", {"session": self._session(state), "answer": answer}, HOOK_TIMEOUT)
        return None

    async def aafter_agent(self, state: ThinkerState, runtime: Any) -> dict[str, Any] | None:
        return await asyncio.to_thread(self.after_agent, state, runtime)
