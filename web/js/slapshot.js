import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

// ── API Key modal ─────────────────────────────────────────────────────────────

// null = not yet fetched, true = configured, false = missing
let _apiKeyStatus = null;

async function _fetchApiKeyStatus() {
    if (_apiKeyStatus !== null) return _apiKeyStatus;
    try {
        const resp = await fetch("/slapshot/api_key_status");
        if (!resp.ok) return (_apiKeyStatus = true); // fail open
        const data = await resp.json();
        _apiKeyStatus = data.configured;
    } catch {
        _apiKeyStatus = true; // fail open on network error
    }
    return _apiKeyStatus;
}

async function _checkApiKey() {
    const ok = await _fetchApiKeyStatus();
    if (!ok) _showApiKeyModal();
}

function _showApiKeyModal() {
    const overlay = document.createElement("div");
    overlay.style.cssText = [
        "position:fixed", "inset:0", "background:rgba(0,0,0,0.75)",
        "z-index:10000", "display:flex", "align-items:center", "justify-content:center",
    ].join(";");

    const modal = document.createElement("div");
    modal.style.cssText = [
        "background:#1e1e2e", "border:1px solid #3a3a5a", "border-radius:12px",
        "padding:32px", "max-width:460px", "width:90%", "box-sizing:border-box",
        "font-family:sans-serif",
    ].join(";");

    const title = document.createElement("h2");
    title.textContent = "API Key Required to Use Slapshot Nodes";
    title.style.cssText = "color:#fff;font-size:18px;margin:0 0 14px;font-weight:600;line-height:1.3;";

    const desc = document.createElement("p");
    desc.innerHTML = [
        "This workflow contains <strong>Slapshot nodes</strong> that require an API key.",
        "Set <code style='background:#2a2a3a;padding:1px 5px;border-radius:3px;'>SLAPSHOT_API_KEY</code>",
        "in your <code style='background:#2a2a3a;padding:1px 5px;border-radius:3px;'>.env</code>",
        "file or <code style='background:#2a2a3a;padding:1px 5px;border-radius:3px;'>config.ini</code>",
        "and restart ComfyUI.",
    ].join(" ");
    desc.style.cssText = "color:#aaa;font-size:13px;margin:0 0 18px;line-height:1.6;";

    const nodeBox = document.createElement("div");
    nodeBox.style.cssText = [
        "background:#2a2a3a", "border:1px solid #3a3a5a", "border-radius:6px",
        "padding:10px 14px", "margin-bottom:24px",
    ].join(";");
    const nodeLabel = document.createElement("div");
    nodeLabel.textContent = "API Node(s)";
    nodeLabel.style.cssText = "color:#888;font-size:11px;margin-bottom:6px;";
    const nodeNames = document.createElement("div");
    nodeNames.textContent = "Slapshot — Rotoscoping, Depth Map, Tracking, Smart Vectors";
    nodeNames.style.cssText = "color:#ccc;font-size:13px;";
    nodeBox.appendChild(nodeLabel);
    nodeBox.appendChild(nodeNames);

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;justify-content:flex-end;gap:12px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = [
        "background:transparent", "color:#aaa", "border:1px solid #555",
        "border-radius:6px", "padding:8px 22px", "cursor:pointer", "font-size:14px",
    ].join(";");
    cancelBtn.addEventListener("click", () => overlay.remove());

    const getKeyBtn = document.createElement("button");
    getKeyBtn.textContent = "Get API Key";
    getKeyBtn.style.cssText = [
        "background:#5566ff", "color:#fff", "border:none",
        "border-radius:6px", "padding:8px 22px", "cursor:pointer", "font-size:14px",
        "font-weight:600",
    ].join(";");
    getKeyBtn.addEventListener("click", () => {
        window.open("https://app.slapshot.ai/", "_blank", "noopener");
        overlay.remove();
    });

    buttons.appendChild(cancelBtn);
    buttons.appendChild(getKeyBtn);

    modal.appendChild(title);
    modal.appendChild(desc);
    modal.appendChild(nodeBox);
    modal.appendChild(buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

// ─────────────────────────────────────────────────────────────────────────────

app.registerExtension({
    name: "Slapshot.ApiKeyCheck",
    setup() {
        // Block queue and show modal when API key is missing
        const origQueue = app.queuePrompt.bind(app);
        app.queuePrompt = async function (...args) {
            const hasSlapshot = app.graph._nodes?.some(n => PREVIEW_NODES.includes(n.type));
            if (hasSlapshot) {
                const ok = await _fetchApiKeyStatus();
                if (!ok) {
                    _showApiKeyModal();
                    return;
                }
            }
            return origQueue(...args);
        };

        // Fix cursor: LiteGraph resets canvas.style.cursor (inline) on every mousemove,
        // overwriting any pointer we set. A CSS class with !important beats inline styles.
        const cursorStyle = document.createElement("style");
        cursorStyle.textContent = ".slapshot-pointer { cursor: pointer !important; }";
        document.head.appendChild(cursorStyle);

        const titleH = (typeof LiteGraph !== "undefined" ? LiteGraph.NODE_TITLE_HEIGHT : null) ?? 30;
        document.addEventListener("mousemove", () => {
            const c = app.canvas;
            const node = c?.node_over;
            const domCanvas = c?.canvas;
            if (!domCanvas) return;
            const want = node &&
                PREVIEW_NODES.includes(node.type) &&
                (c.graph_mouse ?? c.last_mouse_position)?.[1] > node.pos[1] + titleH;
            domCanvas.classList.toggle("slapshot-pointer", !!want);
        });
    },
});

const PREVIEW_NODES = [
    "Slapshot_Rotoscoping",
    "Slapshot_Rotoscoping_Download",
    "Slapshot_Rotoscoping_Masks",
    "Slapshot_Dynamic_Masks_Test",
    "Slapshot_Depth_Map",
    "Slapshot_Tracking",
    "Slapshot_Smart_Vectors",
];

const DEFAULT_SLAPSHOT_BASE_URL = "https://autopilot.slapshot.work";

const NODE_DOWNLOADS = {
    "Slapshot_Rotoscoping":         [
        { label: "Download Hard Mattes", exportType: "hard_mattes" },
        { label: "Download MB Mattes",   exportType: "mb_mattes" },
    ],
    "Slapshot_Rotoscoping_Download": [
        { label: "Download Hard Mattes", exportType: "hard_mattes" },
        { label: "Download MB Mattes",   exportType: "mb_mattes" },
    ],
    "Slapshot_Rotoscoping_Masks":    [
        { label: "Download Hard Mattes", exportType: "hard_mattes" },
        { label: "Download MB Mattes",   exportType: "mb_mattes" },
    ],
    "Slapshot_Dynamic_Masks_Test":   [
        { label: "Download Hard Mattes", exportType: "hard_mattes" },
        { label: "Download MB Mattes",   exportType: "mb_mattes" },
    ],
    "Slapshot_Depth_Map":           [
        {
            label: "Download Depth Map",
            exportType: (node) => {
                const val = node.widgets?.find(w => w.name === "export_type")?.value ?? "MOV";
                return val === "JPG" ? "jpg" : "mov";
            },
        },
    ],
    "Slapshot_Tracking":             [
        { label: "Download Tracking Data", exportType: "tracking" },
    ],
    "Slapshot_Smart_Vectors":        [
        { label: "Download Smart Vectors", exportType: "exr" },
    ],
};

// ── Real-time progress updates from Python ────────────────────────────────────

api.addEventListener("slapshot_progress", ({ detail }) => {
    const node = app.graph.getNodeById(parseInt(detail.node_id));
    if (!node) return;
    const w = node.widgets?.find(w => w.name === "preview_text");
    if (!w) return;
    w.value = detail.text;
    node._inferenceRunning = true;
    app.graph.setDirtyCanvas(true);
});

// ── Inline Console + download buttons ────────────────────────────────────────

app.registerExtension({
    name: "Slapshot.TextPreview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!PREVIEW_NODES.includes(nodeData.name)) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            const node = this;

            // Set video input label synchronously before first render.
            const videoInput = node.inputs?.find(inp => inp.name === "video");
            if (videoInput) videoInput.label = "Video";

            // ── Console widget (read-only, fixed 260 px tall) ─────────────────
            const widget = ComfyWidgets["STRING"](
                node,
                "preview_text",
                ["STRING", { multiline: true }],
                app
            ).widget;
            widget.label = "Console";
            widget.inputEl.readOnly = true;
            widget.inputEl.style.opacity = 0.7;
            widget.inputEl.style.height = "260px";
            widget.inputEl.style.minHeight = "260px";
            widget.inputEl.style.resize = "none";
            widget.computeSize = (width) => [width, 260];
            widget.serialize = false;

            // ── Invisible gap between console bottom edge and download button ──
            // LiteGraph button widgets render a visible bar; override draw to get
            // clean empty space so the disabled download button doesn't overlap.
            const postConsoleSpacer = node.addWidget("button", " ", null, () => {});
            postConsoleSpacer.disabled = true;
            postConsoleSpacer.serialize = false;
            postConsoleSpacer.computeSize = (width) => [width, 14];
            postConsoleSpacer.draw = () => {};

            // ── Download buttons (disabled until inference completes) ──────────
            node._downloadBtns = (NODE_DOWNLOADS[nodeData.name] ?? []).map(({ label, exportType }) => {
                const btn = node.addWidget(
                    "button", label, null,
                    async () => {
                        const et = typeof exportType === "function" ? exportType(node) : exportType;
                        await _slapshotDownload(node, et);
                    }
                );
                btn.disabled = true;
                btn.tooltip = `${label} can only be downloaded after inference completion`;
                btn.serialize = false;
                btn._disabledLabel = label;
                btn._enabledLabel = "⬇  " + label;
                return btn;
            });

            // ── Manual lookup/download by job_id ──────────────────────────────
            const preJobIdSpacer = node.addWidget("button", " ", null, () => {});
            preJobIdSpacer.disabled = true;
            preJobIdSpacer.serialize = false;
            preJobIdSpacer.computeSize = (width) => [width, 18];
            preJobIdSpacer.draw = () => {};

            const jobIdWidget = node.addWidget(
                "text",
                "job_id",
                "",
                (value) => { node._manualJobId = String(value ?? "").trim(); },
                { placeholder: "Paste job ID here" }
            );
            jobIdWidget.serialize = false;
            if (jobIdWidget.inputEl) {
                jobIdWidget.inputEl.style.padding = "10px 12px";
            }

            const downloadJobBtn = node.addWidget("button", "Download Previous Job Result", null, async () => {
                const rawJobId = String(jobIdWidget.value ?? node._manualJobId ?? "").trim();
                if (!rawJobId) {
                    alert("Please enter a job ID first.");
                    return;
                }
                const exportType = _resolvePrimaryExportType(node);
                if (!exportType) {
                    alert("No export_type could be resolved for this node.");
                    return;
                }
                const data = await _slapshotRequestDownload(rawJobId, exportType, node._slapshotBaseUrl);
                if (!data) return;

                node._slapshotJobId = rawJobId;
                node._slapshotReady = true;
                node._inferenceRunning = false;
                _setDownloadButtonsEnabled(node, true);

                const downloadUrl = data.download_url || data.url || data.presigned_url;
                if (downloadUrl) _openDownload(downloadUrl);

                const consoleWidget = node.widgets?.find(w => w.name === "preview_text");
                if (consoleWidget) {
                    consoleWidget.value = `Job ${rawJobId} ready — download buttons enabled.`;
                }
                app.graph.setDirtyCanvas(true);
            });
            downloadJobBtn.serialize = false;
            downloadJobBtn.computeSize = (width) => [width, 36];

            requestAnimationFrame(() => {
                // Title-case any mask inputs that exist at load time.
                node.inputs?.forEach(inp => {
                    if (/^mask_\d+$/.test(inp.name))
                        inp.label = "Mask_" + inp.name.slice(5);
                });

                const exportTypeWidget = node.widgets?.find(w => w.name === "export_type");
                if (exportTypeWidget) {
                    exportTypeWidget.label = "Export Type";
                    if (!["JPG", "MOV"].includes(exportTypeWidget.value)) {
                        exportTypeWidget.value = "JPG";
                    }
                }

                if (nodeData.name === "Slapshot_Smart_Vectors") {
                    const roiInput = node.inputs?.find(inp => inp.name === "mask");
                    if (roiInput) roiInput.label = "ROI Mask";
                }

                if (nodeData.name === "Slapshot_Tracking") {
                    const TRACKING_LABELS = {
                        "working_fps":              "Working FPS",
                        "lens":                     "Lens (mm)",
                        "fix_focal_length":         "Fix Focal Length  [False=Floating, True=Fixed]",
                        "sensor_width":             "Sensor Width (mm)",
                        "sensor_height":            "Sensor Height (mm)",
                        "fix_sensor_size":          "Fix Sensor Size  [True=Fixed, False=Floating]",
                        "estimated_closest_point":  "Estimated Closest Point (m)",
                        "estimated_farthest_point": "Estimated Farthest Point (m)",
                        "calculate_distortion":     "Calculate Distortion",
                    };
                    node.widgets?.forEach(w => {
                        if (TRACKING_LABELS[w.name]) w.label = TRACKING_LABELS[w.name];
                    });

                    // Numeric string fields should never hold "True"/"False" —
                    // reset them if a positional workflow-restore corrupted them.
                    const NUMERIC_FIELDS = new Set([
                        "working_fps", "lens", "sensor_width", "sensor_height",
                        "estimated_closest_point", "estimated_farthest_point",
                    ]);
                    const COMBO_DEFAULTS = {
                        "fix_focal_length":     "False",
                        "fix_sensor_size":      "True",
                        "calculate_distortion": "False",
                    };
                    const COMBO_OPTIONS = {
                        "fix_focal_length":     ["False", "True"],
                        "fix_sensor_size":      ["True", "False"],
                        "calculate_distortion": ["False", "True"],
                    };
                    node.widgets?.forEach(w => {
                        if (NUMERIC_FIELDS.has(w.name)) {
                            const v = (w.value || "").trim();
                            if (v !== "" && isNaN(Number(v))) w.value = "";
                        } else if (COMBO_DEFAULTS[w.name] !== undefined) {
                            if (!COMBO_OPTIONS[w.name].includes(w.value)) {
                                w.value = COMBO_DEFAULTS[w.name];
                            }
                        }
                    });
                }

                _setNodeSize(node);
            });
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);

            const w = this.widgets?.find(w => w.name === "preview_text");
            if (w && message?.text) {
                w.value = Array.isArray(message.text) ? message.text[0] : message.text;
                app.graph.setDirtyCanvas(true);
            }

            const jobId = Array.isArray(message?.job_id)
                ? message.job_id[0]
                : message?.job_id;
            const baseUrl = Array.isArray(message?.base_url)
                ? message.base_url[0]
                : message?.base_url;

            if (jobId) {
                this._slapshotJobId    = jobId;
                this._slapshotBaseUrl  = baseUrl;
                this._slapshotReady    = true;
                this._inferenceRunning = false;
                _setDownloadButtonsEnabled(this, true);
                app.graph.setDirtyCanvas(true);
            }
        };
    },
});

