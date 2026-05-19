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
// Python calls _send_progress(node_id, text) which fires "slapshot_progress"
// over the ComfyUI websocket. We find the node and update its preview_text.

api.addEventListener("slapshot_progress", ({ detail }) => {
    const node = app.graph.getNodeById(parseInt(detail.node_id));
    if (!node) return;
    const w = node.widgets?.find(w => w.name === "preview_text");
    if (!w) return;
    w.value = detail.text;
    app.graph.setDirtyCanvas(true);
});

// ── Inline text preview + download buttons ────────────────────────────────────

app.registerExtension({
    name: "Slapshot.TextPreview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!PREVIEW_NODES.includes(nodeData.name)) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            const node = this;

            // ── Preview text widget (read-only, fixed 260 px tall) ────────────
            const widget = ComfyWidgets["STRING"](
                node,
                "preview_text",
                ["STRING", { multiline: true }],
                app
            ).widget;
            widget.inputEl.readOnly = true;
            widget.inputEl.style.opacity = 0.7;
            widget.inputEl.style.height = "260px";
            widget.inputEl.style.minHeight = "260px";
            widget.inputEl.style.resize = "none";
            // LiteGraph calls computeSize(width) when laying out widgets.
            // Return a fixed height so the widget never collapses.
            widget.computeSize = (width) => [width, 260];
            widget.serialize = false;

            // ── Download Hard Matte button ────────────────────────────────────
            const hardMatteBtn = node.addWidget(
                "button",
                "Download Hard Matte  (run inference first)",
                null,
                async () => { await _slapshotDownload(node, "hard_matte"); }
            );
            hardMatteBtn.serialize = false;
            node._hardMatteBtn = hardMatteBtn;

            // ── Download MB Matte button ──────────────────────────────────────
            const mbMatteBtn = node.addWidget(
                "button",
                "Download MB Matte  (run inference first)",
                null,
                async () => { await _slapshotDownload(node, "mb_matte"); }
            );
            mbMatteBtn.serialize = false;
            node._mbMatteBtn = mbMatteBtn;

            // Enforce a minimum node width so button labels are never clipped.
            requestAnimationFrame(() => {
                if (node.size[0] < 400) {
                    node.setSize([400, node.size[1]]);
                    app.graph.setDirtyCanvas(true);
                }
            });
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);

            // Update preview text.
            const w = this.widgets?.find(w => w.name === "preview_text");
            if (w && message?.text) {
                w.value = Array.isArray(message.text) ? message.text[0] : message.text;
                app.graph.setDirtyCanvas(true);
            }

            // Enable download buttons once inference is complete.
            const inferenceId = Array.isArray(message?.inference_id)
                ? message.inference_id[0]
                : message?.inference_id;
            const baseUrl = Array.isArray(message?.base_url)
                ? message.base_url[0]
                : message?.base_url;

            if (inferenceId) {
                this._slapshotInferenceId = inferenceId;
                this._slapshotBaseUrl     = baseUrl;
                this._slapshotReady       = true;

                if (this._hardMatteBtn) {
                    this._hardMatteBtn.name = "⬇  Download Hard Matte";
                }
                if (this._mbMatteBtn) {
                    this._mbMatteBtn.name = "⬇  Download MB Matte";
                }
                app.graph.setDirtyCanvas(true);
            }
        };
    },
});

// ── Download helper ───────────────────────────────────────────────────────────

async function _slapshotDownload(node, exportType) {
    if (!node._slapshotReady || !node._slapshotInferenceId) {
        return; // Button label already says "run inference first"
    }

    const apiKey = node.widgets?.find(w => w.name === "api_key")?.value;
    if (!apiKey) {
        alert("Slapshot: API key is not set on the node.");
        return;
    }

    try {
        // Route through ComfyUI backend to avoid CORS on the external API.
        const resp = await fetch("/slapshot/download_url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                inference_id: node._slapshotInferenceId,
                export_type:  exportType,
                api_key:      apiKey,
                base_url:     node._slapshotBaseUrl,
            }),
        });
        if (!resp.ok) {
            alert(`Slapshot: download request failed (${resp.status}).`);
            return;
        }
        const data = await resp.json();
        const downloadUrl = data.download_url || data.url || data.presigned_url;
        if (!downloadUrl) {
            alert("Slapshot: no download URL in response.");
            return;
        }
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

// ── Dynamic MASK input slots for Slapshot — Rotoscoping ──────────────────────
// Python declares mask_00…mask_09 as optional IMAGE inputs for type validation.
// This extension strips them on creation and replaces with an "+ Add Mask" button.
// LiteGraph serialises the inputs array so added slots survive save/reload.

app.registerExtension({
    name: "Slapshot.DynamicMaskInputs",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "Slapshot_Rotoscoping") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            // Strip all statically-declared mask_XX slots.
            for (let i = this.inputs.length - 1; i >= 0; i--) {
                if (/^mask_\d+$/.test(this.inputs[i].name)) {
                    this.removeInput(i);
                }
            }

            const addBtn = this.addWidget("button", "+ Add Mask", null, () => {
                _addMaskSlot(this);
            });
            addBtn.serialize = false;
        };
    },
});

function _addMaskSlot(node) {
    const count = node.inputs.filter(inp => /^mask_\d+$/.test(inp.name)).length;
    if (count >= 10) return;
    node.addInput(`mask_${String(count).padStart(2, "0")}`, "IMAGE");
    node.setSize(node.computeSize());
    app.graph.setDirtyCanvas(true);
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
