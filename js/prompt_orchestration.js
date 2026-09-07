import { app } from "../../scripts/app.js";

const NODE_TYPE = "PromptOrchestrator";
const STATE_PROPERTY = "prompt_orchestration_ui";
const STATE_VERSION = 3;
const TAB_TESTING = "prompt_testing";
const TAB_GENERATION = "prompt_generation";
const TAB_SYSTEM = "system_prompt";
const VALID_TABS = new Set([TAB_TESTING, TAB_GENERATION, TAB_SYSTEM]);
const PROMPT_FORMAT_POSITIVE_ONLY = "Positive only";
const PROMPT_FORMAT_POSITIVE_NEGATIVE = "Positive + Negative";
const VALID_PROMPT_FORMATS = new Set([
    PROMPT_FORMAT_POSITIVE_ONLY,
    PROMPT_FORMAT_POSITIVE_NEGATIVE,
]);

app.registerExtension({
    name: "prompt_orchestration",

    registerCustomNodes() {
        const nodeType = LiteGraph.registered_node_types[NODE_TYPE];
        if (!nodeType) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            if (originalOnNodeCreated) {
                originalOnNodeCreated.apply(this, arguments);
            }

            if (this.__promptOrchestrationUiInitialized) return;
            this.__promptOrchestrationUiInitialized = true;

            const node = this;
            let configuredFromWorkflow = false;
            let state = null;
            let openGraphEditCount = 0;

            const getWidget = (name) => node.widgets.find((widget) => widget.name === name);

            const curatedPromptsFolderWidget = getWidget("curated_prompts_folder");
            const generatedPromptsFolderWidget = getWidget("generated_prompts_folder");
            const multiPromptTestingEditorWidget = getWidget("multi_prompt_testing_editor");
            const promptGenerationEditorWidget = getWidget("prompt_generation_editor");
            const usePromptGenerationBranchWidget = getWidget("use_prompt_generation_branch");
            const systemPromptWidget = getWidget("system_prompt");
            const promptTestingFormatWidget = getWidget("prompt_testing_format");

            const requiredWidgets = [
                curatedPromptsFolderWidget,
                generatedPromptsFolderWidget,
                multiPromptTestingEditorWidget,
                promptGenerationEditorWidget,
                usePromptGenerationBranchWidget,
                systemPromptWidget,
                promptTestingFormatWidget,
            ];

            if (requiredWidgets.some((widget) => !widget)) {
                console.error("[PromptOrchestrator] Required technical widgets are missing.");
                return;
            }

            const beginGraphEdit = () => {
                if (openGraphEditCount === 0) {
                    app.graph.beforeChange();
                }
                openGraphEditCount += 1;
            };

            const endGraphEdit = () => {
                if (openGraphEditCount <= 0) return;
                openGraphEditCount -= 1;
                if (openGraphEditCount === 0) {
                    app.graph.afterChange();
                }
            };

            const commitGraphEdit = (mutator) => {
                beginGraphEdit();
                try {
                    mutator();
                    node.setDirtyCanvas(true, true);
                } finally {
                    endGraphEdit();
                }
            };

            const normalizeState = (candidate) => {
                const contexts = Array.isArray(candidate?.contexts)
                    ? candidate.contexts.filter((value) => typeof value === "string")
                    : [];
                const fallbackTab = Boolean(usePromptGenerationBranchWidget.value)
                    ? TAB_GENERATION
                    : TAB_TESTING;

                let activeContextIndex = Number.isInteger(candidate?.activeContextIndex)
                    ? candidate.activeContextIndex
                    : contexts.length - 1;

                if (contexts.length === 0) {
                    activeContextIndex = -1;
                } else {
                    activeContextIndex = Math.max(0, Math.min(activeContextIndex, contexts.length - 1));
                }

                const hasLegacyStateVersion = candidate?.version === 2 || candidate?.version == null;
                if (hasLegacyStateVersion && typeof candidate?.instruction === "string") {
                    const legacyContext = activeContextIndex >= 0 ? contexts[activeContextIndex] ?? "" : "";
                    const legacyCompiledValue = [legacyContext, candidate.instruction]
                        .filter((value) => value.trim().length > 0)
                        .join("\n\n");

                    if (activeContextIndex >= 0) {
                        contexts[activeContextIndex] = legacyCompiledValue;
                    } else if (legacyCompiledValue.length > 0) {
                        contexts.push(legacyCompiledValue);
                        activeContextIndex = 0;
                    }
                }

                return {
                    version: STATE_VERSION,
                    contexts,
                    activeContextIndex,
                    activeTab: VALID_TABS.has(candidate?.activeTab) ? candidate.activeTab : fallbackTab,
                };
            };

            const createLegacyState = () => {
                const legacyContext = String(promptGenerationEditorWidget.value ?? "");
                return normalizeState({
                    contexts: legacyContext ? [legacyContext] : [],
                    activeContextIndex: legacyContext ? 0 : -1,
                });
            };

            const saveState = () => {
                if (!state) return;
                if (!node.properties) node.properties = {};
                node.properties[STATE_PROPERTY] = {
                    version: STATE_VERSION,
                    contexts: [...state.contexts],
                    activeContextIndex: state.activeContextIndex,
                    activeTab: state.activeTab,
                };
            };

            const activeContext = () => {
                if (!state || state.activeContextIndex < 0) return "";
                return state.contexts[state.activeContextIndex] ?? "";
            };

            const compileGenerationValue = () => activeContext();

            const syncGenerationWidget = () => {
                promptGenerationEditorWidget.value = compileGenerationValue();
                saveState();
            };

            const setWidgetValue = (widget, value) => {
                widget.value = value;
                if (typeof widget.callback === "function") {
                    widget.callback(value);
                }
            };

            const createElement = (tag, className, text) => {
                const element = document.createElement(tag);
                if (className) element.className = className;
                if (text !== undefined) element.textContent = text;
                return element;
            };

            const createButton = (label, className, onClick) => {
                const button = createElement("button", className, label);
                button.type = "button";
                button.addEventListener("click", onClick);
                return button;
            };

            const createIconButton = (label, extraClassName, pathData, onClick) => {
                const className = `po-button po-button--ghost po-icon-button${extraClassName ? ` ${extraClassName}` : ""}`;
                const button = createButton("", className, onClick);
                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

                svg.setAttribute("viewBox", "0 0 24 24");
                svg.setAttribute("aria-hidden", "true");
                path.setAttribute("d", pathData);
                svg.appendChild(path);
                button.appendChild(svg);
                button.title = label;
                button.setAttribute("aria-label", label);
                return button;
            };

            const copyTextToClipboard = async (value) => {
                const text = String(value ?? "");

                if (navigator.clipboard?.writeText) {
                    try {
                        await navigator.clipboard.writeText(text);
                        return;
                    } catch (error) {
                        console.warn("[PromptOrchestrator] Clipboard API unavailable, using fallback.", error);
                    }
                }

                const fallback = createElement("textarea");
                fallback.value = text;
                fallback.setAttribute("readonly", "");
                fallback.style.position = "fixed";
                fallback.style.opacity = "0";
                fallback.style.pointerEvents = "none";
                document.body.appendChild(fallback);
                fallback.select();

                const copied = document.execCommand("copy");
                fallback.remove();
                if (!copied) throw new Error("Clipboard copy failed.");
            };

            const root = createElement("div", "po-app");
            const style = document.createElement("style");
            style.textContent = `
                .po-app {
                    --po-bg: var(--node-component-surface, var(--bg-color, #202020));
                    --po-surface: var(--comfy-input-bg, #222);
                    --po-surface-raised: var(--button-surface, var(--comfy-menu-secondary-bg, #303030));
                    --po-surface-hover: var(--button-hover-surface, #3a3a3a);
                    --po-surface-selected: var(--button-active-surface, var(--secondary-background-selected, #414141));
                    --po-border: var(--node-component-border, var(--border-color, #4e4e4e));
                    --po-border-soft: var(--border-subtle, var(--border-color, #3f3f3f));
                    --po-text: var(--input-text, var(--fg-color, #ddd));
                    --po-muted: var(--descrip-text, var(--text-secondary, #aaa));
                    --po-accent: var(--node-component-border-selected, var(--accent-primary, #ddd));
                    --po-danger: var(--error-text, #d88);
                    width: 100%;
                    height: 100%;
                    min-width: 0;
                    min-height: 520px;
                    box-sizing: border-box;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    padding: 12px;
                    overflow: hidden;
                    border: 1px solid var(--po-border-soft);
                    border-radius: 6px;
                    background: var(--po-bg);
                    color: var(--po-text);
                    font: 12px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                }
                .po-app *, .po-app *::before, .po-app *::after { box-sizing: border-box; }
                .po-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); min-width: 0; gap: 3px; padding: 3px; border: 1px solid var(--po-border); border-radius: 5px; background: var(--po-surface); }
                .po-tab { min-height: 32px; padding: 5px 7px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--po-muted); font: inherit; font-weight: 600; cursor: pointer; transition: background 100ms ease, border-color 100ms ease, color 100ms ease; }
                .po-tab:hover { color: var(--po-text); background: var(--po-surface-hover); }
                .po-tab[aria-selected="true"] { color: var(--po-text); border-color: var(--po-border); background: var(--po-surface-selected); box-shadow: inset 0 -2px 0 var(--po-accent); }
                .po-button { min-height: 30px; padding: 6px 10px; border: 1px solid var(--po-border); border-radius: 4px; background: var(--po-surface-raised); color: var(--po-text); font: inherit; font-weight: 600; cursor: pointer; }
                .po-button:hover { border-color: var(--po-accent); background: var(--po-surface-hover); }
                .po-button:disabled { opacity: 0.45; cursor: default; pointer-events: none; }
                .po-button--primary { border-color: var(--po-accent); background: var(--po-surface-selected); color: var(--po-text); }
                .po-button--primary:hover { background: var(--po-surface-hover); }
                .po-button--ghost { min-height: 24px; padding: 2px 7px; border-color: transparent; background: transparent; color: var(--po-muted); font-size: 11px; }
                .po-button--ghost:hover { color: var(--po-text); border-color: var(--po-border); background: var(--po-surface-raised); }
                .po-icon-button { display: inline-grid; place-items: center; width: 26px; min-width: 26px; min-height: 24px; padding: 4px; }
                .po-icon-button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
                .po-icon-button--danger:hover { color: var(--po-danger); border-color: var(--po-danger); }
                .po-button:focus-visible, .po-tab:focus-visible, .po-input:focus-visible, .po-textarea:focus-visible, .po-select:focus-visible, .po-summary:focus-visible { outline: 2px solid var(--po-accent); outline-offset: 2px; }
                .po-panel { flex: 0 0 auto; min-width: 0; border: 1px solid var(--po-border); border-radius: 4px; background: var(--po-surface); overflow: hidden; }
                .po-summary { display: flex; align-items: center; min-height: 34px; padding: 7px 10px; color: var(--po-muted); cursor: pointer; font-weight: 650; user-select: none; }
                .po-summary:hover { color: var(--po-text); background: var(--po-surface-raised); }
                .po-details-body { display: grid; gap: 8px; padding: 0 10px 10px; }
                .po-source-grid { grid-template-columns: 1fr; }
                .po-source-actions .po-button { width: 100%; }
                .po-field { display: grid; gap: 5px; min-width: 0; }
                .po-label { color: var(--po-muted); font-size: 11px; font-weight: 650; letter-spacing: 0.02em; }
                .po-input, .po-textarea, .po-select { width: 100%; border: 1px solid var(--po-border); border-radius: 4px; background: var(--po-surface); color: var(--po-text); font: inherit; resize: vertical; }
                .po-input { min-height: 31px; padding: 6px 8px; }
                .po-textarea { min-height: 90px; padding: 9px 10px; line-height: 1.5; }
                .po-textarea::placeholder, .po-input::placeholder { color: var(--po-muted); }
                .po-main { flex: 1 1 0; min-width: 0; min-height: 0; display: flex; overflow: hidden; }
                .po-view { flex: 1 1 0; width: 100%; height: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 9px; overflow: hidden; }
                .po-view[hidden] { display: none; }
                .po-view--multi { gap: 6px; overflow-y: auto; overflow-x: hidden; padding-right: 3px; }
                .po-actions { display: flex; flex-wrap: wrap; gap: 7px; }
                .po-actions .po-button--primary { margin-left: auto; }
                .po-format-control { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 7px; border: 1px solid var(--po-border); border-radius: 4px; background: var(--po-surface-raised); color: var(--po-muted); font-size: 11px; font-weight: 600; }
                .po-format-select { width: auto; min-width: 110px; min-height: 24px; padding: 2px 22px 2px 5px; border: 0; background: var(--po-surface); color: var(--po-text); resize: none; }
                .po-numbered-editor { position: relative; flex: 1 1 auto; min-height: 180px; border: 1px solid var(--po-border); border-radius: 4px; background: var(--po-surface); overflow: hidden; }
                .po-numbered-editor:focus-within { outline: 2px solid var(--po-accent); outline-offset: 2px; }
                .po-numbered-editor .po-multi-editor { position: relative; z-index: 1; width: 100%; height: 100%; min-height: 180px; padding: 9px 10px 9px 50px; border: 0; border-radius: 0; background: transparent; resize: none; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; tab-size: 4; }
                .po-numbered-editor .po-multi-editor:focus-visible { outline: 0; }
                .po-testing-line-map { position: absolute; z-index: 2; top: 0; bottom: 0; left: 0; overflow: hidden; pointer-events: none; user-select: none; }
                .po-testing-line-map-content { position: relative; width: 100%; }
                .po-testing-line-row { position: relative; display: block; width: 100%; min-height: 1.5em; color: transparent; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; tab-size: 4; }
                .po-testing-line-row::before { content: attr(data-line-number); position: absolute; left: 10px; width: 30px; color: var(--po-muted); text-align: right; font-weight: 500; opacity: 0.72; }
                .po-history { flex: 1 1 0; width: 100%; height: 0; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: scroll; display: flex; flex-direction: column; gap: 12px; padding: 10px; border: 1px solid var(--po-border); border-radius: 4px; background: var(--po-surface); scrollbar-color: var(--po-muted) var(--po-bg); scrollbar-gutter: stable; }
                .po-history::-webkit-scrollbar { width: 10px; }
                .po-history::-webkit-scrollbar-track { background: var(--po-bg); border-radius: 4px; }
                .po-history::-webkit-scrollbar-thumb { border: 2px solid var(--po-bg); border-radius: 4px; background: var(--po-muted); }
                .po-message { position: relative; flex: 0 0 auto; width: calc(100% - 4px); min-width: 0; align-self: flex-start; border: 1px solid var(--po-border-soft); border-radius: 4px; background: var(--po-bg); overflow: hidden; }
                .po-message--active { border-color: var(--po-accent); box-shadow: inset 2px 0 0 var(--po-accent); background: var(--po-surface-raised); }
                .po-message-actions { display: flex; justify-content: flex-end; gap: 3px; min-height: 28px; padding: 4px 6px 0; }
                .po-message-editor { min-height: 110px; max-height: 280px; border: 0; border-radius: 0; background: transparent; resize: vertical; }
                .po-message--latest .po-message-editor { min-height: 220px; }
                .po-message--empty .po-message-editor { min-height: 130px; }
                .po-status { min-height: 16px; color: var(--po-muted); font-size: 11px; }
                .po-status:empty { display: none; }
                .po-status[data-kind="error"] { color: var(--po-danger); }
                .po-system-field { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
                .po-system-text { flex: 1 1 0; min-height: 180px; max-height: none; resize: none; }
            `;
            root.appendChild(style);

            const tabs = createElement("div", "po-tabs");
            const testingTabButton = createButton("Prompt Testing", "po-tab", () => {
                commitGraphEdit(() => {
                    if (!state) state = createLegacyState();
                    state.activeTab = TAB_TESTING;
                    setWidgetValue(usePromptGenerationBranchWidget, false);
                    saveState();
                    renderTabs();
                });
            });
            const generationTabButton = createButton("Prompt Generation", "po-tab", () => {
                commitGraphEdit(() => {
                    if (!state) state = createLegacyState();
                    state.activeTab = TAB_GENERATION;
                    setWidgetValue(usePromptGenerationBranchWidget, true);
                    saveState();
                    renderTabs();
                });
            });
            const systemTabButton = createButton("System Prompt", "po-tab", () => {
                commitGraphEdit(() => {
                    if (!state) state = createLegacyState();
                    state.activeTab = TAB_SYSTEM;
                    saveState();
                    renderTabs();
                });
            });
            testingTabButton.setAttribute("role", "tab");
            generationTabButton.setAttribute("role", "tab");
            systemTabButton.setAttribute("role", "tab");
            tabs.setAttribute("role", "tablist");
            tabs.append(testingTabButton, generationTabButton, systemTabButton);
            root.appendChild(tabs);

            const sourcesPanel = createElement("details", "po-panel");
            const sourcesSummary = createElement("summary", "po-summary", "Sources");
            const sourcesBody = createElement("div", "po-details-body po-source-grid");
            const curatedSourceField = createElement("label", "po-field");
            const curatedSourceLabel = createElement("span", "po-label", "Curated prompts folder");
            const curatedSourceInput = createElement("input", "po-input");
            curatedSourceInput.type = "text";
            const generatedSourceField = createElement("label", "po-field");
            const generatedSourceLabel = createElement("span", "po-label", "Generated prompts folder");
            const generatedSourceInput = createElement("input", "po-input");
            generatedSourceInput.type = "text";
            const sourceActions = createElement("div", "po-actions po-source-actions");
            curatedSourceField.append(curatedSourceLabel, curatedSourceInput);
            generatedSourceField.append(generatedSourceLabel, generatedSourceInput);
            sourcesBody.append(curatedSourceField, generatedSourceField, sourceActions);
            sourcesPanel.append(sourcesSummary, sourcesBody);

            node.__promptOrchestrationSourcesUi = {
                addAction(label, onClick) {
                    const button = createButton(label, "po-button", onClick);
                    sourceActions.appendChild(button);
                    return button;
                },
                sync() {
                    curatedSourceInput.value = String(curatedPromptsFolderWidget.value ?? "");
                    generatedSourceInput.value = String(generatedPromptsFolderWidget.value ?? "");
                },
            };
            node.__promptStorageMountSourcesAction?.();

            const main = createElement("div", "po-main");
            const multiView = createElement("section", "po-view po-view--multi");
            const multiActions = createElement("div", "po-actions");
            const status = createElement("div", "po-status");
            status.setAttribute("role", "status");
            const numberedEditor = createElement("div", "po-numbered-editor");
            const multiEditor = createElement("textarea", "po-textarea po-multi-editor");
            const testingLineMap = createElement("div", "po-testing-line-map");
            const testingLineMapContent = createElement("div", "po-testing-line-map-content");
            testingLineMap.setAttribute("aria-hidden", "true");
            testingLineMap.appendChild(testingLineMapContent);
            numberedEditor.append(multiEditor, testingLineMap);

            const promptFormatControl = createElement("label", "po-format-control");
            const promptFormatLabel = createElement("span", "", "Prompt format");
            const promptFormatSelect = createElement("select", "po-select po-format-select");
            for (const value of [PROMPT_FORMAT_POSITIVE_ONLY, PROMPT_FORMAT_POSITIVE_NEGATIVE]) {
                const option = createElement("option", "", value);
                option.value = value;
                promptFormatSelect.appendChild(option);
            }
            promptFormatSelect.setAttribute("aria-label", "Prompt format");
            promptFormatControl.append(promptFormatLabel, promptFormatSelect);

            const generationView = createElement("section", "po-view");
            const history = createElement("div", "po-history");
            generationView.append(history);

            const systemView = createElement("section", "po-view");
            const systemField = createElement("div", "po-system-field");
            const systemInput = createElement("textarea", "po-textarea po-system-text");
            systemInput.placeholder = "Optional system prompt";
            systemInput.setAttribute("aria-label", "System Prompt");
            systemField.appendChild(systemInput);
            systemView.appendChild(systemField);

            main.append(multiView, generationView, systemView);
            root.appendChild(main);

            const setStatus = (message, kind = "info") => {
                status.textContent = message;
                status.dataset.kind = kind;
            };

            const currentPromptTestingFormat = () => VALID_PROMPT_FORMATS.has(promptTestingFormatWidget.value)
                ? promptTestingFormatWidget.value
                : PROMPT_FORMAT_POSITIVE_ONLY;

            const syncPromptTestingFormatUi = () => {
                const value = currentPromptTestingFormat();
                promptTestingFormatWidget.value = value;
                promptFormatSelect.value = value;
                multiEditor.placeholder = value === PROMPT_FORMAT_POSITIVE_NEGATIVE
                    ? "P1=...;N1=...\nP2=...;N2=..."
                    : "One positive prompt per line";
            };

            let testingLineNumbersFrame = null;
            const syncTestingLineNumberScroll = () => {
                testingLineMapContent.style.transform = `translate3d(0, ${-multiEditor.scrollTop}px, 0)`;
            };

            const renderTestingLineNumbers = () => {
                testingLineNumbersFrame = null;
                const editorWidth = multiEditor.clientWidth;
                if (editorWidth <= 0) return;

                const computedStyle = window.getComputedStyle(multiEditor);
                const logicalLines = multiEditor.value.split(/\r\n|\r|\n/);
                const fragment = document.createDocumentFragment();

                for (let index = 0; index < logicalLines.length; index += 1) {
                    const row = createElement("span", "po-testing-line-row");
                    row.dataset.lineNumber = `${index + 1}.`;
                    row.textContent = logicalLines[index] || "\u200b";
                    row.style.font = computedStyle.font;
                    row.style.lineHeight = computedStyle.lineHeight;
                    row.style.letterSpacing = computedStyle.letterSpacing;
                    row.style.paddingLeft = computedStyle.paddingLeft;
                    row.style.paddingRight = computedStyle.paddingRight;
                    row.style.minHeight = computedStyle.lineHeight;
                    fragment.appendChild(row);
                }

                testingLineMap.style.width = `${editorWidth}px`;
                testingLineMapContent.style.paddingTop = computedStyle.paddingTop;
                testingLineMapContent.style.paddingBottom = computedStyle.paddingBottom;
                testingLineMapContent.replaceChildren(fragment);
                syncTestingLineNumberScroll();
            };

            const scheduleTestingLineNumbers = () => {
                if (testingLineNumbersFrame !== null) return;
                testingLineNumbersFrame = window.requestAnimationFrame(renderTestingLineNumbers);
            };

            const setTestingEditorValue = (value, persist = false) => {
                const normalizedValue = String(value ?? "");
                multiEditor.value = normalizedValue;
                if (persist) setWidgetValue(multiPromptTestingEditorWidget, normalizedValue);
                scheduleTestingLineNumbers();
            };

            const testingEditorResizeObserver = typeof ResizeObserver === "function"
                ? new ResizeObserver(scheduleTestingLineNumbers)
                : null;
            testingEditorResizeObserver?.observe(numberedEditor);
            testingEditorResizeObserver?.observe(multiEditor);
            multiEditor.addEventListener("scroll", syncTestingLineNumberScroll, { passive: true });

            promptFormatSelect.addEventListener("change", () => {
                commitGraphEdit(() => {
                    setWidgetValue(promptTestingFormatWidget, promptFormatSelect.value);
                    syncPromptTestingFormatUi();
                });
            });

            const bindPersistentText = (element, onInput) => {
                let editing = false;
                element.addEventListener("focus", () => {
                    if (editing) return;
                    editing = true;
                    beginGraphEdit();
                });
                element.addEventListener("input", () => {
                    onInput(element.value);
                    node.setDirtyCanvas(true, true);
                });
                element.addEventListener("blur", () => {
                    if (!editing) return;
                    editing = false;
                    endGraphEdit();
                });
                return () => {
                    if (!editing) return;
                    editing = false;
                    endGraphEdit();
                };
            };

            const finishTextEdits = [];
            let finishHistoryTextEdits = [];

            const clearHistoryTextEdits = () => {
                finishHistoryTextEdits.forEach((finish) => finish());
                finishHistoryTextEdits = [];
            };

            finishTextEdits.push(bindPersistentText(curatedSourceInput, (value) => {
                setWidgetValue(curatedPromptsFolderWidget, value);
            }));
            finishTextEdits.push(bindPersistentText(generatedSourceInput, (value) => {
                setWidgetValue(generatedPromptsFolderWidget, value);
            }));
            finishTextEdits.push(bindPersistentText(multiEditor, (value) => {
                setWidgetValue(multiPromptTestingEditorWidget, value);
                scheduleTestingLineNumbers();
            }));
            finishTextEdits.push(bindPersistentText(systemInput, (value) => {
                setWidgetValue(systemPromptWidget, value);
            }));

            const renderTabs = () => {
                const fallbackTab = Boolean(usePromptGenerationBranchWidget.value)
                    ? TAB_GENERATION
                    : TAB_TESTING;
                const activeTab = VALID_TABS.has(state?.activeTab) ? state.activeTab : fallbackTab;

                testingTabButton.setAttribute("aria-selected", String(activeTab === TAB_TESTING));
                generationTabButton.setAttribute("aria-selected", String(activeTab === TAB_GENERATION));
                systemTabButton.setAttribute("aria-selected", String(activeTab === TAB_SYSTEM));
                multiView.hidden = activeTab !== TAB_TESTING;
                generationView.hidden = activeTab !== TAB_GENERATION;
                systemView.hidden = activeTab !== TAB_SYSTEM;
                if (activeTab === TAB_TESTING) scheduleTestingLineNumbers();
            };

            const renderHistory = () => {
                clearHistoryTextEdits();
                history.replaceChildren();

                if (!state || state.contexts.length === 0) {
                    const emptyMessage = createElement("div", "po-message po-message--active po-message--empty");
                    const emptyEditor = createElement("textarea", "po-textarea po-message-editor");
                    emptyEditor.placeholder = "Write a message.";
                    emptyEditor.setAttribute("aria-label", "Message");
                    emptyMessage.appendChild(emptyEditor);
                    history.appendChild(emptyMessage);

                    finishHistoryTextEdits.push(bindPersistentText(emptyEditor, (value) => {
                        if (!state) return;
                        if (state.activeContextIndex < 0) {
                            state.contexts.push(value);
                            state.activeContextIndex = 0;
                        } else {
                            state.contexts[state.activeContextIndex] = value;
                        }
                        syncGenerationWidget();
                    }));
                    return;
                }

                state.contexts.forEach((contextValue, index) => {
                    const isActive = index === state.activeContextIndex;
                    const isLatest = index === state.contexts.length - 1;
                    const message = createElement(
                        "article",
                        `po-message${isActive ? " po-message--active" : ""}${isLatest ? " po-message--latest" : ""}`,
                    );
                    const messageActions = createElement("div", "po-message-actions");
                    const sendToTestingEditorButton = createIconButton(
                        "Send to Testing Editor",
                        "",
                        "M4 12h14M12 5l7 7-7 7M21 5v14",
                        () => {
                            const value = state.contexts[index] ?? "";
                            if (value.trim().length === 0) return;
                            commitGraphEdit(() => {
                                setTestingEditorValue(value, true);
                            });
                        },
                    );
                    sendToTestingEditorButton.disabled = contextValue.trim().length === 0;
                    const copyButton = createIconButton(
                        "Copy this message",
                        "",
                        "M8 8h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V8ZM16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3",
                        async () => {
                            try {
                                await copyTextToClipboard(state.contexts[index] ?? "");
                            } catch (error) {
                                console.error("[PromptOrchestrator] Copy failed:", error);
                            }
                        },
                    );
                    const deleteButton = createIconButton(
                        "Delete this message",
                        "po-icon-button--danger",
                        "M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5",
                        () => {
                        commitGraphEdit(() => {
                            state.contexts.splice(index, 1);

                            if (state.contexts.length === 0) {
                                state.activeContextIndex = -1;
                            } else if (index < state.activeContextIndex) {
                                state.activeContextIndex -= 1;
                            } else if (index === state.activeContextIndex) {
                                state.activeContextIndex = Math.min(index, state.contexts.length - 1);
                            }

                            syncGenerationWidget();
                            renderHistory();
                        });
                        },
                    );
                    messageActions.append(sendToTestingEditorButton, copyButton, deleteButton);

                    const editor = createElement("textarea", "po-textarea po-message-editor");
                    editor.value = contextValue;
                    editor.setAttribute("aria-label", "Message");
                    finishHistoryTextEdits.push(bindPersistentText(editor, (value) => {
                        state.contexts[index] = value;
                        sendToTestingEditorButton.disabled = value.trim().length === 0;
                        syncGenerationWidget();
                    }));

                    message.append(messageActions, editor);
                    history.appendChild(message);
                });

                requestAnimationFrame(() => {
                    history.scrollTop = history.scrollHeight;
                });
            };

            node.__promptOrchestrationGeneratedUi = {
                appendGeneratedMessage(value) {
                    if (typeof value !== "string") return false;
                    commitGraphEdit(() => {
                        if (!state) state = createLegacyState();
                        state.contexts.push(value);
                        state.activeContextIndex = state.contexts.length - 1;
                        syncGenerationWidget();
                        renderHistory();
                    });
                    return true;
                },
            };

            const renderAll = () => {
                curatedSourceInput.value = String(curatedPromptsFolderWidget.value ?? "");
                generatedSourceInput.value = String(generatedPromptsFolderWidget.value ?? "");
                setTestingEditorValue(multiPromptTestingEditorWidget.value);
                systemInput.value = String(systemPromptWidget.value ?? "");
                syncPromptTestingFormatUi();
                renderTabs();
                renderHistory();
            };

            const restoreState = (serializedProperties) => {
                const savedState = serializedProperties?.[STATE_PROPERTY]
                    ?? node.properties?.[STATE_PROPERTY];
                state = savedState ? normalizeState(savedState) : createLegacyState();
                syncGenerationWidget();
                renderAll();
            };

            const loadFromFolder = async (folderPath) => {
                try {
                    const response = await fetch("/prompt_orchestration/load_latest", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                            folder: folderPath,
                        }),
                    });

                    const result = await response.json();

                    if (result.value !== undefined) {
                        commitGraphEdit(() => {
                            setTestingEditorValue(result.value, true);
                            state.activeTab = TAB_TESTING;
                            setWidgetValue(usePromptGenerationBranchWidget, false);
                            saveState();
                            renderTabs();
                            setStatus("Prompt list loaded.");
                        });
                    }
                } catch (error) {
                    console.error("[PromptOrchestrator] Loading failed:", error);
                    setStatus("Loading failed. Check the ComfyUI log.", "error");
                }
            };

            const curatedPromptsButton = node.addWidget("button", "Load Curated Prompts", "", () => {
                const folderPath = curatedPromptsFolderWidget.value;
                if (folderPath) loadFromFolder(folderPath);
            });

            const generatedPromptsButton = node.addWidget("button", "Load Generated Prompts", "", () => {
                const folderPath = generatedPromptsFolderWidget.value;
                if (folderPath) loadFromFolder(folderPath);
            });

            const pasteInGenerationEditorButton = node.addWidget("button", "Paste in Generation Editor", "", () => {
                const sourceEditorValue = String(multiPromptTestingEditorWidget.value ?? "");
                if (!sourceEditorValue.trim()) return;

                commitGraphEdit(() => {
                    state.contexts.push(sourceEditorValue);
                    state.activeContextIndex = state.contexts.length - 1;
                    state.activeTab = TAB_GENERATION;
                    syncGenerationWidget();
                    setWidgetValue(usePromptGenerationBranchWidget, true);
                    renderAll();
                });
            });

            const curatedPromptsFolderIndex = node.widgets.findIndex((widget) => widget.name === "curated_prompts_folder");
            node.widgets.splice(node.widgets.indexOf(curatedPromptsButton), 1);
            node.widgets.splice(curatedPromptsFolderIndex + 1, 0, curatedPromptsButton);

            const generatedPromptsFolderIndex = node.widgets.findIndex((widget) => widget.name === "generated_prompts_folder");
            node.widgets.splice(node.widgets.indexOf(generatedPromptsButton), 1);
            node.widgets.splice(generatedPromptsFolderIndex + 1, 0, generatedPromptsButton);

            const multiPromptTestingEditorIndex = node.widgets.findIndex((widget) => widget.name === "multi_prompt_testing_editor");
            node.widgets.splice(node.widgets.indexOf(usePromptGenerationBranchWidget), 1);
            node.widgets.splice(multiPromptTestingEditorIndex + 1, 0, usePromptGenerationBranchWidget);

            const usePromptGenerationBranchIndex = node.widgets.findIndex((widget) => widget.name === "use_prompt_generation_branch");
            node.widgets.splice(node.widgets.indexOf(pasteInGenerationEditorButton), 1);
            node.widgets.splice(usePromptGenerationBranchIndex + 1, 0, pasteInGenerationEditorButton);

            const loadCuratedButton = createButton("Load Curated", "po-button", () => {
                const folderPath = curatedPromptsFolderWidget.value;
                if (folderPath) {
                    loadFromFolder(folderPath);
                } else {
                    setStatus("Choose a Curated prompts folder first.", "error");
                }
            });
            const loadGeneratedButton = createButton("Load Generated", "po-button", () => {
                const folderPath = generatedPromptsFolderWidget.value;
                if (folderPath) {
                    loadFromFolder(folderPath);
                } else {
                    setStatus("Choose a Generated prompts folder first.", "error");
                }
            });
            const sendToGenerationButton = createButton("Send to Generation", "po-button po-button--primary", () => {
                pasteInGenerationEditorButton.callback();
            });

            multiActions.append(loadCuratedButton, loadGeneratedButton, promptFormatControl, sendToGenerationButton);
            multiView.append(sourcesPanel, multiActions, numberedEditor, status);

            const technicalWidgets = [
                curatedPromptsFolderWidget,
                curatedPromptsButton,
                generatedPromptsFolderWidget,
                generatedPromptsButton,
                multiPromptTestingEditorWidget,
                usePromptGenerationBranchWidget,
                pasteInGenerationEditorButton,
                promptGenerationEditorWidget,
                systemPromptWidget,
                promptTestingFormatWidget,
            ];
            technicalWidgets.forEach((widget) => {
                widget.hidden = true;
                widget.options ??= {};
                widget.options.hidden = true;
            });

            node.addDOMWidget("prompt_orchestration_ui", "PromptOrchestratorUI", root, {
                serialize: false,
                hideOnZoom: false,
                getMinHeight: () => 520,
                getHeight: () => Math.max(520, node.size?.[1] - 34 || 520),
            });
            node.resizable = true;

            const originalOnConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                configuredFromWorkflow = true;
                if (originalOnConfigure) {
                    originalOnConfigure.apply(this, arguments);
                }
                restoreState(info?.properties);
            };

            const originalOnSerialize = node.onSerialize;
            node.onSerialize = function (info) {
                saveState();
                if (originalOnSerialize) {
                    originalOnSerialize.apply(this, arguments);
                }
            };

            const originalOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearHistoryTextEdits();
                finishTextEdits.forEach((finish) => finish());
                if (testingLineNumbersFrame !== null) {
                    window.cancelAnimationFrame(testingLineNumbersFrame);
                    testingLineNumbersFrame = null;
                }
                testingEditorResizeObserver?.disconnect();
                multiEditor.removeEventListener("scroll", syncTestingLineNumberScroll);
                delete node.__promptOrchestrationSourcesUi;
                delete node.__promptOrchestrationGeneratedUi;
                root.remove();
                if (originalOnRemoved) {
                    originalOnRemoved.apply(this, arguments);
                }
            };

            window.setTimeout(() => {
                if (!state) {
                    restoreState();
                }
                if (!configuredFromWorkflow) {
                    const currentWidth = Number(node.size?.[0]) || 0;
                    const currentHeight = Number(node.size?.[1]) || 0;
                    node.setSize([
                        Math.max(580, currentWidth),
                        Math.max(700, currentHeight),
                    ]);
                }
            }, 0);
        };
    },
});
