"""
Slapshot Rotoscoping Node
=========================
Accepts a ComfyUI VIDEO input and up to 10 optional IMAGE inputs (connect outputs
from Load Image nodes directly). Uploads the video and mask frames via presigned
URLs obtained from the Slapshot API, submits a rotoscoping job, polls until
complete, and surfaces download buttons for the results.
"""

import os
import re
import uuid
import time
import json
import threading
import tempfile
import torch
import requests
import folder_paths

BASE_URL = os.environ.get("SLAPSHOT_BASE_URL", "https://autopilot.slapshot.work").rstrip("/")

POLL_INTERVAL_SECONDS = 60
REQUEST_TIMEOUT = 30
MAX_POLL_SECONDS = 5 * 60 * 60  # 5 hours

_MASK_FILENAME_RE = re.compile(r"^\d{5}\.png$")

S3_OUTPUT_PREFIX = "comfyui-autopilot"
JOB_SOURCE = "comfyui"


# ── Download proxy (avoids browser CORS on the external API) ─────────────────

try:
    from server import PromptServer as _PS
    from aiohttp import web as _web

    @_PS.instance.routes.post("/slapshot/download_url")
    async def _slapshot_download_url(request):
        try:
            body = await request.json()
        except Exception:
            return _web.json_response({"error": "Invalid JSON"}, status=400)

        job_id      = body.get("job_id", "").strip()
        export_type = body.get("export_type", "").strip()
        api_key     = body.get("api_key", "").strip()
        base_url    = body.get("base_url", BASE_URL).rstrip("/")

        if not job_id or not export_type or not api_key:
            return _web.json_response({"error": "Missing required parameters"}, status=400)

        url = f"{base_url}/api/comfyui/{job_id}/result?export_type={export_type}"
        print(f"[RotoscopingMasks] download_result → GET {url}")
        resp = None
        try:
            resp = requests.get(url, headers={"x-api-key": api_key}, timeout=REQUEST_TIMEOUT)
            print(f"[RotoscopingMasks] download_result ← {resp.status_code}: {resp.text[:300]}")
            resp.raise_for_status()
            return _web.json_response(resp.json())
        except requests.exceptions.HTTPError:
            return _web.json_response(
                {"error": f"API error {resp.status_code}: {resp.text[:200]}"}, status=502
            )
        except Exception as exc:
            return _web.json_response({"error": str(exc)}, status=500)

except Exception:
    pass


# ── Progress helper ───────────────────────────────────────────────────────────

def _send_progress(node_id, text: str) -> None:
    """Push a status text update to the node's preview widget via websocket."""
    if node_id is None:
        return
    print(f"[RotoscopingMasks] {text}")
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("slapshot_progress", {
            "node_id": str(node_id),
            "text": text,
        })
    except Exception:
        pass


# ── Presigned URL upload helpers ──────────────────────────────────────────────