// ── Download helper ───────────────────────────────────────────────────────────

async function _slapshotDownload(node, exportType) {
    if (!node._slapshotReady || !node._slapshotJobId) {
        const msg = node._inferenceRunning
            ? "Inference is running. You'll be able to download it as soon as it is completed."
            : "Download is available once inference is completed.";
        alert(msg);
        return;
    }

    const data = await _slapshotRequestDownload(node._slapshotJobId, exportType, node._slapshotBaseUrl);
    if (!data) return;

    const downloadUrl = data.download_url || data.url || data.presigned_url;
    if (!downloadUrl) {
        console.warn(`[Slapshot] no download URL in response keys:`, Object.keys(data));
        alert("Slapshot: no download URL in response.");
        return;
    }

    _openDownload(downloadUrl);
}

async function _slapshotRequestDownload(jobId, exportType, baseUrl) {
    const normalizedJobId = String(jobId ?? "").trim();
    const normalizedExportType = String(exportType ?? "").trim();
    const normalizedBaseUrl = String(baseUrl ?? "").trim() || DEFAULT_SLAPSHOT_BASE_URL;

    if (!normalizedJobId || !normalizedExportType) {
        alert("Slapshot: missing job_id or export_type.");
        return null;
    }

    const hasApiKey = await _fetchApiKeyStatus();
    if (!hasApiKey) {
        _showApiKeyModal();
        alert("Slapshot: API key is missing. Configure SLAPSHOT_API_KEY first.");
        return null;
    }

    const externalUrl = `${normalizedBaseUrl}/api/comfyui/${normalizedJobId}/result?export_type=${normalizedExportType}`;
    console.log(`[Slapshot] download_result → GET ${externalUrl} (proxied via ComfyUI)`);

    try {
        const resp = await fetch("/slapshot/download_url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                job_id:      normalizedJobId,
                export_type: normalizedExportType,
                base_url:    normalizedBaseUrl,
            }),
        });
        console.log(`[Slapshot] download_result ← status ${resp.status}`);
        if (!resp.ok) {
            const bodyText = await resp.text().catch(() => "");
            let backendMsg = "";
            try {
                const parsed = JSON.parse(bodyText);
                backendMsg = parsed?.error ? String(parsed.error) : "";
            } catch {
                backendMsg = bodyText;
            }
            console.error(`[Slapshot] download_result error body:`, bodyText);
            alert(
                backendMsg
                    ? `Slapshot: download request failed (${resp.status}) - ${backendMsg}`
                    : `Slapshot: download request failed (${resp.status}).`
            );
            return null;
        }
        const data = await resp.json();
        console.log(`[Slapshot] download_result response:`, data);
        return data;
    } catch (err) {
        alert(`Slapshot: download error — ${err.message}`);
        return null;
    }
}

