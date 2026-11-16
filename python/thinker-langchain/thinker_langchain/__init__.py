"""thinker for LangChain agents: one middleware that wires the proxy and the hooks together.

    from thinker_langchain import Thinker
    agent = create_agent(model, tools, middleware=[Thinker()])

That one entry does both halves, so an agent never has one without the other:

* the agent's model calls go through thinker's proxy, which cuts finished tool results out of the
  context (the same cut a coding agent gets), each run tagged with its own session;
* thinker's hooks fire at the same points they do in a coding agent: when a prompt arrives, before
  and after each tool call, and when the run ends.

thinker itself runs beside the agent (the thinker container, docker/thinker in its repository). If it cannot be reached the
agent runs exactly as it would without this middleware: a hook never fails a tool call, and the
model is only rerouted while the service answers.
"""

from .middleware import Thinker, ThinkerState

__all__ = ["Thinker", "ThinkerState"]
__version__ = "0.1.0"
