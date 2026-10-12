# mlflow-v1B

The candidate-B mining prompt (PR #204, `bench/serving/system-B.txt`) over the same 250 pull requests
as mlflow-v1: `mine-prs --before 2026-09-20T23:42:26Z --limit 200 --model haiku` (claude-haiku-5-5),
then the shipped `phrase --model haiku` in several passes (Claude pinned runs skipped batches on an
intermittent "stop_sequence" exit; 4 batches came from the Gemini fallback). 236 notes. Nothing from
a task PR. See bench/serving/README.md.