def _get_presigned_upload_url(base_url: str, api_key: str, upload_id: str,
                               asset_type: str, file_name: str) -> tuple:
    """Returns (upload_url, s3_key)."""
    url = (f"{base_url}/api/comfyui/assets/upload"
           f"?upload_id={upload_id}&asset_type={asset_type}&file_name={file_name}")
    resp = requests.get(url, headers={"x-api-key": api_key}, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    upload_url = data.get("upload_url")
    s3_key = data.get("s3_key")
    if not upload_url or not s3_key:
        raise RuntimeError(
            f"[RotoscopingMasks] Missing upload_url or s3_key in upload response: {resp.text[:300]}"
        )
    return upload_url, s3_key


def _upload_to_presigned_url(presigned_url: str, local_path: str) -> None:
    file_size = os.path.getsize(local_path)
    with open(local_path, "rb") as f:
        resp = requests.put(
            presigned_url,
            data=f,
            headers={"Content-Length": str(file_size)},
            timeout=300,
        )
    resp.raise_for_status()


# ── Mask / image tensor helpers ───────────────────────────────────────────────

def _validate_mask_filename(name: str) -> None:
    if not _MASK_FILENAME_RE.match(name):
        raise ValueError(
            f"[RotoscopingMasks] Mask filename '{name}' does not match the required "
            f"pattern '{{num:05d}}.png' (e.g. '00000.png')."
        )


def _iter_image_frames(tensor):
    """Yield individual frames from a MASK (B,H,W) or IMAGE (B,H,W,C) tensor."""
    ndim = tensor.ndim
    if ndim == 2:
        yield tensor                           # (H,W) — single MASK frame
    elif ndim == 3:
        if tensor.shape[-1] in (1, 3, 4):
            yield tensor                       # (H,W,C) — single IMAGE frame
        else:
            for i in range(tensor.shape[0]):
                yield tensor[i]                # (B,H,W) — batch of MASK frames
    elif ndim == 4:
        for i in range(tensor.shape[0]):
            yield tensor[i]                    # (B,H,W,C) — batch of IMAGE frames
    else:
        raise ValueError(f"[RotoscopingMasks] Unsupported tensor rank: {ndim}")


def _save_mask_to_tempfile(frame, frame_idx: int) -> tuple:
    """Save a single mask/image frame as a grayscale PNG. Returns (local_path, filename)."""
    import numpy as np
    from PIL import Image

    arr = frame.detach().cpu().numpy() if hasattr(frame, "detach") else np.asarray(frame)

    if arr.ndim == 3:
        # IMAGE frame (H, W, C) → grayscale via luminance
        if arr.shape[2] == 1:
            arr = arr[:, :, 0]
        else:
            arr = 0.2989 * arr[:, :, 0] + 0.5870 * arr[:, :, 1] + 0.1140 * arr[:, :, 2]
    elif arr.ndim != 2:
        raise ValueError(f"[RotoscopingMasks] Unexpected frame shape: {arr.shape}")

    gray = (arr.clip(0.0, 1.0) * 255.0).astype("uint8")

    # Inference code expects RGB with red pixels (255,0,0) for masked areas.
    rgb = np.zeros((*gray.shape, 3), dtype="uint8")
    rgb[gray > 0] = (255, 0, 0)

    name = f"{frame_idx:05d}.png"
    _validate_mask_filename(name)
    fd, path = tempfile.mkstemp(suffix=f"_{name}", prefix="slapshot_mask_")
    os.close(fd)
    Image.fromarray(rgb, mode="RGB").save(path)
    return path, name


# ── Video helpers ─────────────────────────────────────────────────────────────

_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}


def _extract_video_filename(video) -> str | None:
    """Return the original video filename from any VIDEO object shape, or None."""
    def _looks_like_video(s):
        return isinstance(s, str) and os.path.splitext(s)[1].lower() in _VIDEO_EXTS

    # 1. Plain string path
    if _looks_like_video(video):
        return os.path.basename(video)

    # 2. Dict — check common keys, then recurse one level into nested dicts
    if isinstance(video, dict):
        for key in ("filename", "name", "path", "source", "video_path", "source_path", "filepath"):
            if _looks_like_video(video.get(key)):
                return os.path.basename(video[key])
        for val in video.values():
            if isinstance(val, dict):
                result = _extract_video_filename(val)
                if result:
                    return result

    # 3. Object attributes — common names first, then full scan
    for attr in ("filename", "name", "path", "video_path", "source_path", "file_path", "source", "filepath"):
        val = getattr(video, attr, None)
        if _looks_like_video(val):
            return os.path.basename(val)

    if hasattr(video, "__dict__"):
        for val in vars(video).values():
            if _looks_like_video(val):
                return os.path.basename(val)

    return None


def _find_video_source_file(video, filename: str | None) -> str | None:
    """Return an absolute path to the source video file if it can be found on disk."""
    _ATTRS = ("path", "video_path", "source_path", "file_path", "filepath", "source", "filename", "name")
    input_dir = folder_paths.get_input_directory()

    candidates = []
    for attr in _ATTRS:
        val = getattr(video, attr, None)
        if isinstance(val, str) and val:
            candidates.append(val)
    if filename:
        candidates.append(filename)

    for c in candidates:
        if os.path.isfile(c):
            return c
        resolved = os.path.join(input_dir, os.path.basename(c))
        if os.path.isfile(resolved):
            return resolved

    return None


