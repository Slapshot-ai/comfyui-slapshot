import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const PREVIEW_NODES = [
    "Slapshot_Rotoscoping",
    "Slapshot_Rotoscoping_Download",
    "Slapshot_Rotoscoping_Masks",
    "Slapshot_Dynamic_Masks_Test",
];

// ── Inline text preview (shared by all Slapshot nodes) ───────────────────────

app.registerExtension({
    name: "Slapshot.TextPreview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!PREVIEW_NODES.includes(nodeData.name)) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            const widget = ComfyWidgets["STRING"](
                this,
                "preview_text",
                ["STRING", { multiline: true }],
                app
            ).widget;

            widget.inputEl.readOnly = true;
            widget.inputEl.style.opacity = 0.7;
            widget.serialize = false;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const w = this.widgets?.find((w) => w.name === "preview_text");
            if (w && message?.text) {
                w.value = Array.isArray(message.text) ? message.text[0] : message.text;
                this.setSize(this.computeSize());
                app.graph.setDirtyCanvas(true);
            }
        };
    },
});

// ── Dynamic mask list (test node only) ───────────────────────────────────────

app.registerExtension({
    name: "Slapshot.DynamicMasks",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "Slapshot_Dynamic_Masks_Test") return;

        // ── onNodeCreated: build the DOM widget and wire it to mask_paths_json ─
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            _setupDynamicMasks(this);
        };

        // ── onConfigure: restore rows from saved mask_paths_json after load ──
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            onConfigure?.apply(this, arguments);
            // Widget values are applied by LiteGraph after onConfigure returns,
            // so defer the row rebuild by one frame.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setupDynamicMasks(node) {
    const jsonWidget = node.widgets?.find(w => w.name === "mask_paths_json");
    if (!jsonWidget) return;

    // Hide the raw JSON widget — it still serialises, user never touches it.
    jsonWidget.computeSize = () => [0, -4];

    // Root container
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:4px 2px;";

    // Label row
    const label = document.createElement("div");
    label.textContent = "Mask paths";
    label.style.cssText = "color:#aaa;font-size:11px;font-weight:600;";
    root.appendChild(label);

    // Rows container
    const rowsEl = document.createElement("div");
    rowsEl.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    root.appendChild(rowsEl);

    // "+ Add" button
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

    // Parse any pre-existing value (e.g. default "[]")
    let initial = [];
    try { initial = JSON.parse(jsonWidget.value || "[]"); } catch {}
    _rebuildRows(state, initial, node);

    node.addDOMWidget("mask_list_ui", "customMaskList", root, {
        serialize: false,
        getHeight() {
            const rows = rowsEl.children.length;
            return 24 + rows * 30 + 34; // label + rows + add-btn
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
    for (const v of values) _addRow(state, v, node, /* sync */ false);
    _sync(state, node);
}

function _addRow(state, value, node, doSync = true) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;align-items:center;";

    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = "s3://bucket/mask.png";
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
