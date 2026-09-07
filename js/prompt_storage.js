import { app } from "../../scripts/app.js";

const ORCHESTRATOR_TYPE = "PromptOrchestrator";
const SAVE_TYPE = "prompt_orchestration/save_string_for_orchestrator";
const ORCHESTRATOR_KEY_PROPERTY = "prompt_orchestrator_key";
const STORAGE_EXPECTED_PROPERTY = "prompt_storage_expected";
const DETECTED_KEY_PROPERTY = "detected_prompt_orchestrator_key";
const ORCHESTRATOR_KEY_WIDGET = "prompt_orchestrator_key";
const DETECTED_KEY_WIDGET = "detected_prompt_orchestrator_key";
const CURATED_WIDGET = "curated_prompts_folder";
const GENERATED_WIDGET = "generated_prompts_folder";
const TARGET_BRANCH_WIDGET = "target_branch";
const CONTENT_INPUT = "content";
const INPUT_SLOT_TYPE = 1;
const SAVED_PROMPT_MESSAGE_UI = "saved_prompt_message";
const KEY_PATTERN = /^po_[0-9a-f]{32}$/;

const orchestratorNumbers = new WeakMap();
let refreshScheduled = false;

const isOrchestrator = (node) => node?.comfyClass === ORCHESTRATOR_TYPE || node?.type === ORCHESTRATOR_TYPE;
const isSaveNode = (node) => node?.comfyClass === SAVE_TYPE || node?.type === SAVE_TYPE;
const getWidget = (node, name) => node?.widgets?.find((widget) => widget.name === name);

const createKey = () => {
    if (globalThis.crypto?.randomUUID) {
        return `po_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `po_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
};

const ensureProperties = (node) => {
    if (!node.properties) node.properties = {};
    return node.properties;
};

const setWidgetValue = (widget, value) => {
    if (!widget) return;
    widget.value = value;
    if (typeof widget.callback === "function") widget.callback(value);
};

const syncVisibleSources = (node) => {
    node.__promptOrchestrationSourcesUi?.sync?.();
};

const mountStorageAction = (node) => {
    const sourcesUi = node.__promptOrchestrationSourcesUi;
    if (!sourcesUi?.addAction) return false;
    if (!node.__promptStorageButton) {
        node.__promptStorageButton = sourcesUi.addAction(
            "Prompt Storage",
            () => runStorageAction(node),
        );
    }
    syncVisibleSources(node);
    return true;
};

const commitGraphEdit = (mutator) => {
    const graph = app.graph;
    graph?.beforeChange?.();
    try {
        mutator();
        app.graph?.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
    } finally {
        graph?.afterChange?.();
    }
};

const notify = (message, kind = "info") => {
    const severity = kind === "error" ? "error" : kind === "success" ? "success" : "info";
    const toast = app.extensionManager?.toast;
    if (toast?.add) {
        toast.add({ severity, summary: "Prompt Storage", detail: message, life: 6000 });
        return;
    }
    if (kind === "error") {
        window.alert(message);
    } else {
        console.info(`[Prompt Storage] ${message}`);
    }
};

const postJson = async (url, body) => {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error(`Prompt Storage request failed (${response.status}).`);
    }
    if (!response.ok) throw new Error(result.error || result.message || `Prompt Storage request failed (${response.status}).`);
    return result;
};

const collectGraphNodes = () => {
    const result = [];
    const seenNodes = new Set();
    const seenGraphs = new Set();

    const visitGraph = (graph) => {
        if (!graph || seenGraphs.has(graph)) return;
        seenGraphs.add(graph);
        const nodes = graph._nodes ?? graph.nodes ?? [];
        for (const node of nodes) {
            if (!seenNodes.has(node)) {
                seenNodes.add(node);
                result.push(node);
            }
            if (node?.subgraph) visitGraph(node.subgraph);
        }
        const subgraphs = graph.subgraphs;
        if (subgraphs?.values) {
            for (const subgraph of subgraphs.values()) visitGraph(subgraph);
        } else if (Array.isArray(subgraphs)) {
            for (const subgraph of subgraphs) visitGraph(subgraph);
        }
    };

    visitGraph(app.graph);
    return result;
};

