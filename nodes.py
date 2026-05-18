"""
Slapshot Rotoscoping Node
=========================
Submits a rotoscoping job for a ComfyUI VIDEO input plus zero-or-more MASK
inputs. Inputs are uploaded to Slapshot via pre-signed PUT URLs, the job is
polled until complete, and a download URL is fetched and surfaced to the UI
so the user can click a button to retrieve the result.
"""

import os
import time
import json
import threading
import tempfile
import requests

BASE_URL = os.environ.get("SLAPSHOT_BASE_URL", "https://autopilot.slapshot.work").rstrip("/")

POLL_INTERVAL_SECONDS = 60
REQUEST_TIMEOUT = 30
UPLOAD_TIMEOUT = 600  # 10 minutes per file
MAX_POLL_SECONDS = 5 * 60 * 60  # 5 hours


def _headers(api_key: str) -> dict:
    return {
        "x-api-key": api_key.strip(),
        "Content-Type": "application/json",
    }


def _presign_upload(api_key: str, filename: str) -> dict:
    url = f"{BASE_URL}/api/uploads"
    resp = requests.post(
        url,
        json={"filename": filename},
        headers=_headers(api_key),
        timeout=REQUEST_TIMEOUT,
    )
    if resp.status_code == 401:
        raise PermissionError("[RotoscopingMasks] Invalid API key (401) when requesting upload URL.")
    if resp.status_code == 403:
        raise PermissionError("[RotoscopingMasks] API key lacks permission (403) for uploads.")
    resp.raise_for_status()
    data = resp.json()
    if "upload_url" not in data or "s3_path" not in data:
        raise RuntimeError(
            f"[RotoscopingMasks] Unexpected presign response — missing upload_url/s3_path: {resp.text[:300]}"
        )
    return data


def _put_file(file_path: str, upload_url: str):
    # No Content-Type header — let the HTTP client default. Setting one risks a
    # mismatch with how the presigned URL was signed on the server side.
    with open(file_path, "rb") as f:
        put_resp = requests.put(upload_url, data=f, timeout=UPLOAD_TIMEOUT)
    if not put_resp.ok:
        raise RuntimeError(
            f"[RotoscopingMasks] Upload PUT failed ({put_resp.status_code}): {put_resp.text[:300]}"
        )


def _upload_local_file(api_key: str, file_path: str, filename: str) -> str:
    presigned = _presign_upload(api_key, filename)
    _put_file(file_path, presigned["upload_url"])
    return presigned["s3_path"]


def _save_video_to_tempfile(video) -> str:
    fd, path = tempfile.mkstemp(suffix=".mp4", prefix="slapshot_video_")
    os.close(fd)
    if not hasattr(video, "save_to"):
        raise RuntimeError(
            "[RotoscopingMasks] VIDEO input does not expose save_to(); "
            "upgrade ComfyUI or wire a compatible VIDEO source."
        )
    video.save_to(path)
    return path


def _save_mask_to_tempfile(mask_tensor, frame_idx: int):
    import numpy as np
    from PIL import Image

    arr = mask_tensor.detach().cpu().numpy() if hasattr(mask_tensor, "detach") else np.asarray(mask_tensor)
    if arr.ndim == 3 and arr.shape[0] == 1:
        arr = arr[0]
    if arr.ndim != 2:
        raise ValueError(f"[RotoscopingMasks] Unexpected mask tensor shape: {arr.shape}")
    arr = (np.clip(arr, 0.0, 1.0) * 255.0).astype("uint8")

    name = f"{frame_idx:05d}.png"
    fd, path = tempfile.mkstemp(suffix=f"_{name}", prefix="slapshot_mask_")
    os.close(fd)
    Image.fromarray(arr, mode="L").save(path)
    return path, name


def _iter_mask_frames(mask):
    if mask.ndim == 2:
        yield mask
    elif mask.ndim == 3:
        for i in range(mask.shape[0]):
            yield mask[i]
    elif mask.ndim == 4:
        for i in range(mask.shape[0]):
            yield mask[i, 0]
    else:
        raise ValueError(f"[RotoscopingMasks] Unsupported mask tensor rank: {mask.ndim}")