def _get_video_frame_count(video_path: str) -> int | None:
    """Return the frame count of a video file, or None if it cannot be determined."""
    try:
        import cv2
        cap = cv2.VideoCapture(video_path)
        if cap.isOpened():
            count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            cap.release()
            if count > 0:
                return count
    except Exception:
        pass
    try:
        import imageio
        reader = imageio.get_reader(video_path)
        count = reader.count_frames()
        reader.close()
        if count > 0:
            return count
    except Exception:
        pass
    return None


def _save_video_locally(video) -> tuple:
    """Save a ComfyUI VIDEO object to a temp file. Returns (local_path, filename)."""
    raw = _extract_video_filename(video)
    print(f"[RotoscopingMasks] Detected video filename: {raw!r} "
          f"(object type: {type(video).__name__})")

    filename = raw if raw else "video.mp4"
    if not filename.lower().endswith((".mp4", ".mov")):
        filename = os.path.splitext(filename)[0] + ".mp4"

    # Prefer a direct copy of the original file — preserves codec/container and
    # avoids ProRes-in-mp4 transcoding errors that save_to() can trigger.
    source_file = _find_video_source_file(video, raw)
    print(f"[RotoscopingMasks] Resolved source file: {source_file!r}")

    if source_file:
        import shutil
        ext = os.path.splitext(filename)[1]
        fd, path = tempfile.mkstemp(suffix=ext, prefix="slapshot_video_")
        os.close(fd)
        shutil.copy2(source_file, path)
        return path, filename

    # Fall back to save_to() if no source file found on disk.
    def _write(ext: str) -> str:
        fd, path = tempfile.mkstemp(suffix=ext, prefix="slapshot_video_")
        os.close(fd)
        if hasattr(video, "save_to"):
            video.save_to(path)
        else:
            os.unlink(path)
            raise RuntimeError(
                "[RotoscopingMasks] VIDEO input does not expose save_to() or a resolvable "
                "path; upgrade ComfyUI or use a compatible VIDEO source."
            )
        return path

    ext = os.path.splitext(filename)[1]
    try:
        path = _write(ext)
    except (ValueError, RuntimeError) as exc:
        if ext == ".mov":
            raise
        _send_progress(None, f"Could not save as {ext} ({exc}); retrying as .mov")
        filename = os.path.splitext(filename)[0] + ".mov"
        path = _write(".mov")

    return path, filename


# ── Graph helpers ─────────────────────────────────────────────────────────────

def _mask_filename_from_prompt(unique_id, prompt, slot_name: str) -> str | None:
    """Walk the workflow graph to find the filename of the image connected to slot_name.

    ComfyUI stores links as [source_node_id, output_index] in the prompt dict.
    We follow the link from this node's slot back to the source node (LoadImage or
    Slapshot_Load_Mask) and read its 'image' widget value.
    """
    if not prompt or not unique_id:
        return None
    node_data = prompt.get(str(unique_id), {})
    link = node_data.get("inputs", {}).get(slot_name)
    if not isinstance(link, list) or len(link) < 1:
        return None
    source = prompt.get(str(link[0]), {})
    if source.get("class_type") not in ("LoadImage", "Slapshot_Load_Mask"):
        return None
    image_val = source.get("inputs", {}).get("image", "")
    name = os.path.basename(image_val) if isinstance(image_val, str) else ""
    if not _MASK_FILENAME_RE.match(name):
        raise ValueError(
            f"[RotoscopingMasks] Mask '{name}' connected to '{slot_name}' does not follow "
            f"the required naming pattern — expected a 5-digit frame number like '00014.png'."
        )
    return name


# ── API helpers ───────────────────────────────────────────────────────────────

def _headers(api_key: str) -> dict:
    return {
        "x-api-key": api_key.strip(),
        "Content-Type": "application/json",
    }


