# ComfyUI Slapshot

A ComfyUI custom node package that submits AI-powered video processing jobs to the [Slapshot](https://slapshot.ai) API and reports completion inline in the graph.

## Nodes

### Slapshot — Rotoscoping

Automates the full rotoscoping pipeline — upload a video with optional reference mask frames, submit a job, and download the resulting mattes when inference completes.

**Inputs**

| Input | Type | Description |
|---|---|---|
| `video` | VIDEO | Source video (`.mp4` or `.mov`) |
| `mask_00` … `mask_09` | IMAGE _(optional)_ | Up to 10 reference mask frames. Each must be loaded from a file named with a 5-digit frame number, e.g. `00014.png` |

**Download buttons (enabled after inference)**

- **Download Hard Mattes** — binary alpha mask per frame
- **Download MB Mattes** — motion-blur-aware matte per frame

---

### Slapshot — Depth Map

Generates a depth map video from a source video.

**Inputs**

| Input | Type | Description |
|---|---|---|
| `video` | VIDEO | Source video (`.mp4` or `.mov`) |
| `export_type` | COMBO | Output format — `JPG` or `MOV` (default: `JPG`) |

**Download buttons (enabled after inference)**

- **Download Depth Map** — downloads the depth map in the selected format

---

### Slapshot — Tracking

Runs camera tracking on a source video with optional camera and scene parameters.

**Inputs**

| Input | Type | Default | Description                                                                                                  |
|---|---|---|--------------------------------------------------------------------------------------------------------------|
| `video` | VIDEO | — | Source video (`.mp4` or `.mov`)                                                                              |
| `working_fps` | STRING _(optional)_ | — | Working frames per second (e.g. `24.0`)                                                                      |
| `lens` | STRING _(optional)_ | — | Lens focal length in mm                                                                                      |
| `fix_focal_length` | COMBO _(optional)_ | `False` | `False` = Floating, `True` = Fixed                                                                           |
| `sensor_width` | STRING _(optional)_ | — | Sensor width in mm (required if `sensor_height` is set)                                                      |
| `sensor_height` | STRING _(optional)_ | — | Sensor height in mm (required if `sensor_width` is set)                                                      |
| `fix_sensor_size` | COMBO _(optional)_ | `True` | `True` = Fixed, `False` = Floating                                                                           |
| `estimated_closest_point` | STRING _(optional)_ | — | Estimated distance from the camera to the closest point you are tracking. Rough estimate will do. In metres  |
| `estimated_farthest_point` | STRING _(optional)_ | — | Estimated distance from the camera to the farthest point you are tracking. Rough estimate will do. In metres |
| `calculate_distortion` | COMBO _(optional)_ | `False` | `True` = Turn this on to calculate lens distortion in your camera solve. We will provide ST maps with your export for the distortion used.                                             |

All camera fields are optional. `sensor_width` and `sensor_height` must be provided together.

**Download buttons (enabled after inference)**

- **Download Tracking Data** — downloads the tracking results

---

### Slapshot — Smart Vectors

Generates smart vector data from a source video with an optional single reference mask frame.

**Inputs**

| Input | Type | Description |
|---|---|---|
| `video` | VIDEO | Source video (`.mp4` or `.mov`) |
| `mask` | IMAGE _(optional)_ | ROI mask — a black background image with the region of interest colored. Must be loaded from a file named with a 5-digit frame number, e.g. `00034.png` |

When provided, the mask filename determines the keyframe automatically: `00018.png` → keyframe 19. The mask and keyframe are sent as `roi_mask_path` and `keyframe` in the request metadata.

**Download buttons (enabled after inference)**

- **Download Smart Vectors** — downloads the smart vector results

---

## How it works

All three nodes follow the same pipeline:

1. **Uploads** the video (and mask frames, for Rotoscoping) to Slapshot via presigned S3 URLs.
2. **Submits** a job to the Slapshot API.
3. **Polls** job status every 60 seconds (up to 5 hours), showing live progress in the node's Console widget.
4. **Notifies** you via the email associated with your API key when the job completes.
5. **Enables** download button(s) on the node so you can pull results directly from ComfyUI.

## API Key

### Getting your API key

1. Go to [app.slapshot.ai](https://app.slapshot.ai/) and sign in (or create a free account).
2. Click your profile icon in the top-right and open **Profile**.
3. Select the **Developer** tab.
4. Click **Generate API Key** and copy the key.

### Setting your API key

Choose one of the two methods below. Restart ComfyUI after making changes.

**Option A — `.env` file (recommended)**

Add the following line to the `.env` file in your ComfyUI root directory (create it if it doesn't exist):

```
SLAPSHOT_API_KEY=your-api-key-here
```

**Option B — `config.ini` file**

Open (or create) `config.ini` inside the `comfyui-slapshot` plugin directory and set:

```ini
[API]
SLAPSHOT_API_KEY = your-api-key-here
```

The `.env` value takes precedence over `config.ini` if both are set.

If no API key is found when a Slapshot node is added to the graph, a dialog will appear with a **Get API Key** button that takes you directly to the developer settings page.

## Installation

### Via ComfyUI Manager

Search for **Slapshot** in the ComfyUI Manager and click Install, then restart ComfyUI.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/slapshot-ai/comfyui-slapshot
```

Restart ComfyUI.

## Direct API Integration

In addition to using the ComfyUI nodes, you can call the Slapshot API directly from any language or tool. Full API reference and example requests are available in the [Slapshot API Documentation](https://documenter.getpostman.com/view/49089023/2sB3WsNKMa).

Generate your API key from the **Developer** tab in your [Slapshot profile](https://app.slapshot.ai/) and pass it as the `x-api-key` header in every request.

## Requirements

- Python package: `requests` (installed automatically via `requirements.txt`)
- A Slapshot API key — sign up at [app.slapshot.ai](https://app.slapshot.ai/)