class SlapshotRotoscopingNode:
    """
    Accepts a ComfyUI VIDEO input and an optional MASK batch, uploads them via
    pre-signed PUT URLs, submits a rotoscoping job, polls until complete, then
    fetches a signed download URL for the result.
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
                "video": ("VIDEO",),
                "api_key": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "your-api-key",
                    "password": True,
                }),
            },
            "optional": {
                "masks": ("MASK",),
            },
        }

    def run_rotoscoping_with_masks(self, video, api_key, masks=None):
        api_key = api_key.strip()

        if not api_key:
            raise ValueError("[RotoscopingMasks] api_key is required.")
        if video is None:
            raise ValueError("[RotoscopingMasks] video input is required.")

        # ── Upload video ──────────────────────────────────────────────────────
        video_local = _save_video_to_tempfile(video)
        try:
            print(f"[RotoscopingMasks] Uploading video clip.mp4 ...")
            video_s3 = _upload_local_file(api_key, video_local, "clip.mp4")
            print(f"[RotoscopingMasks] Video uploaded → {video_s3}")
        finally:
            try: os.unlink(video_local)
            except OSError: pass

        # ── Upload masks (single batched MASK input, optional) ────────────────
        references = []
        if masks is not None:
            for frame_idx, single in enumerate(_iter_mask_frames(masks)):
                local_path, png_name = _save_mask_to_tempfile(single, frame_idx)
                try:
                    print(f"[RotoscopingMasks] Uploading mask {png_name} ...")
                    s3_path = _upload_local_file(api_key, local_path, png_name)
                    references.append(s3_path)
                    print(f"[RotoscopingMasks] Mask uploaded → {s3_path}")
                finally:
                    try: os.unlink(local_path)
                    except OSError: pass

        # ── Submit job ────────────────────────────────────────────────────────
        submit_url = f"{BASE_URL}/api/jobs"
        service = {"type": "roto"}
        if references:
            service["references_path"] = references

        payload = {"assets": [{"source_path": video_s3, "services": [service]}]}
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

        # ── Poll for completion (background thread) ───────────────────────────
        status_url = f"{BASE_URL}/api/jobs/{job_id}"

        try:
            from comfy.utils import ProgressBar
            pbar = ProgressBar(100)
        except ImportError:
            pbar = None

        done_event = threading.Event()
        result_box: dict = {}

        def _poll():
            poll_num   = 0
            poll_start = time.monotonic()

            while True:
                time.sleep(POLL_INTERVAL_SECONDS)
                poll_num += 1

                elapsed = time.monotonic() - poll_start
                if elapsed > MAX_POLL_SECONDS:
                    result_box["error"] = RuntimeError(
                        f"[RotoscopingMasks] Job {job_id} did not complete within 5 hours "
                        f"({poll_num} polls). Giving up."
                    )
                    done_event.set()
                    return

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
                        result_box["error"] = PermissionError("[RotoscopingMasks] Invalid API key (401).")
                    else:
                        result_box["error"] = RuntimeError(
                            f"[RotoscopingMasks] Status check failed ({code}): {poll_resp.text[:300]}"
                        )
                    done_event.set()
                    return

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
                        result_box["error"] = RuntimeError(
                            f"[RotoscopingMasks] Job failed — "
                            f"{total_failed} failed, {total_cancelled} cancelled out of {total} total."
                        )
                        done_event.set()
                        return

                    summary = {
                        "status": "complete" if total_completed == total else "partial",
                        "percent_complete": percent_complete,
                        "total": total,
                        "total_completed": total_completed,
                        "total_failed": total_failed,
                        "total_cancelled": total_cancelled,
                    }
                    result_box["value"] = summary
                    done_event.set()
                    return

        t = threading.Thread(target=_poll, daemon=True)
        t.start()

        # Wait in short increments so ComfyUI can process interrupts/signals.
        while not done_event.wait(timeout=5):
            pass

        if "error" in result_box:
            raise result_box["error"]

        # ── Fetch download URL ────────────────────────────────────────────────
        download_url = None
        try:
            dl_resp = requests.get(
                f"{BASE_URL}/api/jobs/{job_id}/download",
                headers=_headers(api_key),
                timeout=REQUEST_TIMEOUT,
            )
            if dl_resp.ok:
                download_url = dl_resp.json().get("download_url")
                print(f"[RotoscopingMasks] Download URL retrieved.")
            else:
                print(
                    f"[RotoscopingMasks] Could not retrieve download URL "
                    f"({dl_resp.status_code}): {dl_resp.text[:300]}"
                )
        except requests.exceptions.RequestException as e:
            print(f"[RotoscopingMasks] Network error fetching download URL: {e}")

        summary = result_box["value"]
        summary["download_url"] = download_url
        display = json.dumps(summary, indent=2)
        print(f"[RotoscopingMasks] Done:\n{display}")

        ui_payload = {"text": [display]}
        if download_url:
            ui_payload["download_url"] = [download_url]
        return {"ui": ui_payload, "result": (display,)}


# ── Registration ──────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "Slapshot_Rotoscoping": SlapshotRotoscopingNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Slapshot_Rotoscoping": "Slapshot — Rotoscoping",
}
