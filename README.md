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

**Previous job download**

Paste a job ID into the **job ID** field and click **Download Previous Job Result** to fetch results from an earlier run without re-submitting. This also enables the download buttons for that job.

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

**Previous job download**

Paste a job ID into the **job ID** field and click **Download Previous Job Result** to fetch results from an earlier run without re-submitting. This also enables the download buttons for that job.

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

**Previous job download**

Paste a job ID into the **job ID** field and click **Download Previous Job Result** to fetch results from an earlier run without re-submitting. This also enables the download buttons for that job.

---

### Slapshot — Smart Vectors

Generates smart vector data from a source video with an optional single region of interest mask frame.

**Inputs**

| Input | Type | Description |
|---|---|---|
| `video` | VIDEO | Source video (`.mp4` or `.mov`) |
| `ROI Mask` | IMAGE _(optional)_ | ROI mask — a black background image with the region of interest colored. Must be loaded from a file named with a 5-digit frame number, e.g. `00034.png` |

When provided, the ROI mask filename determines the keyframe automatically: `00018.png` → keyframe 19.

**Download buttons (enabled after inference)**

- **Download Smart Vectors** — downloads the smart vector results

**Previous job download**

Paste a job ID into the **job ID** field and click **Download Previous Job Result** to fetch results from an earlier run without re-submitting. This also enables the download buttons for that job.

---

## How it works

### Downloading results from a previous job

Every node has a **job ID** text field and a **Download Previous Job Result** button. If you already have a job ID (from a prior run or from the Slapshot dashboard), you can skip re-submitting:

1. Paste the job ID into the **job ID** field on the node.
2. Click **Download Previous Job Result**.
3. The node fetches the download URL and triggers the file download immediately. Download is available only for the format selected when the job was originally submitted. This also enables the download buttons for that job.

## API Key

### Getting your API key

1. Go to [app.slapshot.ai](https://app.slapshot.ai/) and sign in (or create a free account).
2. Click your profile icon in the top-right and open **Profile**.
3. Under the **INTEGRATIONS** section in the sidebar, select the **ComfyUI** tab.
4. Click **Generate API Key** and copy the key.

### Setting your API key

Choose one of the two methods below. Restart ComfyUI after making changes.

**Option A — `.env` file (recommended)**

Add the following line to the `.env` file in your ComfyUI root directory (create it if it doesn't exist):

```
SLAPSHOT_API_KEY=your-api-key-here
```

**Option B — `config.ini` file**

Open (or create) `config.ini` inside the `comfyui-slapshot` plugin directory — that's `custom_nodes/comfyui-slapshot/config.ini` under your ComfyUI installation — and set:

```ini
[API]
SLAPSHOT_API_KEY = your-api-key-here
```

The `.env` value takes precedence over `config.ini` if both are set.

#### Finding/creating `config.ini`

**macOS**

1. Open **Terminal**.
2. Locate the plugin folder:
   ```bash
   find ~ -type d -name "comfyui-slapshot" 2>/dev/null
   ```
3. Open (or create) the file with a text editor, e.g.:
   ```bash
   open -e ~/path/to/ComfyUI/custom_nodes/comfyui-slapshot/config.ini
   ```
   (replace the path with what the `find` command returned). If the file doesn't exist yet, TextEdit will offer to create it when you save.

**Linux**

1. Open a terminal.
2. Locate the plugin folder:
   ```bash
   find ~ -type d -name "comfyui-slapshot" 2>/dev/null
   ```
3. Create/edit the file, e.g.:
   ```bash
   nano ~/path/to/ComfyUI/custom_nodes/comfyui-slapshot/config.ini
   ```
   (replace the path with what the `find` command returned).

**Windows**

The exact location depends on where ComfyUI was installed (portable build, manual clone, desktop app, etc.), so it's not always obvious where to look. The most reliable way to find it is with PowerShell:

1. Open **PowerShell** (Start menu → search "PowerShell").
2. Search your user folder for the plugin directory:
   ```powershell
   Get-ChildItem -Path $HOME -Recurse -Directory -Filter "comfyui-slapshot" -ErrorAction SilentlyContinue | Select-Object FullName
   ```
   If ComfyUI is installed outside your user folder (e.g. on another drive), search that drive instead:
   ```powershell
   Get-ChildItem -Path "C:\" -Recurse -Directory -Filter "comfyui-slapshot" -ErrorAction SilentlyContinue | Select-Object FullName
   ```
   (this scans the whole `C:` drive, so it can take a minute — narrow `-Path` to a specific folder if you know roughly where ComfyUI lives).
3. Once you have the path, open (or create) `config.ini` directly in Notepad:
   ```powershell
   notepad "C:\path\to\ComfyUI\custom_nodes\comfyui-slapshot\config.ini"
   ```
   (replace the path with what step 2 returned). If the file doesn't exist yet, Notepad will ask if you want to create it — click **Yes**, then paste in the `[API]` section shown above and save.

If no API key is found when a Slapshot node is added to the graph, a dialog will appear with a **Get API Key** button that takes you directly to the ComfyUI integration settings page.

## Installation

### Via ComfyUI Manager

Search for **Slapshot** in the ComfyUI Manager and click Install, then restart ComfyUI.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/slapshot-ai/comfyui-slapshot
```

Restart ComfyUI.

## Requirements

- Python package: `requests` (installed automatically via `requirements.txt`)
- A Slapshot API key — sign up at [app.slapshot.ai](https://app.slapshot.ai/)
