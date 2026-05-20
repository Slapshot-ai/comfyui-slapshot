import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const PREVIEW_NODES = [
    "Slapshot_Rotoscoping",
    "Slapshot_Rotoscoping_Download",
    "Slapshot_Rotoscoping_Masks",
    "Slapshot_Dynamic_Masks_Test",
];

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

            // ── Download buttons (disabled until inference completes) ──────────
            const hardMatteBtn = node.addWidget(
                "button", "Download Hard Matte", null,
                async () => { await _slapshotDownload(node, "hard_matte"); }
            );
            hardMatteBtn.disabled = true;
            hardMatteBtn.serialize = false;
            node._hardMatteBtn = hardMatteBtn;

            const mbMatteBtn = node.addWidget(
                "button", "Download MB Matte", null,
                async () => { await _slapshotDownload(node, "mb_matte"); }
            );
            mbMatteBtn.disabled = true;
            mbMatteBtn.serialize = false;
            node._mbMatteBtn = mbMatteBtn;

            requestAnimationFrame(() => {
                // Relabel the api_key widget
                const apiKeyWidget = node.widgets?.find(w => w.name === "api_key");
                if (apiKeyWidget) apiKeyWidget.label = "API key";

                // Title-case any mask inputs that exist at load time.
                node.inputs?.forEach(inp => {
                    if (/^mask_\d+$/.test(inp.name))
                        inp.label = "Mask_" + inp.name.slice(5);
                });

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

                if (this._hardMatteBtn) {
                    this._hardMatteBtn.name     = "⬇  Download Hard Matte";
                    this._hardMatteBtn.disabled = false;
                }
                if (this._mbMatteBtn) {
                    this._mbMatteBtn.name     = "⬇  Download MB Matte";
                    this._mbMatteBtn.disabled = false;
                }
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

    const apiKey = node.widgets?.find(w => w.name === "api_key")?.value;
    if (!apiKey) {
        alert("Slapshot: API key is not set on the node.");
        return;
    }

    const externalUrl = `${node._slapshotBaseUrl}/api/comfyui/${node._slapshotJobId}/result?export_type=${exportType}\`;`;
    console.log(`[Slapshot] download_result → GET ${externalUrl} (proxied via ComfyUI)`);

    try {
        const resp = await fetch("/slapshot/download_url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                job_id:      node._slapshotJobId,
                export_type: exportType,
                api_key:     apiKey,
                base_url:    node._slapshotBaseUrl,
            }),
        });
        console.log(`[Slapshot] download_result ← status ${resp.status}`);
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            console.error(`[Slapshot] download_result error body:`, body);
            alert(`Slapshot: download request failed (${resp.status}).`);
            return;
        }
        const data = await resp.json();
        console.log(`[Slapshot] download_result response:`, data);
        const downloadUrl = data.download_url || data.url || data.presigned_url;
        if (!downloadUrl) {
            console.warn(`[Slapshot] no download URL in response keys:`, Object.keys(data));
            alert("Slapshot: no download URL in response.");
            return;
        }
        console.log(`[Slapshot] triggering download from:`, downloadUrl);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
    } catch (err) {
        alert(`Slapshot: download error — ${err.message}`);
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

            // Move add/remove buttons to sit above the api_key widget.
            // All extensions have run by the next frame so indices are stable.
            requestAnimationFrame(() => {
                const btns = [addBtn, removeBtn];
                btns.forEach(btn => {
                    const idx = node.widgets.indexOf(btn);
                    if (idx >= 0) node.widgets.splice(idx, 1);
                });
                const apiKeyIdx = node.widgets.findIndex(w => w.name === "api_key");
                node.widgets.splice(apiKeyIdx >= 0 ? apiKeyIdx : 0, 0, ...btns);

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