function _openDownload(downloadUrl) {
    console.log(`[Slapshot] triggering download from:`, downloadUrl);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
}


function _resolvePrimaryExportType(node) {
    const defs = NODE_DOWNLOADS[node.type] ?? [];
    const first = defs[0]?.exportType;
    if (!first) return null;
    const resolved = typeof first === "function" ? first(node) : first;
    return String(resolved ?? "").trim();
}

function _setDownloadButtonsEnabled(node, enabled) {
    for (const btn of (node._downloadBtns ?? [])) {
        btn.name = enabled ? btn._enabledLabel : (btn._disabledLabel ?? btn.name);
        btn.disabled = !enabled;
        btn.tooltip = enabled
            ? undefined
            : `${btn._disabledLabel ?? "Download"} can only be downloaded after inference completion`;
    }
}

// ── Size helper ───────────────────────────────────────────────────────────────
// Never shrink below the current user-resized width or the 500px minimum.

function _setNodeSize(node) {
    const computed = node.computeSize();
    const w = Math.max(node.size[0], computed[0], 500);
    const h = Math.max(computed[1]);
    node.setSize([w, h]);
    app.graph.setDirtyCanvas(true);
}

// ── Dynamic MASK input slots ──────────────────────────────────────────────────

app.registerExtension({
    name: "Slapshot.DynamicMaskInputs",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "Slapshot_Rotoscoping") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            const node = this;

            // Strip all statically-declared mask_XX slots.
            for (let i = this.inputs.length - 1; i >= 0; i--) {
                if (/^mask_\d+$/.test(this.inputs[i].name)) this.removeInput(i);
            }

            const addBtn = node.addWidget("button", "+ Add Mask", null, () => {
                _addMaskSlot(node);
                _updateMaskBtns(node, addBtn, removeBtn);
            });
            addBtn.serialize = false;

            const removeBtn = node.addWidget("button", "✕ Remove Last Mask", null, () => {
                _removeMaskSlot(node);
                _updateMaskBtns(node, addBtn, removeBtn);
            });
            removeBtn.disabled = true;
            removeBtn.serialize = false;

            // Move add/remove buttons to the top (before preview_text).
            // All extensions have run by the next frame so indices are stable.
            requestAnimationFrame(() => {
                const btns = [addBtn, removeBtn];
                btns.forEach(btn => {
                    const idx = node.widgets.indexOf(btn);
                    if (idx >= 0) node.widgets.splice(idx, 1);
                });
                const previewIdx = node.widgets.findIndex(w => w.name === "preview_text");
                node.widgets.splice(previewIdx >= 0 ? previewIdx : 0, 0, ...btns);

                _updateMaskBtns(node, addBtn, removeBtn);
            });
        };
    },
});

