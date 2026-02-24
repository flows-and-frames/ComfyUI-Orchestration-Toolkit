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

            const folder1Widget = getWidget("folder_string_1");
            const folder2Widget = getWidget("folder_string_2");
            const editor1Widget = getWidget("editor_1");
            const editor2Widget = getWidget("editor_2");
            const useEditor2Widget = getWidget("use_editor_2");

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

                if (result.value !== undefined && editor1Widget) {
                    editor1Widget.value = result.value;
                    this.setDirtyCanvas(true, true);
                }
            };

            // ---------- Buttons ----------

            const string1Button = this.addWidget("button", "String 1", "", () => {
                if (folder1Widget && folder1Widget.value) {
                    loadFromFolder(folder1Widget.value);
                }
            });

            const string2Button = this.addWidget("button", "String 2", "", () => {
                if (folder2Widget && folder2Widget.value) {
                    loadFromFolder(folder2Widget.value);
                }
            });

            const pasteEditor1Button = this.addWidget("button", "Paste Editor 1", "", () => {

                if (!editor1Widget || !editor2Widget) return;

                const e1 = editor1Widget.value || "";
                const e2 = editor2Widget.value || "";

                if (!e1.trim()) return;

                if (!e2.trim()) {
                    editor2Widget.value = e1;
                } else {
                    editor2Widget.value = e2 + "\n" + e1;
                }

                this.setDirtyCanvas(true, true);
            });

            // ---------- Layout (korrekt mit splice & dynamischen Indizes) ----------

            // String 1 unter folder_string_1
            let folder1Index = this.widgets.findIndex(w => w.name === "folder_string_1");
            this.widgets.splice(this.widgets.indexOf(string1Button), 1);
            this.widgets.splice(folder1Index + 1, 0, string1Button);

            // String 2 unter folder_string_2
            let folder2Index = this.widgets.findIndex(w => w.name === "folder_string_2");
            this.widgets.splice(this.widgets.indexOf(string2Button), 1);
            this.widgets.splice(folder2Index + 1, 0, string2Button);

            // use_editor_2 unter editor_1
            let editor1Index = this.widgets.findIndex(w => w.name === "editor_1");
            this.widgets.splice(this.widgets.indexOf(useEditor2Widget), 1);
            this.widgets.splice(editor1Index + 1, 0, useEditor2Widget);

            // Paste Editor 1 unter use_editor_2
            let useEditor2Index = this.widgets.findIndex(w => w.name === "use_editor_2");
            this.widgets.splice(this.widgets.indexOf(pasteEditor1Button), 1);
            this.widgets.splice(useEditor2Index + 1, 0, pasteEditor1Button);
        };
    }
});
