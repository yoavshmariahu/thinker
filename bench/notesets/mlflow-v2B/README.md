# mlflow-v2B

The candidate-B mining prompt (PR #204, `bench/serving/system-B.txt`) over the same 250 pull requests
as mlflow-v2: `mine-prs --before 2026-09-30T23:45:45Z --limit 250 --model haiku` (claude-haiku-5-5,
593 s, ~1.9M tokens), then the shipped `phrase --model haiku` (4 of 31 batches fell back to Gemini).
244 notes, every body with a "Path:" line. Nothing from a task PR. See bench/serving/README.md.