function _updateMaskBtns(node, addBtn, removeBtn) {
    const count = node.inputs.filter(inp => /^mask_\d+$/.test(inp.name)).length;
    addBtn.name = count === 0 ? "+ Add Mask" : "+ Add More Masks";
    removeBtn.name     = "✕ Remove Last Mask";
    removeBtn.disabled = count === 0;
    _setNodeSize(node);
}

function _addMaskSlot(node) {
    const count = node.inputs.filter(inp => /^mask_\d+$/.test(inp.name)).length;
    if (count >= 10) return;
    const slotName = `mask_${String(count).padStart(2, "0")}`;
    node.addInput(slotName, "IMAGE");
    node.inputs[node.inputs.length - 1].label = "Mask_" + slotName.slice(5);
    _setNodeSize(node);
}

function _removeMaskSlot(node) {
    const maskInputs = node.inputs
        .map((inp, i) => ({ inp, i }))
        .filter(({ inp }) => /^mask_\d+$/.test(inp.name));
    if (maskInputs.length === 0) return;
    node.removeInput(maskInputs[maskInputs.length - 1].i);
    _setNodeSize(node);
}

// ── Dynamic mask path list (Slapshot_Dynamic_Masks_Test only) ─────────────────

app.registerExtension({
    name: "Slapshot.DynamicMasks",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "Slapshot_Dynamic_Masks_Test") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            _setupDynamicMasks(this);
        };

        // Widget values are applied by LiteGraph after onConfigure returns,
        // so defer the row rebuild by one frame.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            onConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                const s = this._maskState;
                if (!s) return;
                let saved = [];
                try { saved = JSON.parse(s.jsonWidget.value || "[]"); } catch {}
                _rebuildRows(s, saved, this);
            });
        };
    },
});

