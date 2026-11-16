"""A LangChain agent with thinker wired in. The one line that does it is the `middleware=` argument."""
from langchain.agents import create_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool
from thinker_langchain import Thinker


@tool
def word_count(text: str) -> int:
    """Count the words in a text."""
    return len(text.split())


agent = create_agent(
    ChatAnthropic(model="claude-sonnet-5-5"),
    [word_count],
    middleware=[Thinker("http://thinker:7000", name="example")],
)

if __name__ == "__main__":
    out = agent.invoke({"messages": [{"role": "user", "content": "How many words are in 'the quick brown fox'?"}]})
    print(out["messages"][-1].content)