const currentOrchestratorKey = (node) => {
    const propertyValue = ensureProperties(node)[ORCHESTRATOR_KEY_PROPERTY];
    if (KEY_PATTERN.test(propertyValue ?? "")) return propertyValue;
    const widgetValue = getWidget(node, ORCHESTRATOR_KEY_WIDGET)?.value;
    return KEY_PATTERN.test(widgetValue ?? "") ? widgetValue : "";
};

const currentDetectedKey = (node) => {
    const propertyValue = ensureProperties(node)[DETECTED_KEY_PROPERTY];
    if (KEY_PATTERN.test(propertyValue ?? "")) return propertyValue;
    const widgetValue = getWidget(node, DETECTED_KEY_WIDGET)?.value;
    return KEY_PATTERN.test(widgetValue ?? "") ? widgetValue : "";
};

const normalizedLinkId = (value) => {
    const candidate = value && typeof value === "object" ? value.id : value;
    return candidate === null || candidate === undefined ? null : String(candidate);
};

const currentContentLinkId = (node) => {
    const input = node?.inputs?.find((candidate) => candidate?.name === CONTENT_INPUT);
    return normalizedLinkId(input?.link);
};

const rememberSaveContentLink = (node) => {
    node.__promptStorageDetectedContentLinkId = currentDetectedKey(node)
        ? currentContentLinkId(node)
        : null;
};

const syncOrchestratorIdentity = (node, key, expected) => {
    const properties = ensureProperties(node);
    properties[ORCHESTRATOR_KEY_PROPERTY] = key;
    properties[STORAGE_EXPECTED_PROPERTY] = expected === true;
    setWidgetValue(getWidget(node, ORCHESTRATOR_KEY_WIDGET), key);
};

const syncSaveIdentity = (node, key) => {
    ensureProperties(node)[DETECTED_KEY_PROPERTY] = key;
    setWidgetValue(getWidget(node, DETECTED_KEY_WIDGET), key);
};

const branchLabel = (node) => getWidget(node, TARGET_BRANCH_WIDGET)?.value === "GeneratedPrompts" ? "Generated" : "Curated";

const refreshTitles = () => {
    refreshScheduled = false;
    const nodes = collectGraphNodes();
    const orchestrators = nodes.filter(isOrchestrator);
    orchestrators.forEach((node, index) => orchestratorNumbers.set(node, index + 1));

    for (const node of nodes) {
        if (isOrchestrator(node) || isSaveNode(node)) node.setDirtyCanvas?.(true, true);
    }
};

const scheduleTitleRefresh = () => {
    if (refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(refreshTitles);
};

const installDynamicTitle = (node) => {
    if (node.__promptStorageDynamicTitleInstalled) return;
    node.__promptStorageDynamicTitleInstalled = true;
    const originalGetTitle = node.getTitle;

    node.getTitle = function () {
        if (isOrchestrator(this)) {
            const number = orchestratorNumbers.get(this);
            return number ? `PromptOrchestrator ${number}` : "PromptOrchestrator";
        }
        if (isSaveNode(this)) {
            const key = currentDetectedKey(this);
            if (!key) return "Save String for Orchestrator";
            const matches = collectGraphNodes().filter(
                (candidate) => isOrchestrator(candidate) && currentOrchestratorKey(candidate) === key,
            );
            if (matches.length !== 1) return `Save ${branchLabel(this)} — Detect required`;
            const number = orchestratorNumbers.get(matches[0]);
            return number
                ? `Save ${branchLabel(this)} — Orchestrator ${number}`
                : `Save ${branchLabel(this)} — Detect required`;
        }
        return originalGetTitle ? originalGetTitle.apply(this, arguments) : this.title;
    };
};

const wrapRemoval = (node) => {
    if (node.__promptStorageRemovalWrapped) return;
    node.__promptStorageRemovalWrapped = true;
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        if (originalOnRemoved) originalOnRemoved.apply(this, arguments);
        scheduleTitleRefresh();
    };
};

const looksLikePromptStoragePath = (value) => String(value ?? "").replaceAll("\\", "/").includes("/PromptStorage/");

