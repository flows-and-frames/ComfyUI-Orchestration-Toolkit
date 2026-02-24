import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "prompt_orchestration.dynamic_node_state_controller",

    registerCustomNodes() {

        const nodeType = LiteGraph.registered_node_types["prompt_orchestration/dynamic_node_state_controller"];
        if (!nodeType) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {

            if (originalOnNodeCreated) {
                originalOnNodeCreated.apply(this, arguments);
            }

            if (!this.properties.rows) this.properties.rows = [];
            if (this.properties.collapsed === undefined) this.properties.collapsed = false;

            this.rows = [];
            this.widgets = [];

            // 🔥 APPLY ganz oben
            this.applyWidget = this.addWidget("button", "APPLY", null, () => {
                this.applyActions();
            });

            // 🔽 Collapse darunter
            this.collapseWidget = this.addWidget(
                "button",
                this.properties.collapsed ? "Expand ▼" : "Collapse ▲",
                null,
                () => this.toggleCollapse()
            );

            this.rebuildUI();
        };

        nodeType.prototype.toggleCollapse = function () {

            this.properties.collapsed = !this.properties.collapsed;

            this.widgets = [];

            // Buttons neu aufbauen (Reihenfolge bleibt)
            this.applyWidget = this.addWidget("button", "APPLY", null, () => {
                this.applyActions();
            });

            this.collapseWidget = this.addWidget(
                "button",
                this.properties.collapsed ? "Expand ▼" : "Collapse ▲",
                null,
                () => this.toggleCollapse()
            );

            this.rebuildUI();
        };

        nodeType.prototype.rebuildUI = function () {

            if (this.properties.collapsed) {
                this.setSize([340, 120]);
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

            row.actionWidget = this.addWidget("combo", "Action", actionValue, (v) => {
                row.action = v;
                this.syncProperties();
            }, {
                values: ["Mute", "Unmute", "Bypass", "Unbypass"]
            });

            row.removeWidget = this.addWidget("button", "✖ Remove", null, () => {
                this.widgets = this.widgets.filter(w =>
                    w !== row.idWidget &&
                    w !== row.actionWidget &&
                    w !== row.removeWidget
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
            this.properties.rows = this.rows.map(r => ({
                id: r.id,
                action: r.action
            }));
        };

        nodeType.prototype.updateLayout = function () {
            this.setSize([340, 150 + this.rows.length * 70]);
            app.graph.setDirtyCanvas(true);
        };

        nodeType.prototype.applyActions = function () {

            app.graph.beforeChange();

            for (let row of this.rows) {

                if (!row.id) continue;

                const id = Number(row.id);
                if (isNaN(id)) continue;

                const node = app.graph.getNodeById(id);
                if (!node) continue;

                switch (row.action) {
                    case "Mute": node.mode = 2; break;
                    case "Unmute": node.mode = 0; break;
                    case "Bypass": node.mode = 4; break;
                    case "Unbypass": node.mode = 0; break;
                }
            }

            app.graph.afterChange();
            app.graph.setDirtyCanvas(true);
        };
    }
});
