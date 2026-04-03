import { app } from "../../scripts/app.js";

const CONTROLLER_NODE_TYPE = "prompt_orchestration/node_state_controller";
let shortcutListenerRegistered = false;
let capturingControllerNode = null;

function normalizeShortcutPart(part) {
    if (!part) return "";

    const value = String(part).trim();
    if (!value) return "";

    const lower = value.toLowerCase();

    if (["ctrl", "control", "strg"].includes(lower)) return "Ctrl";
    if (["alt", "option"].includes(lower)) return "Alt";
    if (["shift"].includes(lower)) return "Shift";
    if (["meta", "cmd", "command", "super", "win", "windows"].includes(lower)) return "Meta";
    if (["esc", "escape"].includes(lower)) return "Escape";
    if (["space", "spacebar"].includes(lower)) return "Space";
    if (["arrowup", "up"].includes(lower)) return "ArrowUp";
    if (["arrowdown", "down"].includes(lower)) return "ArrowDown";
    if (["arrowleft", "left"].includes(lower)) return "ArrowLeft";
    if (["arrowright", "right"].includes(lower)) return "ArrowRight";
    if (["del", "delete"].includes(lower)) return "Delete";
    if (["return", "enter"].includes(lower)) return "Enter";
    if (["tab"].includes(lower)) return "Tab";
    if (["backspace"].includes(lower)) return "Backspace";
    if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();

    if (value.length === 1) {
        if (/[a-z]/i.test(value)) return value.toUpperCase();
        return value;
    }

    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function normalizeShortcutString(shortcut) {
    if (!shortcut) return "";

    const parts = String(shortcut)
        .split("+")
        .map((part) => normalizeShortcutPart(part))
        .filter(Boolean);

    if (parts.length === 0) return "";

    const modifiers = [];
    let key = "";

    for (const part of parts) {
        if (["Ctrl", "Alt", "Shift", "Meta"].includes(part)) {
            if (!modifiers.includes(part)) modifiers.push(part);
            continue;
        }

        key = part;
    }

    if (!key) return "";

    const orderedModifiers = ["Ctrl", "Alt", "Shift", "Meta"].filter((modifier) =>
        modifiers.includes(modifier)
    );

    return [...orderedModifiers, key].join("+");
}

function buildShortcutFromEvent(event) {
    const parts = [];

    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");

    const key = normalizeShortcutPart(event.key);

    if (!key || ["Ctrl", "Alt", "Shift", "Meta"].includes(key)) {
        return "";
    }

    parts.push(key);
    return parts.join("+");
}

function isTypingTarget(element) {
    if (!element) return false;

    if (element.isContentEditable) return true;

    const tagName = element.tagName ? element.tagName.toLowerCase() : "";
    return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function isShortcutInputActive(event) {
    return isTypingTarget(event.target) || isTypingTarget(document.activeElement);
}

function getMatchingControllerNodes(shortcut) {
    if (!shortcut || !app.graph || !Array.isArray(app.graph._nodes)) return [];

    return app.graph._nodes.filter((node) => {
        if (!node || node.type !== CONTROLLER_NODE_TYPE) return false;
        return normalizeShortcutString(node.properties?.shortcut) === shortcut;
    });
}

function getRowIdFromWidget(row) {
    if (!row) return "";

    if (row.idWidget && row.idWidget.value !== undefined && row.idWidget.value !== null) {
        return String(row.idWidget.value).trim();
    }

    return String(row.id ?? "").trim();
}

function getRowActionFromWidget(row) {
    if (!row) return "Mute";

    if (row.actionWidget && row.actionWidget.value !== undefined && row.actionWidget.value !== null) {
        return String(row.actionWidget.value || "Mute");
    }

    return String(row.action ?? "Mute");
}

function syncLiveValuesIntoProperties(node) {
    if (!node) return;
    if (!node.properties) node.properties = {};
    if (!Array.isArray(node.properties.rows)) node.properties.rows = [];
    if (!Array.isArray(node.rows)) node.rows = [];

    for (const row of node.rows) {
        row.id = getRowIdFromWidget(row);
        row.action = getRowActionFromWidget(row);
    }

    const liveShortcut =
        node.shortcutWidget && node.shortcutWidget.value !== undefined && node.shortcutWidget.value !== null
            ? node.shortcutWidget.value
            : node.properties.shortcut || "";

    const shouldPreserveStoredRows = !!node.properties.collapsed && node.rows.length === 0;

    node.properties.rows = shouldPreserveStoredRows
        ? node.properties.rows.map((row) => ({
              id: String(row?.id ?? ""),
              action: String(row?.action ?? "Mute")
          }))
        : node.rows.map((row) => ({
              id: row.id,
              action: row.action
          }));
    node.properties.collapsed = !!node.properties.collapsed;
    node.properties.shortcut = normalizeShortcutString(liveShortcut);

    if (node.shortcutWidget) {
        node.shortcutWidget.value = node.properties.shortcut;
    }
}

function refreshCaptureButtonLabel(node) {
    if (!node || !node.shortcutCaptureWidget) return;

    node.shortcutCaptureWidget.name =
        capturingControllerNode === node ? "Press shortcut..." : "Capture Shortcut";
}

function refreshAllCaptureButtonLabels() {
    if (!app.graph || !Array.isArray(app.graph._nodes)) return;

    for (const node of app.graph._nodes) {
        if (!node || node.type !== CONTROLLER_NODE_TYPE) continue;
        refreshCaptureButtonLabel(node);
    }

    app.graph.setDirtyCanvas(true);
}

function setCaptureNode(node) {
    capturingControllerNode = node || null;
    refreshCaptureButtonLabel(node);
    refreshAllCaptureButtonLabels();
}

function buildControllerWidgets(node) {
    node.widgets = [];

    node.applyWidget = node.addWidget("button", "APPLY", null, () => {
        node.applyActions();
    });

    node.collapseWidget = node.addWidget(
        "button",
        node.properties.collapsed ? "Expand ▼" : "Collapse ▲",
        null,
        () => node.toggleCollapse()
    );

    node.shortcutWidget = node.addWidget(
        "text",
        "Shortcut",
        node.properties.shortcut || "",
        (v) => {
            const normalizedShortcut = normalizeShortcutString(v);
            node.properties.shortcut = normalizedShortcut;
            node.shortcutWidget.value = normalizedShortcut;
            node.syncProperties();
            app.graph.setDirtyCanvas(true);
        }
    );

    node.shortcutCaptureWidget = node.addWidget(
        "button",
        "Capture Shortcut",
        null,
        () => {
            if (capturingControllerNode === node) {
                setCaptureNode(null);
                return;
            }
            setCaptureNode(node);
        }
    );
}

function rebuildControllerFromProperties(node) {
    if (!node.properties) node.properties = {};
    if (!Array.isArray(node.properties.rows)) node.properties.rows = [];
    if (node.properties.collapsed === undefined) node.properties.collapsed = false;
    if (typeof node.properties.shortcut !== "string") node.properties.shortcut = "";

    node.rows = [];
    buildControllerWidgets(node);
    node.rebuildUI();
    refreshCaptureButtonLabel(node);
}

function registerGlobalShortcutHandler() {
    if (shortcutListenerRegistered) return;
    shortcutListenerRegistered = true;

    window.addEventListener("keydown", (event) => {
        if (event.repeat) return;

        if (capturingControllerNode) {
            const pressedKey = normalizeShortcutPart(event.key);
            const capturedShortcut = buildShortcutFromEvent(event);

            if (!pressedKey) return;

            event.preventDefault();
            event.stopPropagation();

            if (pressedKey === "Escape") {
                setCaptureNode(null);
                return;
            }

            if (pressedKey === "Delete" || pressedKey === "Backspace") {
                capturingControllerNode.properties.shortcut = "";
                if (capturingControllerNode.shortcutWidget) {
                    capturingControllerNode.shortcutWidget.value = "";
                }
                capturingControllerNode.syncProperties();
                setCaptureNode(null);
                return;
            }

            if (!capturedShortcut) return;

            capturingControllerNode.properties.shortcut = capturedShortcut;
            if (capturingControllerNode.shortcutWidget) {
                capturingControllerNode.shortcutWidget.value = capturedShortcut;
            }
            capturingControllerNode.syncProperties();
            setCaptureNode(null);
            return;
        }

        if (event.defaultPrevented) return;
        if (isShortcutInputActive(event)) return;

        const shortcut = buildShortcutFromEvent(event);
        if (!shortcut) return;

        const matchingNodes = getMatchingControllerNodes(shortcut);
        if (matchingNodes.length === 0) return;

        event.preventDefault();
        event.stopPropagation();

        if (matchingNodes.length > 1) {
            console.warn(
                `[Dynamic Node State Controller] Shortcut "${shortcut}" is used multiple times.`
            );
            return;
        }

        const controllerNode = matchingNodes[0];
        if (typeof controllerNode.applyActions !== "function") return;

        controllerNode.applyActions();
    });
}

app.registerExtension({
    name: "prompt_orchestration.node_state_controller",

    registerCustomNodes() {
        registerGlobalShortcutHandler();

        const nodeType = LiteGraph.registered_node_types[CONTROLLER_NODE_TYPE];
        if (!nodeType) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        const originalOnConfigure = nodeType.prototype.onConfigure;
        const originalOnSerialize = nodeType.prototype.onSerialize;

        nodeType.prototype.onNodeCreated = function () {
            if (originalOnNodeCreated) {
                originalOnNodeCreated.apply(this, arguments);
            }

            if (!this.properties) this.properties = {};
            if (!Array.isArray(this.properties.rows)) this.properties.rows = [];
            if (this.properties.collapsed === undefined) this.properties.collapsed = false;
            if (typeof this.properties.shortcut !== "string") this.properties.shortcut = "";

            rebuildControllerFromProperties(this);
        };

        nodeType.prototype.onConfigure = function (info) {
            if (originalOnConfigure) {
                originalOnConfigure.apply(this, arguments);
            }

            if (!this.properties) this.properties = {};

            const savedProperties = info?.properties || {};

            if (Array.isArray(savedProperties.rows)) {
                this.properties.rows = savedProperties.rows.map((row) => ({
                    id: String(row?.id ?? ""),
                    action: String(row?.action ?? "Mute")
                }));
            } else if (!Array.isArray(this.properties.rows)) {
                this.properties.rows = [];
            }

            if (typeof savedProperties.collapsed === "boolean") {
                this.properties.collapsed = savedProperties.collapsed;
            } else if (this.properties.collapsed === undefined) {
                this.properties.collapsed = false;
            }

            if (typeof savedProperties.shortcut === "string") {
                this.properties.shortcut = normalizeShortcutString(savedProperties.shortcut);
            } else if (typeof this.properties.shortcut !== "string") {
                this.properties.shortcut = "";
            } else {
                this.properties.shortcut = normalizeShortcutString(this.properties.shortcut);
            }

            rebuildControllerFromProperties(this);
        };

        nodeType.prototype.onSerialize = function (o) {
            syncLiveValuesIntoProperties(this);

            if (originalOnSerialize) {
                originalOnSerialize.apply(this, arguments);
            }

            if (!o.properties) o.properties = {};
            o.properties.rows = Array.isArray(this.properties.rows)
                ? this.properties.rows.map((row) => ({
                    id: String(row?.id ?? ""),
                    action: String(row?.action ?? "Mute")
                }))
                : [];
            o.properties.collapsed = !!this.properties.collapsed;
            o.properties.shortcut = normalizeShortcutString(this.properties.shortcut || "");
        };

        nodeType.prototype.toggleCollapse = function () {
            syncLiveValuesIntoProperties(this);
            this.properties.collapsed = !this.properties.collapsed;
            buildControllerWidgets(this);
            this.rebuildUI();
            refreshCaptureButtonLabel(this);
        };

        nodeType.prototype.rebuildUI = function () {
            if (this.properties.collapsed) {
                this.setSize([340, 200]);
                app.graph.setDirtyCanvas(true);
                return;
            }

            this.rows = [];

            for (let data of this.properties.rows) {
                this.addRowWithData(data.id, data.action);
            }

            if (this.rows.length === 0) {
                this.addRowWithData("", "Mute");
            }

            this.updateLayout();
        };

        nodeType.prototype.addRowWithData = function (idValue, actionValue) {
            const row = { id: idValue, action: actionValue };

            row.idWidget = this.addWidget("text", "Node ID", idValue, (v) => {
                row.id = v.trim();
                this.syncProperties();
                this.checkAddRow();
            });

            row.actionWidget = this.addWidget(
                "combo",
                "Action",
                actionValue,
                (v) => {
                    row.action = v;
                    this.syncProperties();
                },
                {
                    values: ["Mute", "Unmute", "Bypass", "Unbypass"]
                }
            );

            row.removeWidget = this.addWidget("button", "✖ Remove", null, () => {
                this.widgets = this.widgets.filter(
                    (w) => w !== row.idWidget && w !== row.actionWidget && w !== row.removeWidget
                );

                this.rows.splice(this.rows.indexOf(row), 1);
                this.syncProperties();
                this.updateLayout();
            });

            this.rows.push(row);
            this.syncProperties();
        };

        nodeType.prototype.checkAddRow = function () {
            const lastRow = this.rows[this.rows.length - 1];
            if (lastRow && lastRow.id !== "") {
                this.addRowWithData("", "Mute");
            }
        };

        nodeType.prototype.syncProperties = function () {
            syncLiveValuesIntoProperties(this);
        };

        nodeType.prototype.updateLayout = function () {
            this.setSize([340, 230 + this.rows.length * 70]);
            app.graph.setDirtyCanvas(true);
        };

        nodeType.prototype.applyActions = function () {
            syncLiveValuesIntoProperties(this);
            app.graph.beforeChange();

            const actionRows =
                Array.isArray(this.rows) && this.rows.length > 0
                    ? this.rows
                    : Array.isArray(this.properties?.rows)
                        ? this.properties.rows
                        : [];

            for (let row of actionRows) {
                if (!row.id) continue;

                const id = Number(row.id);
                if (isNaN(id)) continue;

                const node = app.graph.getNodeById(id);
                if (!node) continue;

                switch (row.action) {
                    case "Mute":
                        node.mode = 2;
                        break;
                    case "Unmute":
                        node.mode = 0;
                        break;
                    case "Bypass":
                        node.mode = 4;
                        break;
                    case "Unbypass":
                        node.mode = 0;
                        break;
                }
            }

            app.graph.afterChange();
            app.graph.setDirtyCanvas(true);
        };
    }
});