const syncRecoveredPaths = (node, status) => {
    if (status.state !== "existing" || ensureProperties(node)[STORAGE_EXPECTED_PROPERTY] !== true) return;
    const curatedWidget = getWidget(node, CURATED_WIDGET);
    const generatedWidget = getWidget(node, GENERATED_WIDGET);
    const currentCurated = String(curatedWidget?.value ?? "");
    const currentGenerated = String(generatedWidget?.value ?? "");
    const shouldUpdateCurated = !currentCurated || looksLikePromptStoragePath(currentCurated);
    const shouldUpdateGenerated = !currentGenerated || looksLikePromptStoragePath(currentGenerated);
    if (!shouldUpdateCurated && !shouldUpdateGenerated) return;

    commitGraphEdit(() => {
        if (shouldUpdateCurated) setWidgetValue(curatedWidget, status.curated_prompts_folder);
        if (shouldUpdateGenerated) setWidgetValue(generatedWidget, status.generated_prompts_folder);
        syncVisibleSources(node);
    });
};

const checkStorageStatus = async (node) => {
    const key = currentOrchestratorKey(node);
    if (!key) return null;
    const status = await postJson("/prompt_orchestration/storage/status", {
        prompt_orchestrator_key: key,
        expected: ensureProperties(node)[STORAGE_EXPECTED_PROPERTY] === true,
    });
    syncRecoveredPaths(node, status);
    node.__promptStorageState = status.state;
    if (status.state === "missing") {
        if (node.__promptStorageMissingNotifiedKey !== key) {
            node.__promptStorageMissingNotifiedKey = key;
            notify(
                "The Prompt Storage linked to this PromptOrchestrator was not found. Stored prompts are unavailable. Open Prompt Testing → Sources and click Prompt Storage to create an empty replacement.",
                "error",
            );
        }
    } else {
        node.__promptStorageMissingNotifiedKey = null;
    }
    scheduleTitleRefresh();
    return status;
};

const confirmSourceReplacement = (node, message) => {
    const curated = String(getWidget(node, CURATED_WIDGET)?.value ?? "").trim();
    const generated = String(getWidget(node, GENERATED_WIDGET)?.value ?? "").trim();
    if (!curated && !generated) return true;
    return window.confirm(`${message}\n\nThe current Curated and Generated source values will be replaced.`);
};

const applyStorageResult = (node, result) => {
    commitGraphEdit(() => {
        syncOrchestratorIdentity(node, result.prompt_orchestrator_key, true);
        setWidgetValue(getWidget(node, CURATED_WIDGET), result.curated_prompts_folder);
        setWidgetValue(getWidget(node, GENERATED_WIDGET), result.generated_prompts_folder);
        syncVisibleSources(node);
    });
    node.__promptStorageState = "existing";
    scheduleTitleRefresh();
};

const runStorageAction = async (node) => {
    try {
        let key = currentOrchestratorKey(node);
        if (!key) {
            key = createKey();
            commitGraphEdit(() => syncOrchestratorIdentity(node, key, false));
        }

        const expected = ensureProperties(node)[STORAGE_EXPECTED_PROPERTY] === true;
        const status = await postJson("/prompt_orchestration/storage/status", {
            prompt_orchestrator_key: key,
            expected,
        });

        let action = "initialize";
        if (status.state === "existing") {
            const confirmed = window.confirm(
                "This PromptOrchestrator already has a storage.\n\nCreate a new independent storage?\n\nThe existing storage will remain unchanged. The current Curated and Generated source values will be replaced, and connected Save nodes must use Detect Orchestrator again.",
            );
            if (!confirmed) return;
            action = "independent";
        } else if (status.state === "duplicate" || status.state === "invalid") {
            const confirmed = window.confirm(
                `${status.message}\n\nCreate a new independent storage with a new key?\n\nExisting storage directories will remain unchanged. The current Curated and Generated source values will be replaced.`,
            );
            if (!confirmed) return;
            action = "independent";
        } else {
            const message = status.state === "missing"
                ? "The previous PromptStorage was not found. Recreate an empty storage with the same key?"
                : "Initialize Prompt Storage?";
            if (!confirmSourceReplacement(node, message)) return;
        }

        const result = await postJson("/prompt_orchestration/storage/action", {
            action,
            prompt_orchestrator_key: key,
            expected,
        });
        applyStorageResult(node, result);
        notify(result.message, "success");
    } catch (error) {
        console.error("[Prompt Storage] Storage action failed:", error);
        notify(error.message || String(error), "error");
    }
};