# ── Node ──────────────────────────────────────────────────────────────────────

class SlapshotRotoscopingNode:
    CATEGORY = "Slapshot"
    FUNCTION = "run_rotoscoping_with_masks"
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    RETURN_NAMES = ()

    @classmethod
    def INPUT_TYPES(cls):
        optional = {f"mask_{i:02d}": ("IMAGE",) for i in range(10)}
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
            "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID", "prompt": "PROMPT"},
        }

    def run_rotoscoping_with_masks(self, video, api_key, unique_id=None, prompt=None, **kwargs):
        api_key = (api_key or "").strip()
        if not api_key or api_key.lower() == "none":
            raise ValueError("[RotoscopingMasks] API Key is required.")

        def progress(text: str):
            _send_progress(unique_id, text)

        # Collect connected IMAGE tensors paired with their original filenames.
        # _mask_filename_from_prompt walks the workflow graph to find the filename
        # of the Load Image node connected to each slot (e.g. "00014.png" → frame 14).
        # Falls back to a sequential index when the filename cannot be determined.
        mask_inputs = []  # list of (tensor, frame_number, png_name)
        fallback_idx = 0
        for i in range(10):
            tensor = kwargs.get(f"mask_{i:02d}")
            if tensor is None:
                continue
            slot = f"mask_{i:02d}"
            fname = _mask_filename_from_prompt(unique_id, prompt, slot)
            if fname:
                frame_number = int(os.path.splitext(fname)[0])
                print(f"[RotoscopingMasks] {slot} → filename '{fname}' (frame {frame_number})")
            else:
                frame_number = fallback_idx
                print(f"[RotoscopingMasks] {slot} → no filename found, using fallback index {frame_number}")
            mask_inputs.append((tensor, frame_number, f"{frame_number:05d}.png"))
            fallback_idx += 1

        # ── Generate upload UUID (shared across video and all masks) ─────────
        upload_id = str(uuid.uuid4())
        print(f"[RotoscopingMasks] Upload ID: {upload_id}")

        # ── Upload video ──────────────────────────────────────────────────────
        video_local, video_filename = _save_video_locally(video)
        video_key = None
        try:
            video_frame_count = _get_video_frame_count(video_local)
            print(f"[RotoscopingMasks] Video frame count: {video_frame_count}")
            if video_frame_count is not None:
                if video_frame_count > 3500:
                    raise ValueError(
                        f"[RotoscopingMasks] Input video should not exceed 3500 frames "
                        f"(got {video_frame_count})."
                    )
                for _, frame_number, png_name in mask_inputs:
                    if frame_number >= video_frame_count:
                        raise ValueError(
                            f"[RotoscopingMasks] Mask '{png_name}' targets frame "
                            f"{frame_number + 1} but the video only has "
                            f"{video_frame_count} frame(s). "
                            f"Valid range: 00000–{video_frame_count - 1:05d}.png."
                        )

            progress(f"Uploading video: {video_filename}...")
            upload_url, video_key = _get_presigned_upload_url(BASE_URL, api_key, upload_id, "video", video_filename)
            _upload_to_presigned_url(upload_url, video_local)
            progress("Video uploaded ✓")
        finally:
            try:
                os.unlink(video_local)
            except OSError:
                pass

        # ── Upload masks using original filenames ─────────────────────────────
        references = []
        total_masks = len(mask_inputs)
        for upload_num, (tensor, frame_number, png_name) in enumerate(mask_inputs, start=1):
            frame = next(_iter_image_frames(tensor))
            local_path, _ = _save_mask_to_tempfile(frame, frame_number)
            try:
                progress(f"Uploading mask {upload_num}/{total_masks}: {png_name}...")
                upload_url, mask_key = _get_presigned_upload_url(BASE_URL, api_key, upload_id, "mask", png_name)
                _upload_to_presigned_url(upload_url, local_path)
                references.append(mask_key)
            finally:
                try:
                    os.unlink(local_path)
                except OSError:
                    pass

        if total_masks:
            progress(f"All {total_masks} mask(s) uploaded ✓")

        # ── Submit job ────────────────────────────────────────────────────────
        submit_url = f"{BASE_URL}/api/jobs"
        output_key = f"{S3_OUTPUT_PREFIX}/{upload_id}/output/"
        service: dict = {"type": "roto", "output_path": output_key}
        if references:
            service["references_path"] = references

        payload = {"assets": [{"source_path": video_key, "services": [service]}], "job_source": JOB_SOURCE}
        progress("Submitting job...")
        print(f"[RotoscopingMasks] Payload: {json.dumps(payload, indent=2)}")

        resp = None
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
            if code == 403:
                raise PermissionError("[RotoscopingMasks] API key lacks permission (403).")
            raise RuntimeError(f"[RotoscopingMasks] Job submission failed ({code}): {resp.text[:300]}")
        except requests.exceptions.ConnectionError:
            raise RuntimeError(f"[RotoscopingMasks] Cannot reach {BASE_URL} — check your network.")
        except requests.exceptions.Timeout:
            raise RuntimeError("[RotoscopingMasks] Job submission timed out.")

        submit_data = resp.json()
        job_id = submit_data.get("job_id")
        if not job_id:
            raise RuntimeError(
                f"[RotoscopingMasks] Unexpected response — no job_id: {resp.text[:300]}"
            )
        print(f"[RotoscopingMasks] Job submitted. job_id={job_id}")
        progress("Job submitted. Waiting for inference to start...")

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
            poll_num = 0
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

                try:
                    poll_resp = requests.get(
                        status_url,
                        headers=_headers(api_key),
                        timeout=REQUEST_TIMEOUT,
                    )
                except requests.exceptions.RequestException as e:
                    print(f"[RotoscopingMasks] Network error on poll #{poll_num} (will retry): {e}")
                    continue

                if poll_resp.status_code == 429:
                    print("[RotoscopingMasks] Rate limited — backing off one extra minute...")
                    time.sleep(60)
                    continue

                try:
                    poll_resp.raise_for_status()
                except requests.exceptions.HTTPError:
                    code = poll_resp.status_code
                    if code == 401:
                        result_box["error"] = PermissionError("[RotoscopingMasks] Invalid API key (401).")
                    else:
                        result_box["error"] = RuntimeError(
                            f"[RotoscopingMasks] Status check failed ({code}): {poll_resp.text[:300]}"
                        )
                    done_event.set()
                    return

                data = poll_resp.json()
                percent   = data.get("percent_complete", 0)
                total     = data.get("total", 0)
                pending   = data.get("total_pending", 0)
                running   = data.get("total_running", 0)
                completed = data.get("total_completed", 0)
                failed    = data.get("total_failed", 0)
                cancelled = data.get("total_cancelled", 0)

                if pbar is not None:
                    pbar.update_absolute(percent)

                progress(f"Running inference... {percent}% complete")

                if total > 0 and pending == 0 and running == 0:
                    if completed == 0:
                        result_box["error"] = RuntimeError(
                            f"[RotoscopingMasks] Inference failed — "
                            f"{failed} failed, {cancelled} cancelled out of {total}."
                        )
                        done_event.set()
                        return

                    result_box["value"] = {
                        "status": "complete" if completed == total else "partial",
                        "percent_complete": percent,
                    }
                    done_event.set()
                    return

        t = threading.Thread(target=_poll, daemon=True)
        t.start()

        while not done_event.wait(timeout=5):
            pass

        if "error" in result_box:
            raise result_box["error"]

        progress("Inference completed ✓ Check your Email")

        display = "Inference completed ✓ Check your Email"
        print(f"[RotoscopingMasks] Done. job_id={job_id}")

        return {
            "ui": {
                "text":     [display],
                "job_id":   [job_id],
                "base_url": [BASE_URL],
            },
            "result": (),
        }

# ── Registration ──────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "Slapshot_Rotoscoping": SlapshotRotoscopingNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "Slapshot_Rotoscoping": "Slapshot — Rotoscoping",
}
