import { app } from "../../scripts/app.js";

const CONTROLLER_NODE_TYPE = "prompt_orchestration/node_state_controller";
const TARGET_KEY_PROPERTY = "node_state_controller_key";
const TARGET_CAPTURE_HANDLER_PROPERTY = "__promptOrchestrationNodeStateTargetCaptureHandler";
const SHORTCUT_HANDLER_PROPERTY = "__promptOrchestrationNodeStateShortcutHandler";
const CONTROLLER_WIDTH = 340;

let capturingControllerNode = null;
let targetCapturingControllerNode = null;
let lastCapturedTargetKey = "";
let lastCapturedTargetTime = 0;

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

function getShortcutPartFromEvent(event) {
    const code = String(event?.code ?? "");
    const numpadDigitMatch = /^Numpad([0-9])$/.exec(code);

    if (numpadDigitMatch) {
        return numpadDigitMatch[1];
    }

    return normalizeShortcutPart(event?.key);
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

    const key = getShortcutPartFromEvent(event);

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

function getRowLabelFromWidget(row) {
    if (!row) return "";

    if (row.labelWidget && row.labelWidget.value !== undefined && row.labelWidget.value !== null) {
        return String(row.labelWidget.value).trim();
    }

    return String(row.label ?? "").trim();
}

function getRowTargetKeyFromWidget(row) {
    if (!row) return "";

    return String(row.target_key ?? "").trim();
}

function getRowActionFromWidget(row) {
    if (!row) return "Mute";

    if (row.actionWidget && row.actionWidget.value !== undefined && row.actionWidget.value !== null) {
        return String(row.actionWidget.value || "Mute");
    }

    return String(row.action ?? "Mute");
}

function showNodeStateControllerWarning(message) {
    console.warn(`[Dynamic Node State Controller] ${message}`);
    window.alert(`Node State Controller warning:\n${message}`);
}

function createTargetKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return `nsc_${window.crypto.randomUUID()}`;
    }

    return `nsc_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function getNodeLabel(node) {
    if (!node) return "";
    return String(node.title || node.type || "Node");
}

function getNodeStateControllerKey(node) {
    if (!node || !node.properties) return "";
    return String(node.properties[TARGET_KEY_PROPERTY] || "").trim();
}

function ensureNodeStateControllerKey(node) {
    if (!node) return "";

    if (!node.properties) node.properties = {};

    const existingKey = getNodeStateControllerKey(node);
    if (existingKey) return existingKey;

    const newKey = createTargetKey();
    node.properties[TARGET_KEY_PROPERTY] = newKey;
    return newKey;
}

function findNodesByTargetKey(targetKey) {
    if (!targetKey || !app.graph || !Array.isArray(app.graph._nodes)) return [];

    return app.graph._nodes.filter((node) => {
        if (!node || !node.properties) return false;
        return getNodeStateControllerKey(node) === targetKey;
    });
}

function applyRowAction(node, action) {
    if (!node) return;

    switch (action) {
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

function syncLiveValuesIntoProperties(node) {
    if (!node) return;
    if (!node.properties) node.properties = {};
    if (!Array.isArray(node.properties.rows)) node.properties.rows = [];
    if (!Array.isArray(node.rows)) node.rows = [];

    for (const row of node.rows) {
        row.label = getRowLabelFromWidget(row);
        row.target_key = getRowTargetKeyFromWidget(row);
        row.action = getRowActionFromWidget(row);
    }

    const liveShortcut =
        node.shortcutWidget && node.shortcutWidget.value !== undefined && node.shortcutWidget.value !== null
            ? node.shortcutWidget.value
            : node.properties.shortcut || "";

    const shouldPreserveStoredRows = !!node.properties.collapsed && node.rows.length === 0;

    node.properties.rows = shouldPreserveStoredRows
        ? node.properties.rows.map((row) => ({
              label: String(row?.label ?? ""),
              target_key: String(row?.target_key ?? ""),
              action: String(row?.action ?? "Mute")
          }))
        : node.rows
              .filter((row) => row.target_key)
              .map((row) => ({
                  label: row.label,
                  target_key: row.target_key,
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

function refreshTargetCaptureButtonLabel(node) {
    if (!node || !node.targetCaptureWidget) return;

    node.targetCaptureWidget.name =
        targetCapturingControllerNode === node ? "Click target nodes..." : "Capture Target";
}

function refreshAllCaptureButtonLabels() {
    if (!app.graph || !Array.isArray(app.graph._nodes)) return;

    for (const node of app.graph._nodes) {
        if (!node || node.type !== CONTROLLER_NODE_TYPE) continue;
        refreshCaptureButtonLabel(node);
        refreshTargetCaptureButtonLabel(node);
    }

    app.graph.setDirtyCanvas(true);
}

function refreshAllTargetCaptureButtonLabels() {
    refreshAllCaptureButtonLabels();
}

function setCaptureNode(node) {
    capturingControllerNode = node || null;

    if (capturingControllerNode) {
        targetCapturingControllerNode = null;
    }

    refreshCaptureButtonLabel(node);
    refreshAllCaptureButtonLabels();
}

function setTargetCaptureNode(node) {
    targetCapturingControllerNode = node || null;

    if (targetCapturingControllerNode) {
        capturingControllerNode = null;
    }

    refreshTargetCaptureButtonLabel(node);
    refreshAllTargetCaptureButtonLabels();
}

function getStoredRows(node) {
    if (!node || !node.properties || !Array.isArray(node.properties.rows)) return [];

    return node.properties.rows
        .filter((row) => row?.target_key)
        .map((row) => ({
            label: String(row?.label ?? ""),
            target_key: String(row?.target_key ?? ""),
            action: String(row?.action ?? "Mute")
        }));
}

function addTargetToController(controllerNode, targetNode) {
    if (!controllerNode || !targetNode) return;
    if (controllerNode === targetNode) return;

    if (!controllerNode.properties) controllerNode.properties = {};
    if (!Array.isArray(controllerNode.properties.rows)) controllerNode.properties.rows = [];

    const targetKey = ensureNodeStateControllerKey(targetNode);
    if (!targetKey) return;

    const now = performance.now ? performance.now() : Date.now();
    if (lastCapturedTargetKey === targetKey && now - lastCapturedTargetTime < 150) return;
    lastCapturedTargetKey = targetKey;
    lastCapturedTargetTime = now;

    syncLiveValuesIntoProperties(controllerNode);

    const label = getNodeLabel(targetNode);
    const existingRow = controllerNode.properties.rows.find((row) => row.target_key === targetKey);

    if (existingRow) {
        existingRow.label = label;
        controllerNode.rebuildUI();
        controllerNode.syncProperties();
        app.graph.setDirtyCanvas(true);
        return;
    }

    controllerNode.properties.rows.push({
        label,
        target_key: targetKey,
        action: "Mute"
    });

    controllerNode.rebuildUI();
    controllerNode.syncProperties();
    app.graph.setDirtyCanvas(true);
}

function getEventPath(event) {
    if (typeof event?.composedPath === "function") {
        return event.composedPath();
    }

    return event?.target ? [event.target] : [];
}

function normalizeGraphNodeId(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;

    return /^-?\d+$/.test(text) ? Number(text) : text;
}

function getNodeFromVueEvent(event, graph) {
    if (!graph || typeof graph.getNodeById !== "function") return null;

    for (const element of getEventPath(event)) {
        if (
            !element ||
            typeof element.matches !== "function" ||
            !element.matches(".lg-node[data-node-id]")
        ) {
            continue;
        }

        const rawNodeId = element.getAttribute("data-node-id");
        if (rawNodeId === null) continue;

        const nodeId = normalizeGraphNodeId(rawNodeId);
        if (nodeId === null) continue;

        const node = graph.getNodeById(nodeId) || graph.getNodeById(String(rawNodeId));
        if (node) return node;
    }

    return null;
}

function getCanvasGraphPositionFromEvent(event) {
    const canvas = app.canvas;
    const canvasElement = canvas?.canvas;
    if (!canvas || !canvasElement || !event) return null;

    if (typeof canvas.convertEventToCanvasOffset === "function") {
        const graphPosition = canvas.convertEventToCanvasOffset(event);
        if (Array.isArray(graphPosition)) return graphPosition;
    }

    const rect = canvasElement.getBoundingClientRect();
    const canvasPosition = [
        event.clientX - rect.left,
        event.clientY - rect.top
    ];

    if (typeof canvas.convertCanvasToOffset === "function") {
        return canvas.convertCanvasToOffset(canvasPosition);
    }

    if (canvas.ds && typeof canvas.ds.convertCanvasToOffset === "function") {
        return canvas.ds.convertCanvasToOffset(canvasPosition);
    }

    if (canvas.ds && Array.isArray(canvas.ds.offset) && typeof canvas.ds.scale === "number") {
        return [
            (canvasPosition[0] - canvas.ds.offset[0]) / canvas.ds.scale,
            (canvasPosition[1] - canvas.ds.offset[1]) / canvas.ds.scale
        ];
    }

    return canvasPosition;
}

function getNodeFromCanvasEvent(event) {
    const canvas = app.canvas;
    const graph = canvas?.graph;
    if (!canvas || !graph) return null;

    const vueNode = getNodeFromVueEvent(event, graph);
    if (vueNode) return vueNode;

    if (!getEventPath(event).includes(canvas.canvas)) return null;
    if (typeof graph.getNodeOnPos !== "function") return null;

    const pos = getCanvasGraphPositionFromEvent(event);
    if (!Array.isArray(pos)) return null;

    return graph.getNodeOnPos(pos[0], pos[1], canvas.visible_nodes, 5) || null;
}

function isControllerAttachedToGraph(controllerNode) {
    return !!(
        controllerNode?.graph &&
        Array.isArray(controllerNode.graph._nodes) &&
        controllerNode.graph._nodes.includes(controllerNode)
    );
}

function handleTargetCaptureMouseEvent(event) {
    const controllerNode = targetCapturingControllerNode;
    if (!controllerNode) return false;
    if (!event || event.button !== 0) return false;

    if (!isControllerAttachedToGraph(controllerNode)) {
        setTargetCaptureNode(null);
        return false;
    }

    const targetNode = getNodeFromCanvasEvent(event);
    if (!targetNode) return false;
    if (targetNode === controllerNode) return false;

    const activeGraph = app.canvas?.graph;
    if (activeGraph !== controllerNode.graph || targetNode.graph !== controllerNode.graph) {
        setTargetCaptureNode(null);
        showNodeStateControllerWarning(
            "Target Capture only supports nodes in the same graph as the controller."
        );
        return false;
    }

    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();

    controllerNode.graph.beforeChange();
    try {
        addTargetToController(controllerNode, targetNode);
    } finally {
        controllerNode.graph.afterChange();
    }

    return true;
}

function addSpacerWidget(node, targetKey) {
    const spacerWidget = node.addWidget("button", `Spacer:${targetKey}`, null, () => {});
    spacerWidget.label = " ";
    spacerWidget.serialize = false;
    spacerWidget.disabled = true;
    spacerWidget.computeSize = function () {
        return [0, 16];
    };
    return spacerWidget;
}

function buildControllerWidgets(node) {
    node.widgets = [];

    node.applyWidget = node.addWidget("button", "APPLY", null, () => {
        node.applyActions();
    });
    node.applyWidget.computeSize = function () {
        const standardHeight = Number(LiteGraph.NODE_WIDGET_HEIGHT) || 20;
        return [0, standardHeight * 2];
    };
    node.applyWidget.draw = function (ctx, _node, width, y, _height, lowQuality) {
        const height = this.computeSize(width)[1];
        const margin = 15;

        ctx.save();
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR || "#222";
        ctx.fillRect(margin, y, width - margin * 2, height);

        if (!lowQuality && !this.computedDisabled) {
            ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR || "#666";
            ctx.strokeRect(margin, y, width - margin * 2, height);
        }

        if (!lowQuality) {
            const standardTextSize = Number(LiteGraph.NODE_TEXT_SIZE) || 14;
            ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR || "#DDD";
            ctx.font = `bold ${Math.max(18, standardTextSize + 4)}px Arial`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("APPLY", width * 0.5, y + height * 0.5);
        }

        ctx.restore();
    };

    node.targetCaptureWidget = node.addWidget(
        "button",
        targetCapturingControllerNode === node ? "Click target nodes..." : "Capture Target",
        null,
        () => {
            if (targetCapturingControllerNode === node) {
                setTargetCaptureNode(null);
                return;
            }
            setTargetCaptureNode(node);
        }
    );

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
    node.rebuildUI();
    refreshCaptureButtonLabel(node);
    refreshTargetCaptureButtonLabel(node);
}

function registerGlobalShortcutHandler() {
    const previousHandler = window[SHORTCUT_HANDLER_PROPERTY];
    if (typeof previousHandler === "function") {
        window.removeEventListener("keydown", previousHandler, true);
    }

    const shortcutHandler = (event) => {
        if (event.repeat) return;

        if (capturingControllerNode) {
            const pressedKey = getShortcutPartFromEvent(event);
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
            showNodeStateControllerWarning(
                "This shortcut is used by multiple Node State Controllers.\nPlease remove or change one shortcut."
            );
            return;
        }

        const controllerNode = matchingNodes[0];
        if (typeof controllerNode.applyActions !== "function") return;

        controllerNode.applyActions();
    };

    window[SHORTCUT_HANDLER_PROPERTY] = shortcutHandler;
    window.addEventListener("keydown", shortcutHandler, true);
}

function registerGlobalTargetCaptureHandler() {
    const previousHandler = window[TARGET_CAPTURE_HANDLER_PROPERTY];
    if (typeof previousHandler === "function") {
        window.removeEventListener("pointerdown", previousHandler, true);
    }

    const targetCaptureHandler = (event) => {
        handleTargetCaptureMouseEvent(event);
    };

    window[TARGET_CAPTURE_HANDLER_PROPERTY] = targetCaptureHandler;
    window.addEventListener("pointerdown", targetCaptureHandler, true);
}

app.registerExtension({
    name: "prompt_orchestration.node_state_controller",

    registerCustomNodes() {
        registerGlobalShortcutHandler();
        registerGlobalTargetCaptureHandler();

        const nodeType = LiteGraph.registered_node_types[CONTROLLER_NODE_TYPE];
        if (!nodeType) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        const originalOnConfigure = nodeType.prototype.onConfigure;
        const originalOnSerialize = nodeType.prototype.onSerialize;
        const originalOnRemoved = nodeType.prototype.onRemoved;

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
                this.properties.rows = savedProperties.rows
                    .map((row) => ({
                        label: String(row?.label ?? ""),
                        target_key: String(row?.target_key ?? ""),
                        action: String(row?.action ?? "Mute")
                    }))
                    .filter((row) => row.target_key);
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
                ? this.properties.rows
                      .filter((row) => row?.target_key)
                      .map((row) => ({
                          label: String(row?.label ?? ""),
                          target_key: String(row?.target_key ?? ""),
                          action: String(row?.action ?? "Mute")
                      }))
                : [];
            o.properties.collapsed = !!this.properties.collapsed;
            o.properties.shortcut = normalizeShortcutString(this.properties.shortcut || "");
        };

        nodeType.prototype.onRemoved = function () {
            if (capturingControllerNode === this) {
                setCaptureNode(null);
            }

            if (targetCapturingControllerNode === this) {
                setTargetCaptureNode(null);
            }

            if (originalOnRemoved) {
                return originalOnRemoved.apply(this, arguments);
            }
        };

        nodeType.prototype.toggleCollapse = function () {
            syncLiveValuesIntoProperties(this);
            this.properties.collapsed = !this.properties.collapsed;
            this.rebuildUI();
            refreshCaptureButtonLabel(this);
            refreshTargetCaptureButtonLabel(this);
        };

        nodeType.prototype.rebuildUI = function () {
            const storedRows = getStoredRows(this);

            buildControllerWidgets(this);

            if (this.properties.collapsed) {
                this.rows = [];
                this.setSize([CONTROLLER_WIDTH, Math.ceil(this.computeSize()[1])]);
                app.graph.setDirtyCanvas(true);
                return;
            }

            this.rows = [];

            for (let data of storedRows) {
                this.addRowWithData(data.label, data.target_key, data.action);
            }

            this.updateLayout();
        };

        nodeType.prototype.addRowWithData = function (labelValue, targetKeyValue, actionValue) {
            const row = {
                label: String(labelValue ?? ""),
                target_key: String(targetKeyValue ?? ""),
                action: String(actionValue ?? "Mute"),
                spacerWidget: null
            };

            if (Array.isArray(this.rows) && this.rows.length > 0) {
                row.spacerWidget = addSpacerWidget(this, row.target_key);
            }

            row.labelWidget = this.addWidget("text", `Target:${row.target_key}`, row.label, (v) => {
                row.label = String(v ?? "").trim();
                this.syncProperties();
            });
            row.labelWidget.label = "Target";

            row.actionWidget = this.addWidget(
                "combo",
                `Action:${row.target_key}`,
                row.action,
                (v) => {
                    row.action = v;
                    this.syncProperties();
                },
                {
                    values: ["Mute", "Unmute", "Bypass", "Unbypass"]
                }
            );
            row.actionWidget.label = "Action";

            row.removeWidget = this.addWidget("button", `Remove:${row.target_key}`, null, () => {
                this.widgets = this.widgets.filter(
                    (w) =>
                        w !== row.spacerWidget &&
                        w !== row.labelWidget &&
                        w !== row.actionWidget &&
                        w !== row.removeWidget
                );

                this.rows.splice(this.rows.indexOf(row), 1);
                this.syncProperties();
                this.rebuildUI();
            });
            row.removeWidget.label = "✖ Remove";

            this.rows.push(row);
            this.syncProperties();
        };

        nodeType.prototype.checkAddRow = function () {
            return;
        };

        nodeType.prototype.syncProperties = function () {
            syncLiveValuesIntoProperties(this);
        };

        nodeType.prototype.updateLayout = function () {
            this.setSize([CONTROLLER_WIDTH, Math.ceil(this.computeSize()[1])]);
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

            const duplicateTargets = [];

            for (let row of actionRows) {
                if (!row.target_key) continue;

                const matches = findNodesByTargetKey(row.target_key);

                if (matches.length === 0) {
                    console.warn(
                        `[Dynamic Node State Controller] Target "${row.label}" was not found.`
                    );
                    continue;
                }

                if (matches.length > 1) {
                    duplicateTargets.push(String(row.label || "Unnamed target"));
                    continue;
                }

                const node = matches[0];
                row.label = getNodeLabel(node);

                applyRowAction(node, row.action);
            }

            if (duplicateTargets.length > 0) {
                const uniqueTargets = [...new Set(duplicateTargets)];

                showNodeStateControllerWarning(
                    `These targets exist multiple times:\n- ${uniqueTargets.join("\n- ")}\n\nThis usually happens after duplicating nodes or modules.\nActions were skipped to prevent wrong node changes.`
                );
            }

            this.syncProperties();
            app.graph.afterChange();
            app.graph.setDirtyCanvas(true);
        };
    }
});