const outputNodeById = (output, nodeId) => output?.[String(nodeId)] ?? output?.[nodeId];

const linkedNodeId = (value, output) => {
    if (!Array.isArray(value) || value.length !== 2 || !Number.isInteger(value[1])) return null;
    return outputNodeById(output, value[0]) ? value[0] : null;
};

const reachableOrchestratorIds = (output, saveId) => {
    const save = outputNodeById(output, saveId);
    const contentSource = linkedNodeId(save?.inputs?.[CONTENT_INPUT], output);
    if (contentSource === null) return [];

    const pending = [contentSource];
    const visited = new Set();
    const matches = new Set();
    while (pending.length) {
        const nodeId = pending.pop();
        const normalizedId = String(nodeId);
        if (visited.has(normalizedId)) continue;
        visited.add(normalizedId);
        const current = outputNodeById(output, nodeId);
        if (!current) continue;
        if (current.class_type === ORCHESTRATOR_TYPE) {
            matches.add(normalizedId);
            continue;
        }
        for (const value of Object.values(current.inputs ?? {})) {
            const upstreamId = linkedNodeId(value, output);
            if (upstreamId !== null) pending.push(upstreamId);
        }
    }
    return [...matches];
};

const detectOrchestrator = async (node) => {
    const technicalWidget = getWidget(node, DETECTED_KEY_WIDGET);
    if (!technicalWidget) {
        notify("The Save node technical identity input is missing.", "error");
        return;
    }

    const previousValue = technicalWidget.value;
    const marker = `detect_${createKey().slice(3)}`;
    let graphPrompt;
    try {
        node.__promptStorageDetectionMarker = marker;
        technicalWidget.value = marker;
        graphPrompt = await app.graphToPrompt();
    } catch (error) {
        console.error("[Prompt Storage] Graph inspection failed:", error);
        notify("The current graph could not be inspected.", "error");
        return;
    } finally {
        delete node.__promptStorageDetectionMarker;
        technicalWidget.value = previousValue;
    }

    const output = graphPrompt?.output ?? {};
    const saveIds = Object.entries(output)
        .filter(([, current]) => current?.class_type === SAVE_TYPE && current?.inputs?.[DETECTED_KEY_WIDGET] === marker)
        .map(([nodeId]) => nodeId);

    if (saveIds.length !== 1) {
        notify("The current Save node could not be identified in the execution graph.", "error");
        return;
    }

    const orchestratorIds = reachableOrchestratorIds(output, saveIds[0]);
    if (orchestratorIds.length === 0) {
        notify("No PromptOrchestrator detected from the current content input.", "error");
        return;
    }
    if (orchestratorIds.length > 1) {
        notify("Multiple PromptOrchestrators detected from the current content input.", "error");
        return;
    }

    const orchestrator = outputNodeById(output, orchestratorIds[0]);
    const key = orchestrator?.inputs?.[ORCHESTRATOR_KEY_WIDGET];
    if (!KEY_PATTERN.test(key ?? "")) {
        notify("The detected PromptOrchestrator has no valid stable key.", "error");
        return;
    }

    commitGraphEdit(() => {
        syncSaveIdentity(node, key);
        rememberSaveContentLink(node);
    });
    scheduleTitleRefresh();

    try {
        const status = await postJson("/prompt_orchestration/storage/status", {
            prompt_orchestrator_key: key,
            expected: false,
        });
        if (status.state === "existing") {
            notify("Orchestrator detected — Storage ready", "success");
        } else if (status.state === "duplicate") {
            notify("Orchestrator detected — Duplicate storage identity", "error");
        } else {
            notify("Orchestrator detected — Storage not initialized");
        }
    } catch (error) {
        notify(`Orchestrator detected — ${error.message || String(error)}`, "error");
    }
};

