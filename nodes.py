"""
Slapshot Rotoscoping Node
=========================
Submits a rotoscoping job for a video stored in S3, polls until complete,
and reports the result. Output is delivered via email — the node confirms
completion with a message to check email for the output path.
"""

import os
import re
import time
import json
import requests

BASE_URL = os.environ.get("SLAPSHOT_BASE_URL", "https://autopilot.slapshot.work").rstrip("/")

POLL_INTERVAL_SECONDS = 60
REQUEST_TIMEOUT = 30
MAX_POLL_SECONDS = 5 * 60 * 60  # 5 hours


def _headers(api_key: str) -> dict:
    return {
        "x-api-key": api_key.strip(),
        "Content-Type": "application/json",
    }


class SlapshotRotoscopingNode:
    """
    Same as SlapshotRotoscopingNode but accepts one or more reference mask S3 paths
    supplied as a comma-separated string. Each path is sent as an element of
    'references_path' in the service payload.
    """

    CATEGORY = "Slapshot"
    FUNCTION = "run_rotoscoping_with_masks"
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status_message",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_s3_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "s3://bucket/path/to/video.mp4",
                }),
                "api_key": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "your-api-key",
                }),
                "output_s3_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "s3://bucket/path/to/output/",
                }),
                "mask_s3_paths": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "s3://bucket/mask1.png, s3://bucket/mask2.png",
                }),
            }
        }

    def run_rotoscoping_with_masks(
        self,
        video_s3_path: str,
        api_key: str,
        output_s3_path: str,
        mask_s3_paths: str,
    ):
        # ── Validate inputs ───────────────────────────────────────────────────
        api_key        = api_key.strip()
        video_s3_path  = video_s3_path.strip()
        output_s3_path = output_s3_path.strip()

        if not api_key:
            raise ValueError("[RotoscopingMasks] api_key is required.")
        if not video_s3_path:
            raise ValueError("[RotoscopingMasks] video_s3_path is required.")
        if not output_s3_path:
            raise ValueError("[RotoscopingMasks] output_s3_path is required.")

        lower = video_s3_path.lower()
        if not (lower.endswith(".mp4") or lower.endswith(".mov")):
            raise ValueError(
                f"[RotoscopingMasks] Unsupported file type. "
                f"Only .mp4 and .mov are accepted, got: '{video_s3_path}'"
            )

        references = [p.strip() for p in mask_s3_paths.split(",") if p.strip()]

        invalid = [p for p in references if not re.search(r"\d{5}\.png$", p)]
        if invalid:
            raise ValueError(
                f"[RotoscopingMasks] Each mask path must end with a 5-digit frame number "
                f"followed by '.png' (e.g. '00000.png'). Invalid paths: {invalid}"
            )

        # ── Submit job ────────────────────────────────────────────────────────
        submit_url = f"{BASE_URL}/api/jobs"
        service = {
            "type": "roto",
            "output_path": output_s3_path,
        }
        if references:
            service["references_path"] = references

        payload = {
            "assets": [
                {
                    "source_path": video_s3_path,
                    "services": [service],
                }
            ]
        }
        print(f"[RotoscopingMasks] Submitting job to {submit_url} ...")
        print(f"[RotoscopingMasks] Payload: {json.dumps(payload, indent=2)}")

        try:
            resp = requests.post(
                submit_url,
                json=payload,
                headers=_headers(api_key),
                timeout=REQUEST_TIMEOUT,
            )
            print(f"[RotoscopingMasks] Submission response: {resp.status_code} {resp.text[:300]}")
            resp.raise_for_status()
        except requests.exceptions.HTTPError:
            code = resp.status_code
            if code == 401:
                raise PermissionError("[RotoscopingMasks] Invalid API key (401).")
            elif code == 403:
                raise PermissionError("[RotoscopingMasks] API key lacks permission (403).")
            raise RuntimeError(f"[RotoscopingMasks] Job submission failed ({code}): {resp.text[:300]}")
        except requests.exceptions.ConnectionError:
            raise RuntimeError(f"[RotoscopingMasks] Cannot reach {BASE_URL} — check your network.")
        except requests.exceptions.Timeout:
            raise RuntimeError("[RotoscopingMasks] Job submission timed out.")

        job_id = resp.json().get("job_id")
        if not job_id:
            raise RuntimeError(
                f"[RotoscopingMasks] Unexpected response — no job_id returned: {resp.text[:300]}"
            )
        print(f"[RotoscopingMasks] Job submitted. job_id={job_id}")

        # ── Poll for completion ───────────────────────────────────────────────
        status_url = f"{BASE_URL}/api/jobs/{job_id}"
        poll_num   = 0
        poll_start = time.monotonic()

        try:
            from comfy.utils import ProgressBar
            pbar = ProgressBar(100)
        except ImportError:
            pbar = None

        while True:
            time.sleep(POLL_INTERVAL_SECONDS)
            poll_num += 1

            elapsed = time.monotonic() - poll_start
            if elapsed > MAX_POLL_SECONDS:
                raise RuntimeError(
                    f"[RotoscopingMasks] Job {job_id} did not complete within 5 hours "
                    f"({poll_num} polls). Giving up."
                )

            print(f"[RotoscopingMasks] Poll #{poll_num}: GET {status_url}")
            try:
                poll_resp = requests.get(
                    status_url,
                    headers=_headers(api_key),
                    timeout=REQUEST_TIMEOUT,
                )
                print(
                    f"[RotoscopingMasks] Poll #{poll_num} response: "
                    f"status={poll_resp.status_code} "
                    f"elapsed={poll_resp.elapsed.total_seconds():.2f}s "
                    f"body={poll_resp.text[:500]}"
                )
            except requests.exceptions.RequestException as e:
                print(f"[RotoscopingMasks] Network error on poll #{poll_num} (will retry): {type(e).__name__}: {e}")
                continue

            if poll_resp.status_code == 429:
                print("[RotoscopingMasks] Rate limited — backing off one extra minute...")
                time.sleep(60)
                continue

            try:
                poll_resp.raise_for_status()
            except requests.exceptions.HTTPError:
                code = poll_resp.status_code
                print(
                    f"[RotoscopingMasks] Poll #{poll_num} HTTP error: "
                    f"url={poll_resp.url} status={code} body={poll_resp.text[:500]}"
                )
                if code == 401:
                    raise PermissionError("[RotoscopingMasks] Invalid API key (401).")
                raise RuntimeError(
                    f"[RotoscopingMasks] Status check failed ({code}): {poll_resp.text[:300]}"
                )

            data             = poll_resp.json()
            percent_complete = data.get("percent_complete", 0)
            total            = data.get("total", 0)
            total_pending    = data.get("total_pending", 0)
            total_running    = data.get("total_running", 0)
            total_completed  = data.get("total_completed", 0)
            total_failed     = data.get("total_failed", 0)
            total_cancelled  = data.get("total_cancelled", 0)

            if pbar is not None:
                pbar.update_absolute(percent_complete)

            print(
                f"[RotoscopingMasks] Poll #{poll_num}: "
                f"{percent_complete}% complete — "
                f"total={total} pending={total_pending} running={total_running} "
                f"completed={total_completed} failed={total_failed} cancelled={total_cancelled}"
            )

            if total > 0 and total_pending == 0 and total_running == 0:
                if total_completed == 0:
                    summary = {
                        "status": "error",
                        "message": "No tasks completed.",
                        "total": total,
                        "total_failed": total_failed,
                        "total_cancelled": total_cancelled,
                    }
                    raise RuntimeError(
                        f"[RotoscopingMasks] Job failed — "
                        f"{total_failed} failed, {total_cancelled} cancelled out of {total} total.\n"
                        + json.dumps(summary, indent=2)
                    )

                summary = {
                    "status": "complete" if total_completed == total else "partial",
                    "message": "Check your email for the output path.",
                    "percent_complete": percent_complete,
                    "total": total,
                    "total_completed": total_completed,
                    "total_failed": total_failed,
                    "total_cancelled": total_cancelled,
                }
                display = json.dumps(summary, indent=2)
                print(f"[RotoscopingMasks] Done:\n{display}")
                return {"ui": {"text": [display]}, "result": (display,)}


# ── Registration ──────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "Slapshot_Rotoscoping": SlapshotRotoscopingNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Slapshot_Rotoscoping": "Slapshot — Rotoscoping",
}