// ── Helpers for Slapshot.DynamicMasks ────────────────────────────────────────

function _setupDynamicMasks(node) {
    const jsonWidget = node.widgets?.find(w => w.name === "mask_paths_json");
    if (!jsonWidget) return;

    jsonWidget.computeSize = () => [0, -4];

    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:4px 2px;";

    const label = document.createElement("div");
    label.textContent = "Mask paths";
    label.style.cssText = "color:#aaa;font-size:11px;font-weight:600;";
    root.appendChild(label);

    const rowsEl = document.createElement("div");
    rowsEl.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    root.appendChild(rowsEl);

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Add mask path";
    addBtn.style.cssText = [
        "background:#2a2a3a",
        "color:#99aaff",
        "border:1px solid #445",
        "border-radius:4px",
        "padding:4px 10px",
        "font-size:11px",
        "cursor:pointer",
        "align-self:flex-start",
    ].join(";");
    addBtn.addEventListener("click", () => {
        _addRow(state, "", node);
        _sync(state, node);
    });
    root.appendChild(addBtn);

    const state = { jsonWidget, rowsEl, node };
    node._maskState = state;

    let initial = [];
    try { initial = JSON.parse(jsonWidget.value || "[]"); } catch {}
    _rebuildRows(state, initial, node);

    node.addDOMWidget("mask_list_ui", "customMaskList", root, {
        serialize: false,
        getHeight() {
            const rows = rowsEl.children.length;
            return 24 + rows * 30 + 34;
        },
        getValue() { return jsonWidget.value; },
        setValue(v) {
            jsonWidget.value = v;
            let arr = [];
            try { arr = JSON.parse(v || "[]"); } catch {}
            _rebuildRows(state, arr, node);
        },
    });
}