const hideTechnicalWidget = (widget) => {
    if (!widget) return;
    widget.hidden = true;
    widget.options ??= {};
    widget.options.hidden = true;
    widget.serialize = false;
};

const installSaveExecutedBridge = (node) => {
    if (node.__promptStorageExecutedBridgeInstalled) return;
    node.__promptStorageExecutedBridgeInstalled = true;
    const originalOnExecuted = node.onExecuted;

    node.onExecuted = function (message) {
        const originalResult = originalOnExecuted?.apply(this, arguments);
        const payloads = Array.isArray(message?.[SAVED_PROMPT_MESSAGE_UI])
            ? message[SAVED_PROMPT_MESSAGE_UI]
            : [];

        for (const payload of payloads) {
            const key = payload?.prompt_orchestrator_key;
            const content = payload?.content;
            const savedPath = payload?.saved_path;

            if (!KEY_PATTERN.test(key ?? "") || typeof content !== "string" || typeof savedPath !== "string" || savedPath.length === 0) {
                notify("The prompt was saved, but its chat payload was invalid. The chat was not updated.", "error");
                continue;
            }
            const matches = collectGraphNodes().filter(
                (candidate) => isOrchestrator(candidate) && currentOrchestratorKey(candidate) === key,
            );
            if (matches.length !== 1) {
                const reason = matches.length === 0
                    ? "the matching PromptOrchestrator is not available"
                    : "the PromptOrchestrator key is duplicated";
                notify(`The prompt was saved, but ${reason}. The chat was not updated.`, "error");
                continue;
            }

            const appendGeneratedMessage = matches[0].__promptOrchestrationGeneratedUi?.appendGeneratedMessage;
            if (typeof appendGeneratedMessage !== "function") {
                notify("The prompt was saved, but the Prompt Generation chat is not available. The chat was not updated.", "error");
                continue;
            }

            try {
                if (appendGeneratedMessage.call(matches[0].__promptOrchestrationGeneratedUi, content) === true) {
                    continue;
                } else {
                    notify("The prompt was saved, but the chat rejected its content. The chat was not updated.", "error");
                }
            } catch (error) {
                console.error("[Prompt Storage] Chat update failed:", error);
                notify("The prompt was saved, but the chat update failed. The chat was not updated.", "error");
            }
        }

        return originalResult;
    };
};

const installSerializationSync = (node, kind) => {
    if (node.__promptStorageSerializationWrapped) return;
    node.__promptStorageSerializationWrapped = true;
    const originalOnSerialize = node.onSerialize;
    node.onSerialize = function (info) {
        if (kind === "orchestrator") {
            const key = currentOrchestratorKey(this) || createKey();
            syncOrchestratorIdentity(this, key, ensureProperties(this)[STORAGE_EXPECTED_PROPERTY] === true);
        } else if (this.__promptStorageDetectionMarker) {
            setWidgetValue(
                getWidget(this, DETECTED_KEY_WIDGET),
                this.__promptStorageDetectionMarker,
            );
        } else {
            syncSaveIdentity(this, currentDetectedKey(this));
        }
        if (originalOnSerialize) originalOnSerialize.apply(this, arguments);
    };
};

const installOrchestrator = (node) => {
    if (node.__promptStorageInstalled) return;
    node.__promptStorageInstalled = true;
    node.__promptStorageCreatedDuringGraphLoad = app.configuringGraph === true;

    hideTechnicalWidget(getWidget(node, ORCHESTRATOR_KEY_WIDGET));
    installDynamicTitle(node);
    installSerializationSync(node, "orchestrator");
    wrapRemoval(node);

    const properties = ensureProperties(node);
    const key = currentOrchestratorKey(node) || createKey();
    syncOrchestratorIdentity(node, key, properties[STORAGE_EXPECTED_PROPERTY] === true);

    node.__promptStorageMountSourcesAction = () => mountStorageAction(node);
    if (!mountStorageAction(node)) queueMicrotask(node.__promptStorageMountSourcesAction);
    scheduleTitleRefresh();
};

