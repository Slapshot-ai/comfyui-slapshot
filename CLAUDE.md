# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A ComfyUI custom node package. It is loaded by ComfyUI at startup — there is no build step, test suite, or linter configured. To exercise changes, drop the repo into `ComfyUI/custom_nodes/` (it already lives there) and restart ComfyUI.

- Runtime dep: `requests` (see `requirements.txt` / `pyproject.toml`).
- Python entrypoint: `__init__.py` exports `NODE_CLASS_MAPPINGS`, `NODE_DISPLAY_NAME_MAPPINGS`, and `WEB_DIRECTORY = "./web/js"` so ComfyUI serves the JS extension.

## Architecture

Two halves, glued by ComfyUI's node-execution + extension system:

**Backend — `nodes.py`** registers `SlapshotRotoscopingNode` (display name `Slapshot — Rotoscoping`). One execution does three things in sequence:
1. Validates inputs locally: video extension must be `.mp4`/`.mov`; every comma-separated mask S3 path must match `\d{5}\.png$` (5-digit frame number).
2. `POST {BASE_URL}/api/jobs` with a payload of shape `{"assets": [{"source_path", "services": [{"type": "roto", "output_path", "references_path"}]}]}`, authenticated via `x-api-key` header. Extracts `job_id` from the response.
3. Polls `GET {BASE_URL}/api/jobs/{job_id}` every 60s in a **background thread**, capped at 5 hours. The main thread blocks on `done_event.wait(timeout=5)` so ComfyUI can still process interrupts/signals between polls. Completion is detected when `total > 0 and total_pending == 0 and total_running == 0`. Result is delivered out-of-band (email); the node only returns a JSON summary string and pushes it to the UI via `{"ui": {"text": [...]}}`.

`BASE_URL` is configurable via the `SLAPSHOT_BASE_URL` env var; default is `https://autopilot.slapshot.ai`. 429 responses trigger an extra 60s backoff; transient network errors are logged and retried on the next poll tick. 401/403 on submit raise `PermissionError`; 401 during polling raises the same.

If `comfy.utils.ProgressBar` is importable, the poller pushes `percent_complete` into it — this is what drives the ComfyUI progress bar on the node.

**Frontend — `web/js/slapshot.js`** registers two ComfyUI extensions:
- `Slapshot.TextPreview` — adds a read-only multiline `preview_text` widget to nodes whose name is in the `PREVIEW_NODES` list, and on `onExecuted` copies `message.text` (sent from Python via `{"ui": {"text": [...]}}`) into it. `PREVIEW_NODES` intentionally includes node names not currently registered in `nodes.py` (`Slapshot_Rotoscoping_Download`, `Slapshot_Rotoscoping_Masks`, `Slapshot_Dynamic_Masks_Test`) so the UI is ready when those backends land — keep the list in sync if you add or rename nodes.
- `Slapshot.DynamicMasks` — only for `Slapshot_Dynamic_Masks_Test`. Hides the underlying `mask_paths_json` STRING widget and replaces it with a dynamic list of `+ Add` / `✕` rows whose values are serialised back to that hidden widget. `onConfigure` defers row rebuild by one `requestAnimationFrame` because LiteGraph applies widget values *after* `onConfigure` returns — don't remove that defer.

## Conventions worth knowing

- Log prefix `[RotoscopingMasks]` is used throughout `nodes.py`; keep it on new prints in this node so the ComfyUI console stays greppable.
- Errors surfaced to the user should be `raise`d as `ValueError` / `PermissionError` / `RuntimeError` — ComfyUI renders these inline on the failing node. Don't swallow them into the status string.
- The node is `OUTPUT_NODE = True` and returns `{"ui": {...}, "result": (...)}` — the `ui.text` path is what the JS preview widget reads.
