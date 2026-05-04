import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "prompt_orchestration",

    registerCustomNodes() {

        const nodeType = LiteGraph.registered_node_types["PromptOrchestrator"];
        if (!nodeType) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {

            if (originalOnNodeCreated) {
                originalOnNodeCreated.apply(this, arguments);
            }

            const getWidget = (name) => {
                return this.widgets.find(w => w.name === name);
            };

            const curatedPromptsFolderWidget = getWidget("curated_prompts_folder");
            const generatedPromptsFolderWidget = getWidget("generated_prompts_folder");
            const multiPromptTestingEditorWidget = getWidget("multi_prompt_testing_editor");
            const promptGenerationEditorWidget = getWidget("prompt_generation_editor");
            const usePromptGenerationBranchWidget = getWidget("use_prompt_generation_branch");

            // ---------- API Call ----------

            const loadFromFolder = async (folderPath) => {

                const response = await fetch("/prompt_orchestration/load_latest", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        folder: folderPath
                    })
                });

                const result = await response.json();

                if (result.value !== undefined && multiPromptTestingEditorWidget) {
                    multiPromptTestingEditorWidget.value = result.value;
                    this.setDirtyCanvas(true, true);
                }
            };

            // ---------- Buttons ----------

            const curatedPromptsButton = this.addWidget("button", "Load Curated Prompts", "", () => {
                if (curatedPromptsFolderWidget && curatedPromptsFolderWidget.value) {
                    loadFromFolder(curatedPromptsFolderWidget.value);
                }
            });

            const generatedPromptsButton = this.addWidget("button", "Load Generated Prompts", "", () => {
                if (generatedPromptsFolderWidget && generatedPromptsFolderWidget.value) {
                    loadFromFolder(generatedPromptsFolderWidget.value);
                }
            });

            const pasteInGenerationEditorButton = this.addWidget("button", "Paste in Generation Editor", "", () => {

                if (!multiPromptTestingEditorWidget || !promptGenerationEditorWidget) return;

                const sourceEditorValue = multiPromptTestingEditorWidget.value || "";
                const targetEditorValue = promptGenerationEditorWidget.value || "";

                if (!sourceEditorValue.trim()) return;

                if (!targetEditorValue.trim()) {
                    promptGenerationEditorWidget.value = sourceEditorValue;
                } else {
                    promptGenerationEditorWidget.value = targetEditorValue + "\n" + sourceEditorValue;
                }

                this.setDirtyCanvas(true, true);
            });

            // ---------- Layout (korrekt mit splice & dynamischen Indizes) ----------

            // Load Curated Prompts unter curated_prompts_folder
            let curatedPromptsFolderIndex = this.widgets.findIndex(w => w.name === "curated_prompts_folder");
            this.widgets.splice(this.widgets.indexOf(curatedPromptsButton), 1);
            this.widgets.splice(curatedPromptsFolderIndex + 1, 0, curatedPromptsButton);

            // Load Generated Prompts unter generated_prompts_folder
            let generatedPromptsFolderIndex = this.widgets.findIndex(w => w.name === "generated_prompts_folder");
            this.widgets.splice(this.widgets.indexOf(generatedPromptsButton), 1);
            this.widgets.splice(generatedPromptsFolderIndex + 1, 0, generatedPromptsButton);

            // use_prompt_generation_branch unter multi_prompt_testing_editor
            let multiPromptTestingEditorIndex = this.widgets.findIndex(w => w.name === "multi_prompt_testing_editor");
            this.widgets.splice(this.widgets.indexOf(usePromptGenerationBranchWidget), 1);
            this.widgets.splice(multiPromptTestingEditorIndex + 1, 0, usePromptGenerationBranchWidget);

            // Paste in Generation Editor unter use_prompt_generation_branch
            let usePromptGenerationBranchIndex = this.widgets.findIndex(w => w.name === "use_prompt_generation_branch");
            this.widgets.splice(this.widgets.indexOf(pasteInGenerationEditorButton), 1);
            this.widgets.splice(usePromptGenerationBranchIndex + 1, 0, pasteInGenerationEditorButton);
        };
    }
});
