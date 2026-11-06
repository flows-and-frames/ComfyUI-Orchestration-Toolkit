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

/**
 * Nicht blockierende Meldung mit dem Titel des Controllers als Ueberschrift.
 *
 * Gleiches Muster wie notify in prompt_storage.js. Ergebnismeldungen eines Knopfes sollen
 * nicht wie showNodeStateControllerWarning ein Fenster oeffnen, das man bei jedem Druck
 * wegklicken muss.
 */
function notifyController(controllerNode, message, kind = "info") {
    const title = String(controllerNode?.title || "Node State Controller");
    const severity = kind === "warn" ? "warn" : kind === "success" ? "success" : "info";
    console.info(`[Dynamic Node State Controller] ${title}: ${message}`);

    const toast = app.extensionManager?.toast;
    if (toast?.add) {
        toast.add({ severity, summary: title, detail: message, life: 6000 });
    }
}

function pluralize(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
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

    // properties.rows ist die vollstaendige Wahrheit, node.rows zeigt nur die sichtbare
    // Seite. Die sichtbaren Zeilen werden deshalb EINGEMISCHT, nicht ersetzt — sonst
    // loescht jede Synchronisierung alle Zeilen der uebrigen Seiten.
    const storedRows = node.properties.rows.map((row) => ({
        label: String(row?.label ?? ""),
        target_key: String(row?.target_key ?? ""),
        action: String(row?.action ?? "Mute")
    }));

    const visibleRows = node.rows
        .filter((row) => row.target_key)
        .map((row) => ({
            label: row.label,
            target_key: row.target_key,
            action: row.action
        }));

    if (visibleRows.length === 0) {
        node.properties.rows = storedRows;
    } else {
        const visibleByKey = new Map(visibleRows.map((row) => [row.target_key, row]));
        const merged = storedRows.map((row) => visibleByKey.get(row.target_key) ?? row);
        const storedKeys = new Set(storedRows.map((row) => row.target_key));
        for (const row of visibleRows) {
            if (!storedKeys.has(row.target_key)) merged.push(row);
        }
        node.properties.rows = merged;
    }

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

const NODE_MODE_MUTED = 2;
const NODE_MODE_BYPASSED = 4;

/** Die Action, die dem aktuellen Modus einer Node entspricht. */
function actionForNodeMode(node) {
    switch (node?.mode) {
        case NODE_MODE_MUTED:
            return "Mute";
        case NODE_MODE_BYPASSED:
            return "Bypass";
        default:
            return "Unmute";
    }
}

/** Output-Nodes tragen die Kennzeichnung in ihren nodeData. */
function isOutputNode(node) {
    return Boolean(node?.constructor?.nodeData?.output_node);
}

/** Sichtbare Zeilen je Seite. */
const ROWS_PER_PAGE = 10;

/**
 * Die Auswahl, wie sie unmittelbar vor dem letzten Mausklick bestand.
 *
 * Noetig, weil ein Klick auf den Capture-Knopf die Controller-Node selektiert und die
 * vorherige Mehrfachauswahl damit aufhebt. Der globale pointerdown-Handler laeuft in der
 * Capture-Phase und sieht die Auswahl noch, bevor LiteGraph sie ersetzt.
 */
let selectionBeforeClick = [];

function rememberSelectionBeforeClick() {
    selectionBeforeClick = getSelectedGraphNodes();
}

/** Die aktuell markierten Nodes der Canvas. */
function getSelectedGraphNodes() {
    const selection = app.canvas?.selected_nodes;
    if (!selection) return [];
    return Object.values(selection).filter(Boolean);
}

function refreshControllerAfterCapture(controllerNode) {
    controllerNode.rebuildUI();
    controllerNode.syncProperties();
    app.graph.setDirtyCanvas(true);
}

/**
 * Nimmt eine Node als Target auf.
 *
 * options.updateAction  Bestehende Zeilen bekommen den aktuellen Modus. Nur Update from
 *                       Graph setzt das. Capture und Snapshot fuegen nur hinzu und lassen
 *                       Handarbeit in Ruhe.
 * options.deferRefresh  Kein rebuildUI je Node. Der Aufrufer aktualisiert einmal am
 *                       Ende - sonst kostet eine Auswahl mit vielen Nodes je Node
 *                       einen vollstaendigen UI-Neuaufbau.
 */
function addTargetToController(controllerNode, targetNode, options) {
    if (!controllerNode || !targetNode) return false;
    if (controllerNode === targetNode) return false;

    const updateAction = options?.updateAction === true;
    const deferRefresh = options?.deferRefresh === true;

    if (!controllerNode.properties) controllerNode.properties = {};
    if (!Array.isArray(controllerNode.properties.rows)) controllerNode.properties.rows = [];

    const targetKey = ensureNodeStateControllerKey(targetNode);
    if (!targetKey) return false;

    if (!deferRefresh) {
        const now = performance.now ? performance.now() : Date.now();
        if (lastCapturedTargetKey === targetKey && now - lastCapturedTargetTime < 150) return false;
        lastCapturedTargetKey = targetKey;
        lastCapturedTargetTime = now;
    }

    // Im Stapel darf hier NICHT synchronisiert werden: syncLiveValuesIntoProperties baut
    // properties.rows aus den Widget-Zeilen neu auf, und die Widgets werden erst am Ende
    // des Stapels neu gebaut. Ein Aufruf je Node loescht deshalb alle zuvor angehaengten
    // Zeilen wieder — es ueberlebt nur die letzte.
    if (!deferRefresh) syncLiveValuesIntoProperties(controllerNode);

    const label = getNodeLabel(targetNode);
    const existingRow = controllerNode.properties.rows.find((row) => row.target_key === targetKey);

    if (existingRow) {
        existingRow.label = label;
        if (updateAction) existingRow.action = actionForNodeMode(targetNode);
        if (!deferRefresh) refreshControllerAfterCapture(controllerNode);
        return true;
    }

    controllerNode.properties.rows.push({
        label,
        target_key: targetKey,
        action: actionForNodeMode(targetNode)
    });

    if (!deferRefresh) refreshControllerAfterCapture(controllerNode);
    return true;
}

/** Nimmt mehrere Nodes in einem Durchgang auf und baut die UI genau einmal neu. */
function addTargetsToController(controllerNode, targetNodes, options) {
    if (!controllerNode || !Array.isArray(targetNodes) || targetNodes.length === 0) return 0;

    // Genau einmal, vor der Schleife. Siehe Begruendung in addTargetToController.
    syncLiveValuesIntoProperties(controllerNode);

    let captured = 0;
    for (const targetNode of targetNodes) {
        if (addTargetToController(controllerNode, targetNode, { ...options, deferRefresh: true })) {
            captured++;
        }
    }

    if (captured > 0) refreshControllerAfterCapture(controllerNode);
    return captured;
}

/**
 * Nimmt alle Output-Nodes des Graphen auf, die noch fehlen, mit ihrem aktuellen Zustand.
 *
 * ComfyUI fuehrt rueckwaerts von den Output-Nodes aus; sie allein entscheiden, welcher
 * Zweig laeuft. Deshalb genuegt diese Auswahl fuer die Zweigsteuerung.
 *
 * Bestehende Zeilen bleiben unveraendert. Frueher setzte der Snapshot auch sie auf den
 * aktuellen Zustand; auf einem Controller gedrueckt, dessen Variante gerade nicht
 * anlag, ueberschrieb er sie damit mit einer fremden Variante. Neu einlesen ist jetzt
 * ausschliesslich Aufgabe von Update from Graph.
 */
function snapshotOutputsToController(controllerNode) {
    if (!controllerNode || !controllerNode.graph) return;

    const outputs = controllerNode.graph._nodes.filter(
        (node) => node !== controllerNode && isOutputNode(node)
    );

    if (outputs.length === 0) {
        showNodeStateControllerWarning(
            "No output nodes found in this graph." +
                " Snapshot captures output nodes only."
        );
        return;
    }

    controllerNode.graph.beforeChange();
    try {
        const captured = addTargetsToController(controllerNode, outputs);
        console.log(
            `[Dynamic Node State Controller] Snapshot: ${captured} of ${outputs.length} output nodes captured.`
        );
    } finally {
        controllerNode.graph.afterChange();
    }
}

// ---------------------------------------------------------------------------
// Update from Graph und Freigabe kopierter Schluessel
// ---------------------------------------------------------------------------

/** Verzeichnis Schluessel -> Nodes. Dieselbe Bauweise wie in applyActions. */
function buildTargetKeyIndex(graph) {
    const index = new Map();

    for (const graphNode of graph?._nodes ?? []) {
        if (!graphNode || !graphNode.properties) continue;
        const key = getNodeStateControllerKey(graphNode);
        if (!key) continue;
        const bucket = index.get(key);
        if (bucket) bucket.push(graphNode);
        else index.set(key, [graphNode]);
    }

    return index;
}

/**
 * Setzt jede Zeile auf den Zustand, in dem ihre Node gerade steht. Fuegt nichts hinzu
 * und entfernt nichts.
 *
 * Der Knopf liest den Graphen, nicht den Controller. Er gehoert deshalb nur auf einen
 * Controller, dessen Variante gerade anliegt - sonst wird diese Variante zur Kopie der
 * anliegenden.
 */
function updateControllerFromGraph(controllerNode) {
    if (!controllerNode || !controllerNode.graph) return;

    // Genau einmal vor der Schleife, wie bei jeder Stapelaufnahme.
    syncLiveValuesIntoProperties(controllerNode);

    const rows = getStoredRows(controllerNode);
    if (rows.length === 0) {
        notifyController(controllerNode, "No targets to update.");
        return;
    }

    // Dieselbe Aufloesung wie applyActions: Was APPLY schreiben wuerde, liest dieser
    // Knopf auch.
    const index = buildTargetKeyIndex(app.graph);

    let updated = 0;
    let changed = 0;
    let notFound = 0;
    let duplicated = 0;

    controllerNode.graph.beforeChange();
    try {
        for (const row of rows) {
            const matches = index.get(row.target_key) ?? [];
            if (matches.length === 0) {
                notFound++;
                continue;
            }
            if (matches.length > 1) {
                duplicated++;
                continue;
            }

            const actionBefore = row.action;
            const done = addTargetToController(controllerNode, matches[0], {
                updateAction: true,
                deferRefresh: true
            });
            if (!done) continue;

            updated++;
            const stored = controllerNode.properties.rows.find(
                (candidate) => candidate.target_key === row.target_key
            );
            if (stored && stored.action !== actionBefore) changed++;
        }

        refreshControllerAfterCapture(controllerNode);
    } finally {
        controllerNode.graph.afterChange();
    }

    const parts = [`${pluralize(updated, "row", "rows")} updated (${changed} changed)`];
    if (notFound > 0) parts.push(`${pluralize(notFound, "target", "targets")} not found`);
    if (duplicated > 0) parts.push(`${pluralize(duplicated, "target", "targets")} duplicated`);
    notifyController(
        controllerNode,
        `${parts.join(", ")}.`,
        notFound + duplicated > 0 ? "warn" : "success"
    );
}

/** Nummer einer Node als Zahl. Node-Nummern sind im Frontend Zeichenketten. */
function numericItemId(item) {
    const value = Number(item?.id);
    return Number.isInteger(value) ? value : null;
}

/**
 * Kopien verlieren ihren Schluessel.
 *
 * Laeuft nach jedem Einfuegen, Klonen oder Alt-Ziehen. Alle diese Wege enden in
 * LGraphCanvas._deserializeItems: Dort werden zuerst nur die eingefuegten Dinge
 * markiert - selectItems hebt jede andere Auswahl auf - und danach wird auf jeder Node
 * onAfterGraphConfigured aufgerufen. Beim Laden eines Workflows laeuft derselbe Haken;
 * dann ist nichts markiert, und es geschieht nichts.
 *
 * Gibt es einen Schluessel doppelt, verliert ihn jede Kopie. Kopie heisst: markiert und
 * mit hoeherer Nummer als jede unmarkierte Node im Graphen. Eingefuegtes bekommt immer
 * die hoechsten Nummern. Die zweite Bedingung schuetzt Originale, die eine eingefuegte
 * Gruppe beim Markieren ihres Inhalts mitmarkiert haben koennte.
 *
 * Der Schluessel wird entfernt, nicht erneuert: Die Kopie ist danach von niemandem
 * gesteuert, und ein spaeteres Capture gibt ihr einen neuen. Gibt es den Schluessel im
 * Graphen nur einmal - etwa nach dem Einfuegen in einen anderen Workflow -, geschieht
 * nichts, und mitkopierte Controller steuern ihre mitkopierten Nodes weiter.
 */
function releasePastedCopies(graph) {
    if (!graph) return;

    let maxUnselectedId = -Infinity;
    const holdersByKey = new Map();

    for (const graphNode of graph._nodes ?? []) {
        if (!graphNode) continue;

        const id = numericItemId(graphNode);
        if (!graphNode.selected && id !== null && id > maxUnselectedId) maxUnselectedId = id;

        const key = getNodeStateControllerKey(graphNode);
        if (!key) continue;
        const bucket = holdersByKey.get(key);
        if (bucket) bucket.push(graphNode);
        else holdersByKey.set(key, [graphNode]);
    }

    let released = 0;
    for (const holders of holdersByKey.values()) {
        if (holders.length < 2) continue;
        if (!holders.some((graphNode) => !graphNode.selected)) continue;

        for (const graphNode of holders) {
            if (!graphNode.selected) continue;
            const id = numericItemId(graphNode);
            if (id === null || id <= maxUnselectedId) continue;
            delete graphNode.properties[TARGET_KEY_PROPERTY];
            released++;
        }
    }

    if (released > 0) {
        console.info(
            `[Dynamic Node State Controller] Released ${pluralize(released, "key", "keys")} from pasted copies.`
        );
    }
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

    // Ist mehr als eine Node markiert und die angeklickte gehoert dazu, wird die ganze
    // Auswahl aufgenommen. Ein einzelner Klick verhaelt sich unveraendert.
    const selection = getSelectedGraphNodes();
    const batch =
        selection.length > 1 && selection.includes(targetNode)
            ? selection.filter(
                  (node) => node !== controllerNode && node.graph === controllerNode.graph
              )
            : [targetNode];

    controllerNode.graph.beforeChange();
    try {
        if (batch.length > 1) {
            const captured = addTargetsToController(controllerNode, batch);
            console.log(
                `[Dynamic Node State Controller] Captured ${captured} of ${batch.length} selected nodes.`
            );
        } else {
            addTargetToController(controllerNode, targetNode);
        }
    } finally {
        controllerNode.graph.afterChange();
    }

    return true;
}

function addSpacerWidget(node, targetKey) {
    const spacerWidget = node.addWidget("button", `Spacer:${targetKey}`, null, () => {}, { hideInPanel: true });
    spacerWidget.label = " ";
    spacerWidget.serialize = false;
    spacerWidget.disabled = true;
    spacerWidget.computeSize = function () {
        return [0, 16];
    };
    spacerWidget.draw = function () {};
    return spacerWidget;
}

/** Kopfzeile und Blaetterknoepfe. Nur sichtbar, wenn es mehr als eine Seite gibt. */
function addPagerWidgets(node, start, shown, total, page, pageCount) {
    addSpacerWidget(node, "Pager");

    const info = node.addWidget("button", "PageInfo", null, () => {});
    info.label = `Targets ${start + 1}–${start + shown} of ${total}   ·   Page ${page + 1}/${pageCount}`;
    info.serialize = false;
    info.disabled = true;

    const prev = node.addWidget("button", "PagePrev", null, () => {
        node.properties.page = Math.max(0, (Number(node.properties.page) || 0) - 1);
        node.rebuildUI();
        app.graph.setDirtyCanvas(true);
    });
    prev.label = "◀ Prev";
    prev.serialize = false;

    const next = node.addWidget("button", "PageNext", null, () => {
        node.properties.page = (Number(node.properties.page) || 0) + 1;
        node.rebuildUI();
        app.graph.setDirtyCanvas(true);
    });
    next.label = "Next ▶";
    next.serialize = false;
}

/** Hebt den negativen Rand der Nodes-2.0-Huelle fuer genau diese Zeichenflaeche auf. */
function alignVueLegacyCanvas(canvas) {
    const wrapper = canvas.parentElement;
    if (!wrapper) return;
    const left = `${-(parseFloat(getComputedStyle(wrapper).marginLeft) || 0)}px`;
    if (canvas.style.left !== left) canvas.style.left = left;
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
        // Nodes 2.0 zeichnet dieses Widget auf eine eigene Zeichenflaeche, die das Frontend
        // um seinen negativen Rand nach links verschiebt. Sie wird auf die Spalte der
        // uebrigen Buttons zurueckgesetzt und dort ohne den Canvas-Rand gefuellt.
        const vueCanvas = ctx.canvas?.closest?.(".lg-node") ? ctx.canvas : null;
        if (vueCanvas) alignVueLegacyCanvas(vueCanvas);
        const margin = vueCanvas ? 1 : 15;

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

    node.snapshotWidget = node.addWidget(
        "button",
        "Snapshot Outputs",
        null,
        () => snapshotOutputsToController(node)
    );

    node.targetCaptureWidget = node.addWidget(
        "button",
        targetCapturingControllerNode === node ? "Click target nodes..." : "Capture Target",
        null,
        () => {
            if (targetCapturingControllerNode === node) {
                setTargetCaptureNode(null);
                return;
            }

            // Bestand vor diesem Klick eine Mehrfachauswahl, wird sie sofort uebernommen.
            // Eine einzelne markierte Node zaehlt bewusst nicht: sie stammt meistens aus
            // einer frueheren Aktion, und Capture Target trug sie frueher unbemerkt ein.
            // Ohne Mehrfachauswahl startet deshalb der gewohnte Klickmodus.
            const selection = selectionBeforeClick.filter(
                (candidate) => candidate !== node && candidate.graph === node.graph
            );

            if (selection.length > 1) {
                node.graph.beforeChange();
                try {
                    const captured = addTargetsToController(node, selection);
                    console.log(
                        `[Dynamic Node State Controller] Captured ${captured} of ${selection.length} selected nodes.`
                    );
                } finally {
                    node.graph.afterChange();
                }
                return;
            }

            setTargetCaptureNode(node);
        }
    );

    node.updateFromGraphWidget = node.addWidget(
        "button",
        "Update from Graph",
        null,
        () => updateControllerFromGraph(node)
    );
    // Traegt keinen Wert und zaehlt beim Laden nicht mit, siehe Kuerzel.
    node.updateFromGraphWidget.serialize = false;

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

    // Beim Laden verteilt ComfyUI die gespeicherten widgets_values der Reihe nach auf die
    // serialisierten Widgets (namedValuesRestore ist standardmaessig aus). Alte Workflows
    // tragen das Kuerzel an Position 4; es muss deshalb das fuenfte serialisierte Widget
    // bleiben. Ein fremder Wert an dieser Stelle hat am 2026-09-21 schon einmal alle
    // Kuerzel gekostet.
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
    // Wie in addRowWithData: ein neu angelegtes Widget gleichen Namens erhielte sonst den
    // alten gespeicherten Wert, und syncProperties schriebe ihn zurueck.
    node.shortcutWidget.value = node.properties.shortcut || "";

    node.collapseWidget = node.addWidget(
        "button",
        node.properties.collapsed ? "Expand ▼" : "Collapse ▲",
        null,
        () => node.toggleCollapse()
    );
}

function rebuildControllerFromProperties(node) {
    if (!node.properties) node.properties = {};
    if (!Array.isArray(node.properties.rows)) node.properties.rows = [];
    if (node.properties.collapsed === undefined) node.properties.collapsed = true;
    if (node.properties.page === undefined) node.properties.page = 0;
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
        // Erst merken, dann verarbeiten: LiteGraph ersetzt die Auswahl gleich danach.
        rememberSelectionBeforeClick();
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
            // Neue Controller starten eingeklappt. Gespeicherte behalten ihren Zustand, weil
            // onSerialize collapsed immer mitschreibt.
            if (this.properties.collapsed === undefined) this.properties.collapsed = true;
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
                this.properties.collapsed = true;
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

        const originalOnAfterGraphConfigured = nodeType.prototype.onAfterGraphConfigured;

        nodeType.prototype.onAfterGraphConfigured = function () {
            const result = originalOnAfterGraphConfigured
                ? originalOnAfterGraphConfigured.apply(this, arguments)
                : undefined;

            // Laeuft mitten in ComfyUIs Einfuegen, vor dessen afterChange. Ein Fehler darf
            // das Einfuegen nicht abbrechen, sonst bliebe die Undo-Klammer offen.
            try {
                releasePastedCopies(this.graph);
            } catch (error) {
                console.error("[Dynamic Node State Controller] Could not release pasted copies.", error);
            }

            return result;
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

            const pageCount = Math.max(1, Math.ceil(storedRows.length / ROWS_PER_PAGE));
            let page = Number(this.properties.page) || 0;
            page = Math.min(Math.max(0, page), pageCount - 1);
            this.properties.page = page;

            const start = page * ROWS_PER_PAGE;
            const visibleRows = storedRows.slice(start, start + ROWS_PER_PAGE);

            if (storedRows.length > ROWS_PER_PAGE) {
                addPagerWidgets(this, start, visibleRows.length, storedRows.length, page, pageCount);
            }

            for (let data of visibleRows) {
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

            row.spacerWidget = addSpacerWidget(this, row.target_key);

            row.labelWidget = this.addWidget("text", `Target:${row.target_key}`, row.label, (v) => {
                row.label = String(v ?? "").trim();
                this.syncProperties();
            });
            row.labelWidget.label = "Target";
            // ComfyUI merkt sich Widget-Werte je Node und Widget-Name und gibt einem neu
            // angelegten Widget gleichen Namens den alten Wert zurueck. Beim Neuaufbau der
            // Zeilen wuerde syncProperties diesen alten Wert zurueckschreiben. Deshalb den
            // Wert der Zeile nach dem Anlegen ausdruecklich setzen.
            row.labelWidget.value = row.label;

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
            row.actionWidget.value = row.action;

            row.removeWidget = this.addWidget("button", `Remove:${row.target_key}`, null, () => {
                this.widgets = this.widgets.filter(
                    (w) =>
                        w !== row.spacerWidget &&
                        w !== row.labelWidget &&
                        w !== row.actionWidget &&
                        w !== row.removeWidget
                );

                this.rows.splice(this.rows.indexOf(row), 1);

                // Seit der Seitenanzeige mischt syncProperties nur noch ein. Das Loeschen
                // muss deshalb ausdruecklich aus der Gesamtliste entfernen.
                if (Array.isArray(this.properties.rows)) {
                    this.properties.rows = this.properties.rows.filter(
                        (stored) => stored.target_key !== row.target_key
                    );
                }

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

            // Immer die vollstaendige gespeicherte Liste. this.rows enthaelt seit der
            // Seitenanzeige nur die sichtbare Seite; APPLY wuerde damit nur zehn Zeilen
            // anwenden. syncLiveValuesIntoProperties laeuft direkt darueber und hat die
            // sichtbaren Aenderungen bereits eingemischt.
            const actionRows = getStoredRows(this);

            const duplicateTargets = [];

            // Einmal ein Verzeichnis Schluessel -> Nodes bauen, statt je Zeile den
            // ganzen Graphen zu durchsuchen. findNodesByTargetKey ist O(n); in dieser
            // Schleife aufgerufen ergab das O(Zeilen x Nodes) — bei 9600 Zellen rund
            // 92 Millionen Vergleiche je Anwendung, jeder mit String() und trim().
            // Das blockierte den Haupt-Thread des Browsers.
            //
            // Das Verzeichnis fuehrt je Schluessel eine LISTE, damit die Erkennung
            // doppelter Ziele unveraendert funktioniert. Es wird mit derselben Funktion
            // gebaut, die auch die Suche benutzt, also sind die Treffer identisch. Ein
            // Schnappschuss genuegt, weil applyRowAction ausschliesslich node.mode
            // setzt und den Graphen nicht veraendert.
            const nodesByTargetKey = new Map();
            for (const graphNode of app.graph?._nodes ?? []) {
                if (!graphNode || !graphNode.properties) continue;
                const key = getNodeStateControllerKey(graphNode);
                if (!key) continue;
                const bucket = nodesByTargetKey.get(key);
                if (bucket) bucket.push(graphNode);
                else nodesByTargetKey.set(key, [graphNode]);
            }

            for (let row of actionRows) {
                if (!row.target_key) continue;

                const matches = nodesByTargetKey.get(row.target_key) ?? [];

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
