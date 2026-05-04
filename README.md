# ComfyUI Slapshot

A ComfyUI custom node that submits AI-powered rotoscoping jobs to the [Slapshot](https://slapshot.ai) API and reports completion inline in the graph.

## What it does

The **Slapshot — Rotoscoping** node automates the full rotoscoping pipeline:

1. **Validates** your inputs — checks the video is `.mp4` or `.mov`, and that every reference mask path ends with a 5-digit frame number (e.g. `00000.png`).
2. **Submits** a rotoscoping job to the Slapshot API, attaching your video and any reference mask frames.
3. **Polls** the job status every 60 seconds (up to 5 hours) and shows live progress in the ComfyUI console.
4. **Displays** a completion summary directly on the node once the job finishes. Results are delivered to the email associated with your API key.

## Inputs

| Input | Description |
|---|---|
| `video_s3_path` | S3 URI of the source video (`s3://bucket/path/video.mp4` or `.mov`) |
| `api_key` | Your Slapshot API key |
| `output_s3_path` | S3 URI prefix where output masks will be written |
| `mask_s3_paths` | Comma-separated S3 URIs of reference mask frames — each must end with a 5-digit frame number, e.g. `s3://bucket/masks/00000.png` |

## Output

The node outputs a `status_message` string with a JSON summary:

```json
{
  "status": "complete",
  "message": "Check your email for the output path.",
  "percent_complete": 100,
  "total": 1,
  "total_completed": 1,
  "total_failed": 0,
  "total_cancelled": 0
}
```

## Installation

### Via ComfyUI Manager

Search for **Slapshot** in the ComfyUI Manager and click Install.

Then restart ComfyUI.

## Requirements

- A Slapshot API key — sign up at [slapshot.ai](https://slapshot.ai)
- Video and mask files accessible via S3
