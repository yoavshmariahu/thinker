FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir langchain langchain-anthropic \
    "thinker-langchain @ git+https://github.com/yoavshmariahu/thinker#subdirectory=python/thinker-langchain"
COPY agent.py .
CMD ["python", "agent.py"]