function _rebuildRows(state, values, node) {
    state.rowsEl.innerHTML = "";
    for (const v of values) _addRow(state, v, node, false);
    _sync(state, node);
}

function _addRow(state, value, node, doSync = true) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;align-items:center;";

    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = "/path/to/masks/00000.png";
    input.style.cssText = [
        "flex:1",
        "background:#1e1e2e",
        "color:#ccc",
        "border:1px solid #444",
        "border-radius:4px",
        "padding:3px 7px",
        "font-size:11px",
        "font-family:monospace",
    ].join(";");
    input.addEventListener("input", () => _sync(state, node));

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";
    removeBtn.style.cssText = [
        "background:#3a2020",
        "color:#f88",
        "border:1px solid #633",
        "border-radius:4px",
        "padding:2px 7px",
        "font-size:11px",
        "cursor:pointer",
        "flex-shrink:0",
    ].join(";");
    removeBtn.addEventListener("click", () => {
        row.remove();
        _sync(state, node);
    });

    row.appendChild(input);
    row.appendChild(removeBtn);
    state.rowsEl.appendChild(row);

    if (doSync) _sync(state, node);
}

function _sync(state, node) {
    const values = Array.from(
        state.rowsEl.querySelectorAll("input")
    ).map(i => i.value);
    state.jsonWidget.value = JSON.stringify(values);
    node.setSize(node.computeSize());
}