const clearSaveOnContentRewire = (node, type, index, connected, linkInfo) => {
    if (app.configuringGraph === true) return;
    if (type !== INPUT_SLOT_TYPE) return;
    const input = node.inputs?.[index];
    if (input?.name !== CONTENT_INPUT) return;
    if (!currentDetectedKey(node)) return;

    const rememberedLinkId = node.__promptStorageDetectedContentLinkId ?? null;
    const currentLinkId = currentContentLinkId(node);
    const eventLinkId = normalizedLinkId(linkInfo);
    const isSameConnectionRefresh = connected === true
        && rememberedLinkId !== null
        && currentLinkId === rememberedLinkId
        && (eventLinkId === null || eventLinkId === rememberedLinkId);
    if (isSameConnectionRefresh) return;

    syncSaveIdentity(node, "");
    node.__promptStorageDetectedContentLinkId = null;
    node.setDirtyCanvas?.(true, true);
    scheduleTitleRefresh();
};

const installSaveNode = (node) => {
    if (node.__promptStorageInstalled) return;
    node.__promptStorageInstalled = true;
    node.__promptStorageCreatedDuringGraphLoad = app.configuringGraph === true;

    hideTechnicalWidget(getWidget(node, DETECTED_KEY_WIDGET));
    installSaveExecutedBridge(node);
    installDynamicTitle(node);
    installSerializationSync(node, "save");
    wrapRemoval(node);

    syncSaveIdentity(node, currentDetectedKey(node));
    rememberSaveContentLink(node);
    const detectButton = node.addWidget("button", "Detect Orchestrator", "", () => detectOrchestrator(node));
    detectButton.serialize = false;
    detectButton.options ??= {};
    detectButton.options.serialize = false;

    const targetWidget = getWidget(node, TARGET_BRANCH_WIDGET);
    if (targetWidget && !targetWidget.__promptStorageCallbackWrapped) {
        targetWidget.__promptStorageCallbackWrapped = true;
        const originalCallback = targetWidget.callback;
        targetWidget.callback = function () {
            if (originalCallback) originalCallback.apply(this, arguments);
            scheduleTitleRefresh();
        };
    }

    const originalOnConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (type, index, connected, linkInfo) {
        if (originalOnConnectionsChange) originalOnConnectionsChange.apply(this, arguments);
        clearSaveOnContentRewire(this, type, index, connected, linkInfo);
    };
    scheduleTitleRefresh();
};

const handleLoadedNode = (node) => {
    if (isOrchestrator(node)) {
        installOrchestrator(node);
        if (app.configuringGraph !== true && node.__promptStorageCreatedDuringGraphLoad !== true) {
            commitGraphEdit(() => syncOrchestratorIdentity(node, createKey(), false));
        } else {
            const key = currentOrchestratorKey(node) || createKey();
            syncOrchestratorIdentity(node, key, ensureProperties(node)[STORAGE_EXPECTED_PROPERTY] === true);
            queueMicrotask(() => checkStorageStatus(node).catch((error) => console.warn("[Prompt Storage] Status check failed:", error)));
        }
    } else if (isSaveNode(node)) {
        installSaveNode(node);
        if (app.configuringGraph !== true && node.__promptStorageCreatedDuringGraphLoad !== true) {
            commitGraphEdit(() => syncSaveIdentity(node, ""));
        } else {
            syncSaveIdentity(node, currentDetectedKey(node));
        }
        rememberSaveContentLink(node);
    }
    scheduleTitleRefresh();
};

app.registerExtension({
    name: "prompt_orchestration.prompt_storage",

    setup() {
        document.addEventListener("litegraph:canvas", (event) => {
            if (event.detail?.subType === "after-change") scheduleTitleRefresh();
        });
    },

    nodeCreated(node) {
        if (isOrchestrator(node)) installOrchestrator(node);
        else if (isSaveNode(node)) installSaveNode(node);
    },

    loadedGraphNode(node) {
        handleLoadedNode(node);
    },

    afterConfigureGraph() {
        scheduleTitleRefresh();
        for (const node of collectGraphNodes().filter(isOrchestrator)) {
            checkStorageStatus(node).catch((error) => console.warn("[Prompt Storage] Status check failed:", error));
        }
    },
});
