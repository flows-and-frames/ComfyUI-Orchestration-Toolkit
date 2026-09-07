import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_NAME = "prompt_orchestration.prompt_image_picker";
const OPEN_EVENT = "prompt_orchestration:image_picker_open";
const TICK_EVENT = "prompt_orchestration:image_picker_tick";
const CLOSE_EVENT = "prompt_orchestration:image_picker_close";
const RESPONSE_ROUTE = "/prompt_orchestration/image_picker/respond";
const STYLE_ID = "prompt-orchestration-image-picker-style-v3";
const SESSION_STORAGE_KEY = "prompt_orchestration.prompt_image_picker.active";
const HEARTBEAT_INTERVAL_MS = 30_000;
const TOUCH_DELAY_MS = 450;
const DETAIL_MIN_ZOOM = 1;
const DETAIL_MAX_ZOOM = 8;
const DETAIL_WHEEL_SENSITIVITY = 0.0015;

const ICONS = Object.freeze({
    edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z",
    minimize: "M5 12h14",
    close: "M6 6l12 12M18 6 6 18",
    previous: "M15 18l-6-6 6-6",
    next: "M9 18l6-6-6-6",
    check: "M5 12l4 4L19 6",
});

const asString = (value) => value == null ? "" : String(value);

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

const createIcon = (pathData) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
};

const createIconButton = (label, className, pathData, onClick) => {
    const button = createButton("", className, onClick);
    button.appendChild(createIcon(pathData));
    button.title = label;
    button.setAttribute("aria-label", label);
    return button;
};

const formatRemaining = (seconds) => {
    const safeSeconds = Math.max(0, Math.ceil(Number(seconds) || 0));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const remainder = safeSeconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
};

const isCompactMode = (value) => asString(value).toLowerCase().includes("compact");

const imageUrl = (image, requestId) => {
    const params = new URLSearchParams();
    params.set("filename", asString(image.filename));
    params.set("type", asString(image.type) || "temp");
    params.set("subfolder", asString(image.subfolder));
    params.set("r", requestId);
    return api.apiURL(`/view?${params.toString()}`);
};

const formatAspectRatio = (image) => {
    const width = Number(image?.width) || 0;
    const height = Number(image?.height) || 0;
    if (width <= 0 || height <= 0) return "Aspect ratio unavailable";
    const compact = (value) => value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
    const ratio = width >= height
        ? `${compact(width / height)}:1`
        : `1:${compact(height / width)}`;
    return `${width}×${height} · ${ratio}`;
};

const injectStyles = () => {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .opi-overlay,
        .opi-notice {
            --opi-bg: var(--node-component-surface, var(--bg-color, #202020));
            --opi-surface: var(--comfy-input-bg, #222);
            --opi-raised: var(--button-surface, var(--comfy-menu-secondary-bg, #303030));
            --opi-hover: var(--button-hover-surface, #3a3a3a);
            --opi-selected: var(--button-active-surface, var(--secondary-background-selected, #414141));
            --opi-border: var(--node-component-border, var(--border-color, #4e4e4e));
            --opi-border-soft: var(--border-subtle, var(--border-color, #3f3f3f));
            --opi-text: var(--input-text, var(--fg-color, #ddd));
            --opi-muted: var(--descrip-text, var(--text-secondary, #aaa));
            --opi-accent: var(--node-component-border-selected, var(--accent-primary, #ddd));
            --opi-selection: #6f9fca;
            --opi-selection-surface: #293641;
            --opi-danger: var(--error-text, #d88);
            --opi-shadow: 0 20px 60px rgb(0 0 0 / 0.48);
            color: var(--opi-text);
            font: 12px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .opi-overlay *,
        .opi-overlay *::before,
        .opi-overlay *::after,
        .opi-notice *,
        .opi-notice *::before,
        .opi-notice *::after {
            box-sizing: border-box;
        }

        .opi-overlay {
            position: fixed;
            z-index: 10020;
            inset: 0;
            display: grid;
            place-items: center;
            min-width: 0;
            min-height: 0;
            padding: clamp(12px, 2.5vw, 32px);
            background: rgb(0 0 0 / 0.7);
            backdrop-filter: blur(2px);
        }

        .opi-dialog {
            width: min(1480px, 96vw);
            height: min(940px, 94vh);
            min-width: 0;
            min-height: 420px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border: 1px solid var(--opi-border);
            border-radius: 7px;
            background: var(--opi-bg);
            box-shadow: var(--opi-shadow);
        }

        .opi-header,
        .opi-footer {
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
            padding: 10px 12px;
            border-color: var(--opi-border-soft);
            background: var(--opi-raised);
        }

        .opi-header { border-bottom: 1px solid var(--opi-border-soft); }
        .opi-footer { border-top: 1px solid var(--opi-border-soft); }
        .opi-header-copy { min-width: 0; margin-right: auto; }
        .opi-title { margin: 0; overflow: hidden; color: var(--opi-text); font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
        .opi-subtitle { overflow: hidden; margin-top: 1px; color: var(--opi-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
        .opi-timer { flex: 0 0 auto; min-width: 76px; padding: 4px 8px; border: 1px solid var(--opi-border); border-radius: 4px; background: var(--opi-surface); color: var(--opi-muted); text-align: center; font-variant-numeric: tabular-nums; }
        .opi-timer[data-paused="true"] { color: var(--opi-text); }

        .opi-main {
            flex: 1 1 auto;
            min-width: 0;
            min-height: 0;
            overflow-x: hidden;
            overflow-y: auto;
            padding: 12px;
            background: var(--opi-bg);
            scrollbar-color: var(--opi-muted) var(--opi-bg);
            scrollbar-gutter: stable;
        }

        .opi-grid {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            align-items: start;
            gap: 12px;
            min-width: 0;
        }

        .opi-card {
            position: relative;
            min-width: 0;
            overflow: hidden;
            border: 1px solid var(--opi-border-soft);
            border-radius: 5px;
            background: var(--opi-surface);
            transition: border-color 100ms ease, background 100ms ease, box-shadow 100ms ease;
        }

        .opi-card:hover { border-color: var(--opi-border); background: var(--opi-raised); }
        .opi-card[data-selected="true"] { border-color: var(--opi-selection); box-shadow: inset 0 0 0 1px var(--opi-selection); background: var(--opi-selection-surface); }

        .opi-thumbnail {
            display: block;
            width: 100%;
            min-width: 0;
            padding: 0;
            border: 0;
            background: #151515;
            color: inherit;
            cursor: pointer;
        }

        .opi-media {
            position: relative;
            width: 100%;
            aspect-ratio: 4 / 3;
            display: grid;
            place-items: center;
            overflow: hidden;
            background:
                linear-gradient(45deg, #181818 25%, transparent 25%),
                linear-gradient(-45deg, #181818 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, #181818 75%),
                linear-gradient(-45deg, transparent 75%, #181818 75%),
                #202020;
            background-position: 0 0, 0 6px, 6px -6px, -6px 0;
            background-size: 12px 12px;
        }

        .opi-media-image { position: absolute; inset: 0; display: block; background-position: center; background-repeat: no-repeat; background-size: contain; }

        .opi-badge,
        .opi-check {
            position: absolute;
            z-index: 2;
            display: grid;
            place-items: center;
            min-width: 27px;
            height: 24px;
            padding: 0 7px;
            border: 1px solid rgb(255 255 255 / 0.24);
            border-radius: 4px;
            background: rgb(20 20 20 / 0.86);
            color: #e1e1e1;
            font-size: 11px;
            font-weight: 700;
            box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
            pointer-events: none;
        }

        .opi-badge { top: 8px; left: 8px; }
        .opi-check { right: 8px; bottom: 8px; width: 25px; min-width: 25px; padding: 4px; opacity: 0; transform: scale(0.9); transition: opacity 100ms ease, transform 100ms ease; }
        .opi-check svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
        .opi-card[data-selected="true"] .opi-check { border-color: var(--opi-selection); background: #31506c; color: #edf6ff; opacity: 1; transform: scale(1); }

        .opi-edit-button {
            position: absolute;
            z-index: 3;
            top: 7px;
            right: 7px;
            width: 28px;
            min-width: 28px;
            min-height: 28px;
            display: grid;
            place-items: center;
            padding: 5px;
            border: 1px solid rgb(255 255 255 / 0.22);
            border-radius: 4px;
            background: rgb(20 20 20 / 0.88);
            color: #ddd;
            cursor: pointer;
            opacity: 0;
            transition: opacity 100ms ease, background 100ms ease;
        }

        .opi-card:hover .opi-edit-button,
        .opi-edit-button:focus-visible { opacity: 1; }
        .opi-edit-button:hover { background: #393939; }
        .opi-edit-button svg,
        .opi-icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

        .opi-card-meta { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 9px; color: var(--opi-muted); font-size: 11px; }
        .opi-card-meta span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .opi-card-dimensions { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }

        .opi-detail {
            height: 100%;
            min-height: 0;
            display: grid;
            grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.75fr);
            gap: 12px;
        }

        .opi-detail-image-panel,
        .opi-detail-editor {
            min-width: 0;
            min-height: 0;
            overflow: hidden;
            border: 1px solid var(--opi-border);
            border-radius: 5px;
            background: var(--opi-surface);
        }

        .opi-detail-image-panel { position: relative; display: grid; place-items: center; overflow: hidden; overscroll-behavior: contain; background: #151515; cursor: default; }
        .opi-detail-image-panel[data-zoomed="true"] { cursor: grab; }
        .opi-detail-image-panel[data-dragging="true"] { cursor: grabbing; }
        .opi-detail-image { display: block; width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: none; transform-origin: center center; will-change: transform; user-select: none; -webkit-user-drag: none; }
        .opi-detail-aspect { position: absolute; z-index: 2; right: 10px; bottom: 10px; padding: 5px 7px; border: 1px solid rgb(255 255 255 / 0.22); border-radius: 4px; background: rgb(20 20 20 / 0.84); color: #ddd; font-size: 11px; font-weight: 650; pointer-events: none; }
        .opi-detail-editor { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding: 12px; }
        .opi-detail-heading { display: flex; align-items: center; gap: 8px; min-width: 0; padding-bottom: 8px; border-bottom: 1px solid var(--opi-border-soft); }
        .opi-detail-position { min-width: 0; margin-right: auto; color: var(--opi-text); font-weight: 700; }
        .opi-selected-toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--opi-muted); cursor: pointer; user-select: none; }
        .opi-selected-toggle input { accent-color: var(--opi-accent); }

        .opi-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
        .opi-label { color: var(--opi-muted); font-size: 11px; font-weight: 650; letter-spacing: 0.02em; }
        .opi-textarea {
            width: 100%;
            min-height: 160px;
            padding: 9px 10px;
            border: 1px solid var(--opi-border);
            border-radius: 4px;
            background: var(--opi-bg);
            color: var(--opi-text);
            font: inherit;
            line-height: 1.5;
            overflow-wrap: anywhere;
            resize: vertical;
        }
        .opi-field[data-invalid="true"] .opi-textarea { border-color: var(--opi-danger); }
        .opi-hint { margin-top: auto; padding-top: 4px; color: var(--opi-muted); font-size: 11px; }
        .opi-detail-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 4px; }

        .opi-button,
        .opi-icon-button {
            min-height: 31px;
            padding: 6px 10px;
            border: 1px solid var(--opi-border);
            border-radius: 4px;
            background: var(--opi-raised);
            color: var(--opi-text);
            font: inherit;
            font-weight: 650;
            cursor: pointer;
        }

        .opi-button:hover,
        .opi-icon-button:hover { border-color: var(--opi-accent); background: var(--opi-hover); }
        .opi-button:disabled,
        .opi-icon-button:disabled { opacity: 0.45; cursor: default; pointer-events: none; }
        .opi-button--primary { border-color: var(--opi-accent); background: var(--opi-selected); }
        .opi-button--danger:hover { border-color: var(--opi-danger); color: var(--opi-danger); }
        .opi-button--quiet { border-color: transparent; background: transparent; color: var(--opi-muted); }
        .opi-button--quiet:hover { color: var(--opi-text); }
        .opi-icon-button { width: 31px; min-width: 31px; display: grid; place-items: center; padding: 6px; }
        .opi-button:focus-visible,
        .opi-icon-button:focus-visible,
        .opi-thumbnail:focus-visible,
        .opi-edit-button:focus-visible,
        .opi-textarea:focus-visible { outline: 2px solid var(--opi-accent); outline-offset: 2px; }

        .opi-footer-status { min-width: 0; margin-right: auto; color: var(--opi-muted); }
        .opi-footer-status[data-kind="error"] { color: var(--opi-danger); }
        .opi-selection-count { flex: 0 0 auto; color: var(--opi-muted); font-variant-numeric: tabular-nums; }

        .opi-notice {
            position: fixed;
            z-index: 10020;
            right: 18px;
            bottom: 18px;
            width: min(390px, calc(100vw - 36px));
            display: grid;
            grid-template-columns: 72px minmax(0, 1fr);
            gap: 11px;
            overflow: hidden;
            padding: 10px;
            border: 1px solid var(--opi-border);
            border-radius: 7px;
            background: var(--opi-bg);
            box-shadow: var(--opi-shadow);
        }

        .opi-notice-preview { width: 72px; height: 72px; overflow: hidden; border: 1px solid var(--opi-border-soft); border-radius: 4px; background: #151515; }
        .opi-notice-preview img { display: block; width: 100%; height: 100%; object-fit: contain; }
        .opi-notice-body { min-width: 0; }
        .opi-notice-title { overflow: hidden; color: var(--opi-text); font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
        .opi-notice-meta { margin-top: 2px; color: var(--opi-muted); font-size: 11px; }
        .opi-notice-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
        .opi-notice-actions .opi-button { min-height: 28px; padding: 4px 8px; }

        @media (max-width: 1120px) {
            .opi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }

        @media (max-width: 780px) {
            .opi-overlay { padding: 8px; }
            .opi-dialog { width: 100%; height: 100%; min-height: 0; border-radius: 5px; }
            .opi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
            .opi-detail { grid-template-columns: 1fr; grid-template-rows: minmax(220px, 1fr) auto; }
            .opi-detail-editor { max-height: 45vh; }
            .opi-footer { flex-wrap: wrap; }
            .opi-footer-status { flex-basis: 100%; order: 5; }
        }

        @media (max-width: 480px) {
            .opi-grid { grid-template-columns: minmax(0, 1fr); }
        }

        @media (hover: none) {
            .opi-edit-button { opacity: 1; }
        }

        @media (prefers-reduced-motion: reduce) {
            .opi-card,
            .opi-check,
            .opi-edit-button { transition: none; }
        }
    `;
    document.head.appendChild(style);
};

class PromptImagePickerUi {
    constructor() {
        this.session = null;
        this.overlay = null;
        this.notice = null;
        this.timerHandle = window.setInterval(() => this.updateCountdown(), 250);
        this.heartbeatHandle = null;
        this.touchHandle = null;
        this.dirtyIndexes = new Set();
        this.countdownElements = new Set();
        this.statusElements = new Set();
        this.lastFocusedElement = null;
        this.detailViewportCleanup = null;
        this.boundVisibilityChange = () => {
            if (document.visibilityState === "visible" && this.session?.paused) {
                this.sendHeartbeat();
            }
        };
        document.addEventListener("visibilitychange", this.boundVisibilityChange);
    }

    persistedPayload() {
        if (!this.session) return null;
        return {
            request_id: this.session.requestId,
            token: this.session.token,
            prompt_id: this.session.promptId,
            node_id: this.session.nodeId,
            title: this.session.title,
            display_mode: this.session.displayMode,
            on_timeout: this.session.onTimeout,
            timeout_seconds: this.session.timeoutSeconds,
            remaining_seconds: this.currentRemaining(),
            paused: this.session.paused,
            items: this.session.items.map((item) => ({
                index: item.index,
                slot: item.slot,
                positive: item.positive,
                negative: item.negative,
                image: { ...item.image },
            })),
            selected: [...this.session.selected],
            view: this.session.view,
            detail_position: this.session.detailPosition,
        };
    }

    persistSession() {
        try {
            const payload = this.persistedPayload();
            if (payload) sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
            else sessionStorage.removeItem(SESSION_STORAGE_KEY);
        } catch (error) {
            console.warn("[Prompt Image Picker] Could not persist active picker UI state.", error);
        }
    }

    restorePersistedSession() {
        let payload = null;
        try {
            const encoded = sessionStorage.getItem(SESSION_STORAGE_KEY);
            if (!encoded) return;
            payload = JSON.parse(encoded);
        } catch (error) {
            console.warn("[Prompt Image Picker] Ignored invalid persisted picker UI state.", error);
            try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* no-op */ }
            return;
        }

        const selected = Array.isArray(payload?.selected) ? payload.selected : [];
        const savedView = ["gallery", "detail", "compact"].includes(payload?.view)
            ? payload.view
            : null;
        const detailPosition = Number.isInteger(payload?.detail_position)
            ? payload.detail_position
            : null;
        this.handleOpen(payload);
        if (!this.session) return;

        const validIndexes = new Set(this.session.items.map((item) => item.index));
        this.session.selected = new Set(selected.filter((index) => validIndexes.has(index)));
        if (savedView) this.session.view = savedView;
        if (savedView === "detail") {
            this.session.detailPosition = Math.max(
                0,
                Math.min(detailPosition ?? 0, this.session.items.length - 1),
            );
        }
        this.render();
        this.persistSession();

        const action = this.session.view === "detail" ? "heartbeat" : "resume";
        const requestId = this.session.requestId;
        this.postAction(action, { items: this.editedItems() })
            .then((result) => {
                if (this.session?.requestId !== requestId) return;
                this.syncFromResponse(result, this.session.view === "detail");
            })
            .catch(() => {
                if (this.session?.requestId === requestId) this.closeLocal();
            });
    }

    normalizeOpenPayload(payload) {
        if (!payload || typeof payload !== "object") return null;
        const requestId = asString(payload.request_id);
        const token = asString(payload.token);
        if (!requestId || !token || !Array.isArray(payload.items) || payload.items.length === 0) {
            return null;
        }

        const seenIndexes = new Set();
        const items = [];
        for (let position = 0; position < payload.items.length; position += 1) {
            const source = payload.items[position];
            if (!source || typeof source !== "object") return null;
            const index = Number.isInteger(source.index) ? source.index : position;
            if (index < 0 || seenIndexes.has(index)) return null;
            seenIndexes.add(index);

            const image = source.image;
            if (!image || typeof image !== "object" || !asString(image.filename)) return null;
            const width = Number(image.width);
            const height = Number(image.height);
            items.push({
                index,
                slot: Number.isInteger(source.slot) && source.slot > 0 ? source.slot : position + 1,
                positive: asString(source.positive),
                negative: asString(source.negative),
                image: {
                    filename: asString(image.filename),
                    subfolder: asString(image.subfolder),
                    type: asString(image.type) || "temp",
                    width: Number.isFinite(width) && width > 0 ? width : null,
                    height: Number.isFinite(height) && height > 0 ? height : null,
                },
            });
        }

        const timeoutSeconds = Math.max(1, Number(payload.timeout_seconds) || 600);
        const remainingSeconds = Math.max(
            0,
            Number(payload.remaining_seconds ?? payload.remaining ?? timeoutSeconds) || 0,
        );

        return {
            requestId,
            token,
            promptId: asString(payload.prompt_id),
            nodeId: asString(payload.node_id),
            title: asString(payload.title) || "Prompt Image Picker",
            displayMode: isCompactMode(payload.display_mode ?? payload.display) ? "compact" : "gallery",
            onTimeout: asString(payload.on_timeout) || "Keep all",
            timeoutSeconds,
            remainingSeconds,
            paused: payload.paused === true,
            items,
        };
    }

    handleOpen(payload) {
        const normalized = this.normalizeOpenPayload(payload);
        if (!normalized) {
            console.error("[Prompt Image Picker] Ignored an invalid open payload.");
            return;
        }

        if (this.session?.requestId === normalized.requestId) {
            this.syncTiming(normalized.remainingSeconds, normalized.paused);
            return;
        }

        this.closeLocal();
        this.lastFocusedElement = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        this.session = {
            ...normalized,
            pairedMode: normalized.items.some((item) => item.negative.trim().length > 0),
            selected: new Set(normalized.items.length === 1 ? [normalized.items[0].index] : []),
            view: normalized.displayMode,
            detailPosition: null,
            pending: false,
            status: "",
            statusKind: "info",
            timingUpdatedAt: performance.now(),
        };
        this.render();
        if (this.session.paused) this.startHeartbeat();
        this.persistSession();
    }

    handleTick(payload) {
        if (!this.matchesCurrent(payload)) return;
        const remaining = Number(payload.remaining_seconds ?? payload.remaining);
        this.syncTiming(Number.isFinite(remaining) ? remaining : this.currentRemaining(), payload.paused === true);
    }

    handleClose(payload) {
        if (!this.matchesCurrent(payload)) return;
        const message = asString(payload?.message);
        const reason = asString(payload?.reason);
        this.closeLocal();
        if (message) {
            this.notify(message, reason === "error" ? "error" : "info");
        }
    }

    handleExecutionEnd(payload, fallbackMessage) {
        if (!this.session) return;
        const promptId = asString(payload?.prompt_id);
        if (promptId && this.session.promptId && promptId !== this.session.promptId) return;
        this.closeLocal();
        if (fallbackMessage) this.notify(fallbackMessage, "info");
    }

    matchesCurrent(payload) {
        if (!this.session || !payload || typeof payload !== "object") return false;
        return asString(payload.request_id) === this.session.requestId;
    }

    currentRemaining() {
        if (!this.session) return 0;
        if (this.session.paused) return this.session.remainingSeconds;
        const elapsed = (performance.now() - this.session.timingUpdatedAt) / 1000;
        return Math.max(0, this.session.remainingSeconds - elapsed);
    }

    syncTiming(remainingSeconds, paused) {
        if (!this.session) return;
        this.session.remainingSeconds = Math.max(0, Number(remainingSeconds) || 0);
        this.session.timingUpdatedAt = performance.now();
        this.session.paused = paused === true;
        if (this.session.paused || this.session.view === "detail") this.startHeartbeat();
        else this.stopHeartbeat();
        this.updateCountdown();
    }

    updateCountdown() {
        if (!this.session) return;
        const remaining = this.currentRemaining();
        const label = this.session.paused
            ? `Paused · ${formatRemaining(remaining)}`
            : formatRemaining(remaining);
        for (const element of this.countdownElements) {
            if (!element.isConnected) {
                this.countdownElements.delete(element);
                continue;
            }
            element.textContent = label;
            element.dataset.paused = String(this.session.paused);
            element.title = this.session.paused
                ? "Timeout is paused while the prompt is being edited."
                : `On timeout: ${this.session.onTimeout}`;
        }
    }

    setStatus(message, kind = "info") {
        if (!this.session) return;
        this.session.status = asString(message);
        this.session.statusKind = kind;
        for (const element of this.statusElements) {
            if (!element.isConnected) {
                this.statusElements.delete(element);
                continue;
            }
            element.textContent = this.session.status;
            element.dataset.kind = kind;
        }
    }

    notify(message, kind = "info") {
        const severity = kind === "error" ? "error" : "info";
        const toast = app.extensionManager?.toast;
        if (toast?.add) {
            toast.add({
                severity,
                summary: "Prompt Image Picker",
                detail: asString(message),
                life: 6000,
            });
        } else if (kind === "error") {
            console.error(`[Prompt Image Picker] ${message}`);
        } else {
            console.info(`[Prompt Image Picker] ${message}`);
        }
    }

    render() {
        this.removeUiElements();
        if (!this.session) return;
        if (this.session.view === "compact") this.renderNotice();
        else this.renderOverlay();
        this.updateCountdown();
    }

    removeUiElements() {
        this.detailViewportCleanup?.();
        this.detailViewportCleanup = null;
        this.overlay?.remove();
        this.notice?.remove();
        this.overlay = null;
        this.notice = null;
        this.countdownElements.clear();
        this.statusElements.clear();
    }

    renderNotice() {
        const session = this.session;
        if (!session) return;

        const notice = createElement("section", "opi-notice");
        notice.setAttribute("role", "status");
        notice.setAttribute("aria-live", "polite");
        notice.addEventListener("keydown", (event) => event.stopPropagation());
        notice.addEventListener("keyup", (event) => event.stopPropagation());

        const preview = createElement("div", "opi-notice-preview");
        const previewImage = createElement("img");
        previewImage.src = imageUrl(session.items[0].image, session.requestId);
        previewImage.alt = "First generated image";
        preview.appendChild(previewImage);

        const body = createElement("div", "opi-notice-body");
        const title = createElement("div", "opi-notice-title", session.title);
        const timer = createElement("div", "opi-notice-meta");
        this.countdownElements.add(timer);
        const count = createElement(
            "div",
            "opi-notice-meta",
            `${session.items.length} image${session.items.length === 1 ? "" : "s"} ready for selection`,
        );
        const actions = createElement("div", "opi-notice-actions");
        const openButton = createButton("Open", "opi-button opi-button--primary", () => {
            if (!this.session?.pending) {
                this.session.view = "gallery";
                this.render();
                this.persistSession();
            }
        });
        const keepAllButton = createButton("Keep all", "opi-button", () => this.confirmAll());
        const cancelButton = createButton("Cancel", "opi-button opi-button--quiet", () => this.cancel());
        keepAllButton.disabled = session.pending;
        cancelButton.disabled = session.pending;
        actions.append(openButton, keepAllButton, cancelButton);
        body.append(title, count, timer, actions);
        notice.append(preview, body);
        document.body.appendChild(notice);
        this.notice = notice;
    }

    renderOverlay() {
        const session = this.session;
        if (!session) return;

        const overlay = createElement("div", "opi-overlay");
        const dialog = createElement("section", "opi-dialog");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", session.title);

        overlay.addEventListener("keydown", (event) => this.handleKeyDown(event), true);
        overlay.addEventListener("keyup", (event) => event.stopPropagation(), true);
        overlay.addEventListener("keypress", (event) => event.stopPropagation(), true);

        const header = createElement("header", "opi-header");
        const headerCopy = createElement("div", "opi-header-copy");
        const title = createElement("h2", "opi-title", session.title);
        const subtitle = createElement(
            "div",
            "opi-subtitle",
            session.view === "detail"
                ? `Review and edit the prompt for this image`
                : `${session.items.length} generated image${session.items.length === 1 ? "" : "s"}`,
        );
        headerCopy.append(title, subtitle);
        const timer = createElement("div", "opi-timer");
        this.countdownElements.add(timer);
        const minimize = createIconButton(
            "Minimize picker",
            "opi-icon-button",
            ICONS.minimize,
            () => this.minimize(),
        );
        minimize.disabled = session.pending;
        header.append(headerCopy, timer, minimize);

        const main = createElement("main", "opi-main");
        if (session.view === "detail") this.renderDetail(main);
        else this.renderGallery(main);

        const footer = this.renderFooter();
        dialog.append(header, main, footer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        this.overlay = overlay;

        window.requestAnimationFrame(() => {
            const target = session.view === "detail"
                ? overlay.querySelector(".opi-textarea")
                : overlay.querySelector(".opi-thumbnail");
            target?.focus?.({ preventScroll: true });
        });
    }

    renderGallery(container) {
        const session = this.session;
        if (!session) return;
        const grid = createElement("div", "opi-grid");
        grid.setAttribute("role", "listbox");
        grid.setAttribute("aria-label", "Generated images");
        grid.setAttribute("aria-multiselectable", "true");

        session.items.forEach((item, position) => {
            const selected = session.selected.has(item.index);
            const card = createElement("article", "opi-card");
            card.dataset.selected = String(selected);
            card.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.openDetail(position);
            });

            const thumbnail = createButton(
                "",
                "opi-thumbnail",
                () => this.toggleSelection(item.index),
            );
            thumbnail.setAttribute("role", "option");
            thumbnail.setAttribute("aria-selected", String(selected));
            thumbnail.setAttribute("aria-label", `Prompt ${item.slot}: ${selected ? "selected" : "not selected"}`);
            const media = createElement("span", "opi-media");
            const imageSurface = createElement("span", "opi-media-image");
            imageSurface.style.backgroundImage = `url("${imageUrl(item.image, session.requestId)}")`;
            imageSurface.setAttribute("role", "img");
            imageSurface.setAttribute("aria-label", `Generated image for prompt ${item.slot}`);
            const badge = createElement("span", "opi-badge", `P${item.slot}`);
            const check = createElement("span", "opi-check");
            check.appendChild(createIcon(ICONS.check));
            media.append(imageSurface, badge, check);
            thumbnail.appendChild(media);

            const edit = createIconButton(
                `Open prompt ${item.slot}`,
                "opi-edit-button",
                ICONS.edit,
                (event) => {
                    event.stopPropagation();
                    this.openDetail(position);
                },
            );

            const meta = createElement("div", "opi-card-meta");
            const promptLabel = createElement("span", "opi-card-prompt", `Prompt ${item.slot}`);
            const dimensions = item.image.width && item.image.height
                ? createElement("span", "opi-card-dimensions", `${item.image.width}×${item.image.height}`)
                : null;
            meta.appendChild(promptLabel);
            if (dimensions) meta.appendChild(dimensions);
            card.append(thumbnail, edit, meta);
            grid.appendChild(card);
        });

        container.appendChild(grid);
    }

    renderDetail(container) {
        const session = this.session;
        if (!session) return;
        const position = Math.max(0, Math.min(session.detailPosition ?? 0, session.items.length - 1));
        session.detailPosition = position;
        const item = session.items[position];

        const detail = createElement("div", "opi-detail");
        const imagePanel = createElement("div", "opi-detail-image-panel");
        const image = createElement("img", "opi-detail-image");
        image.src = imageUrl(item.image, session.requestId);
        image.alt = `Generated image for prompt ${item.slot}`;
        image.draggable = false;
        const aspectRatio = createElement("div", "opi-detail-aspect", formatAspectRatio(item.image));
        imagePanel.append(image, aspectRatio);
        this.installDetailImageNavigation(imagePanel, image, item);
        imagePanel.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.leaveDetail();
        });

        const editor = createElement("div", "opi-detail-editor");
        const heading = createElement("div", "opi-detail-heading");
        const positionLabel = createElement(
            "div",
            "opi-detail-position",
            `Prompt ${item.slot} · Image ${position + 1} of ${session.items.length}`,
        );
        const selectedToggle = createElement("label", "opi-selected-toggle");
        const selectedInput = createElement("input");
        selectedInput.type = "checkbox";
        selectedInput.checked = session.selected.has(item.index);
        selectedInput.addEventListener("change", () => {
            this.setSelection(item.index, selectedInput.checked);
        });
        selectedToggle.append(selectedInput, document.createTextNode("Selected"));
        heading.append(positionLabel, selectedToggle);

        const positiveField = this.createPromptField(item, "positive", "Positive Prompt");
        editor.append(heading, positiveField);
        if (session.pairedMode) {
            editor.appendChild(this.createPromptField(item, "negative", "Negative Prompt"));
        }

        const hint = createElement(
            "div",
            "opi-hint",
            "Prompt edits affect the curated output. They do not regenerate the current image.",
        );
        const navigation = createElement("div", "opi-detail-nav");
        const previous = createButton("Previous", "opi-button", () => this.moveDetail(-1));
        const gallery = createButton("Back to gallery", "opi-button opi-button--primary", () => this.leaveDetail());
        const next = createButton("Next", "opi-button", () => this.moveDetail(1));
        previous.disabled = session.items.length <= 1 || session.pending;
        gallery.disabled = session.pending;
        next.disabled = session.items.length <= 1 || session.pending;
        navigation.append(previous, gallery, next);
        editor.append(hint, navigation);

        detail.append(imagePanel, editor);
        container.appendChild(detail);
    }

    installDetailImageNavigation(panel, image, item) {
        const state = {
            zoom: DETAIL_MIN_ZOOM,
            panX: 0,
            panY: 0,
            pointerId: null,
            lastX: 0,
            lastY: 0,
        };

        panel.title = "Mouse wheel to zoom · drag to move · right-click to return";
        panel.setAttribute(
            "aria-label",
            "Image detail. Use the mouse wheel to zoom, drag to move, and right-click to return to the gallery.",
        );

        const fittedImageSize = () => {
            const panelWidth = panel.clientWidth;
            const panelHeight = panel.clientHeight;
            const sourceWidth = image.naturalWidth || Number(item?.image?.width) || panelWidth;
            const sourceHeight = image.naturalHeight || Number(item?.image?.height) || panelHeight;
            if (panelWidth <= 0 || panelHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
                return { width: panelWidth, height: panelHeight };
            }
            const fit = Math.min(panelWidth / sourceWidth, panelHeight / sourceHeight);
            return { width: sourceWidth * fit, height: sourceHeight * fit };
        };

        const applyViewport = () => {
            const fitted = fittedImageSize();
            image.style.width = `${fitted.width}px`;
            image.style.height = `${fitted.height}px`;
            image.style.maxWidth = "none";
            image.style.maxHeight = "none";
            const maxPanX = Math.max(0, (fitted.width * state.zoom - panel.clientWidth) / 2);
            const maxPanY = Math.max(0, (fitted.height * state.zoom - panel.clientHeight) / 2);
            state.panX = Math.max(-maxPanX, Math.min(maxPanX, state.panX));
            state.panY = Math.max(-maxPanY, Math.min(maxPanY, state.panY));
            if (state.zoom <= DETAIL_MIN_ZOOM) {
                state.panX = 0;
                state.panY = 0;
            }
            image.style.transform = `translate3d(${state.panX}px, ${state.panY}px, 0) scale(${state.zoom})`;
            panel.dataset.zoomed = String(state.zoom > DETAIL_MIN_ZOOM);
            panel.dataset.dragging = String(state.pointerId !== null);
        };

        const onWheel = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const lineScale = event.deltaMode === 1
                ? 16
                : event.deltaMode === 2
                    ? Math.max(1, panel.clientHeight)
                    : 1;
            const nextZoom = Math.max(
                DETAIL_MIN_ZOOM,
                Math.min(
                    DETAIL_MAX_ZOOM,
                    state.zoom * Math.exp(-event.deltaY * lineScale * DETAIL_WHEEL_SENSITIVITY),
                ),
            );
            if (Math.abs(nextZoom - state.zoom) < 0.0001) return;

            const bounds = panel.getBoundingClientRect();
            const cursorX = event.clientX - bounds.left - bounds.width / 2;
            const cursorY = event.clientY - bounds.top - bounds.height / 2;
            const ratio = nextZoom / state.zoom;
            state.panX = cursorX - (cursorX - state.panX) * ratio;
            state.panY = cursorY - (cursorY - state.panY) * ratio;
            state.zoom = nextZoom;
            applyViewport();
        };

        const finishDrag = (event) => {
            if (state.pointerId === null || (event?.pointerId !== undefined && event.pointerId !== state.pointerId)) return;
            const pointerId = state.pointerId;
            state.pointerId = null;
            if (panel.hasPointerCapture?.(pointerId)) panel.releasePointerCapture(pointerId);
            applyViewport();
        };

        const onPointerDown = (event) => {
            if (event.button !== 0 || state.zoom <= DETAIL_MIN_ZOOM) return;
            event.preventDefault();
            state.pointerId = event.pointerId;
            state.lastX = event.clientX;
            state.lastY = event.clientY;
            panel.setPointerCapture?.(event.pointerId);
            applyViewport();
        };

        const onPointerMove = (event) => {
            if (state.pointerId !== event.pointerId) return;
            event.preventDefault();
            state.panX += event.clientX - state.lastX;
            state.panY += event.clientY - state.lastY;
            state.lastX = event.clientX;
            state.lastY = event.clientY;
            applyViewport();
        };

        const onPointerEnd = (event) => finishDrag(event);
        const onLostPointerCapture = (event) => finishDrag(event);
        const onImageLoad = () => applyViewport();

        panel.addEventListener("wheel", onWheel, { passive: false });
        panel.addEventListener("pointerdown", onPointerDown);
        panel.addEventListener("pointermove", onPointerMove);
        panel.addEventListener("pointerup", onPointerEnd);
        panel.addEventListener("pointercancel", onPointerEnd);
        panel.addEventListener("lostpointercapture", onLostPointerCapture);
        image.addEventListener("load", onImageLoad);

        const resizeObserver = typeof ResizeObserver === "function"
            ? new ResizeObserver(() => applyViewport())
            : null;
        resizeObserver?.observe(panel);
        const frameHandle = window.requestAnimationFrame(() => applyViewport());

        this.detailViewportCleanup = () => {
            window.cancelAnimationFrame?.(frameHandle);
            resizeObserver?.disconnect();
            panel.removeEventListener("wheel", onWheel);
            panel.removeEventListener("pointerdown", onPointerDown);
            panel.removeEventListener("pointermove", onPointerMove);
            panel.removeEventListener("pointerup", onPointerEnd);
            panel.removeEventListener("pointercancel", onPointerEnd);
            panel.removeEventListener("lostpointercapture", onLostPointerCapture);
            image.removeEventListener("load", onImageLoad);
        };
    }

    createPromptField(item, property, labelText) {
        const field = createElement("label", "opi-field");
        field.dataset.itemIndex = String(item.index);
        field.dataset.promptProperty = property;
        const label = createElement("span", "opi-label", labelText);
        const textarea = createElement("textarea", "opi-textarea");
        textarea.value = item[property];
        textarea.spellcheck = true;
        textarea.setAttribute("aria-label", `${labelText} for prompt ${item.slot}`);
        textarea.addEventListener("input", () => {
            item[property] = textarea.value;
            field.dataset.invalid = "false";
            this.scheduleTouch(item.index);
        });
        field.append(label, textarea);
        return field;
    }

    renderFooter() {
        const session = this.session;
        const footer = createElement("footer", "opi-footer");
        if (!session) return footer;

        const status = createElement("div", "opi-footer-status", session.status);
        status.dataset.kind = session.statusKind;
        status.setAttribute("role", "status");
        this.statusElements.add(status);
        const selectionCount = createElement(
            "div",
            "opi-selection-count",
            `${session.selected.size} of ${session.items.length} selected`,
        );
        const selectAll = createButton("Select all", "opi-button opi-button--quiet", () => {
            session.selected = new Set(session.items.map((item) => item.index));
            this.render();
            this.persistSession();
        });
        const clear = createButton("Clear", "opi-button opi-button--quiet", () => {
            session.selected.clear();
            this.render();
            this.persistSession();
        });
        const cancel = createButton("Cancel", "opi-button opi-button--danger", () => this.cancel());
        const confirm = createButton(
            "Confirm selection",
            "opi-button opi-button--primary opi-confirm-button",
            () => this.confirm(),
        );
        for (const button of [selectAll, clear, cancel]) button.disabled = session.pending;
        confirm.disabled = session.pending || session.selected.size === 0;
        footer.append(status, selectionCount, selectAll, clear, cancel, confirm);
        return footer;
    }

    handleKeyDown(event) {
        event.stopPropagation();
        if (!this.session) return;
        const isTextField = event.target instanceof HTMLTextAreaElement
            || event.target instanceof HTMLInputElement;

        if (event.key === "Escape") {
            event.preventDefault();
            if (this.session.view === "detail") this.leaveDetail();
            else this.minimize();
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            this.confirm();
            return;
        }

        if (this.session.view === "detail" && !isTextField) {
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                this.moveDetail(-1);
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                this.moveDetail(1);
            }
        }
    }

    setSelection(index, selected) {
        if (!this.session) return;
        if (selected) this.session.selected.add(index);
        else this.session.selected.delete(index);
        this.setStatus("");
        this.updateSelectionUi();
        this.persistSession();
    }

    updateSelectionUi() {
        if (!this.session) return;
        const count = `${this.session.selected.size} of ${this.session.items.length} selected`;
        for (const element of document.querySelectorAll(".opi-selection-count")) {
            if (this.overlay?.contains(element)) element.textContent = count;
        }
        const confirm = this.overlay?.querySelector(".opi-confirm-button");
        if (confirm instanceof HTMLButtonElement) {
            confirm.disabled = this.session.pending || this.session.selected.size === 0;
        }
    }

    toggleSelection(index) {
        if (!this.session || this.session.pending) return;
        this.setSelection(index, !this.session.selected.has(index));
        this.render();
    }

    async openDetail(position) {
        const session = this.session;
        if (!session || session.pending) return;
        session.detailPosition = position;
        session.view = "detail";
        this.render();
        this.persistSession();
        if (session.paused) return;

        try {
            const result = await this.postAction("pause");
            if (!this.session || this.session.requestId !== session.requestId) return;
            this.syncFromResponse(result, true);
            this.setStatus("");
        } catch (error) {
            this.setStatus(`Could not pause timeout: ${error.message}`, "error");
        }
    }

    async moveDetail(offset) {
        const session = this.session;
        if (!session || session.pending || session.items.length <= 1) return;
        await this.flushTouch();
        if (!this.session || this.session.requestId !== session.requestId) return;
        const current = session.detailPosition ?? 0;
        session.detailPosition = (current + offset + session.items.length) % session.items.length;
        this.render();
        this.persistSession();
    }

    async leaveDetail(options = {}) {
        const session = this.session;
        if (!session || session.pending) return;
        const requestId = session.requestId;
        const dirtyItems = this.takeDirtyItems();
        this.stopHeartbeat();

        try {
            const result = await this.postAction("resume", dirtyItems.length ? { items: dirtyItems } : {});
            if (!this.session || this.session.requestId !== requestId) return;
            session.view = options.compact ? "compact" : "gallery";
            session.detailPosition = null;
            this.syncFromResponse(result, false);
            this.setStatus("");
            this.render();
            this.persistSession();
        } catch (error) {
            if (!this.session || this.session.requestId !== requestId) return;
            dirtyItems.forEach((item) => this.dirtyIndexes.add(item.index));
            this.startHeartbeat();
            this.setStatus(`Could not resume timeout: ${error.message}`, "error");
        }
    }

    async minimize() {
        const session = this.session;
        if (!session || session.pending) return;
        if (session.view === "detail") {
            await this.leaveDetail({ compact: true });
            return;
        }
        session.view = "compact";
        this.render();
        this.persistSession();
    }

    scheduleTouch(index) {
        if (!this.session) return;
        this.dirtyIndexes.add(index);
        if (this.touchHandle !== null) window.clearTimeout(this.touchHandle);
        this.touchHandle = window.setTimeout(() => {
            this.touchHandle = null;
            this.persistSession();
            this.flushTouch();
        }, TOUCH_DELAY_MS);
    }

    takeDirtyItems() {
        if (!this.session || this.dirtyIndexes.size === 0) return [];
        this.dirtyIndexes.clear();
        return this.editedItems();
    }

    async flushTouch() {
        if (!this.session) return;
        if (this.touchHandle !== null) {
            window.clearTimeout(this.touchHandle);
            this.touchHandle = null;
        }
        const session = this.session;
        const items = this.takeDirtyItems();
        if (items.length === 0) return;
        try {
            const result = await this.postAction("touch", { items });
            if (this.session?.requestId === session.requestId) this.syncFromResponse(result, session.paused);
        } catch (error) {
            if (this.session?.requestId !== session.requestId) return;
            items.forEach((item) => this.dirtyIndexes.add(item.index));
            this.setStatus(`Prompt draft could not be synchronized: ${error.message}`, "error");
        }
    }

    startHeartbeat() {
        if (
            this.heartbeatHandle !== null
            || !this.session
            || (!this.session.paused && this.session.view !== "detail")
        ) return;
        this.heartbeatHandle = window.setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat() {
        if (this.heartbeatHandle === null) return;
        window.clearInterval(this.heartbeatHandle);
        this.heartbeatHandle = null;
    }

    async sendHeartbeat() {
        const session = this.session;
        if (!session || session.view !== "detail" || session.pending) return;
        try {
            const result = await this.postAction("heartbeat", { items: this.editedItems() });
            if (this.session?.requestId === session.requestId) this.syncFromResponse(result, true);
        } catch (error) {
            if (this.session?.requestId === session.requestId) {
                this.setStatus(`Editing heartbeat failed: ${error.message}`, "error");
            }
        }
    }

    syncFromResponse(result, fallbackPaused) {
        if (!this.session || !result || typeof result !== "object") return;
        const remaining = Number(result.remaining_seconds ?? result.remaining);
        const paused = typeof result.paused === "boolean" ? result.paused : fallbackPaused;
        this.syncTiming(Number.isFinite(remaining) ? remaining : this.currentRemaining(), paused);
    }

    editedItems(indexes = null) {
        if (!this.session) return [];
        const wanted = indexes ? new Set(indexes) : null;
        return this.session.items
            .filter((item) => !wanted || wanted.has(item.index))
            .map((item) => ({
                index: item.index,
                positive: item.positive,
                negative: item.negative,
            }));
    }

    validateSelection(selection) {
        if (!this.session) return { ok: false, message: "No picker session is active." };
        if (selection.length === 0) return { ok: false, message: "Select at least one image." };

        const selected = new Set(selection);
        const selectedItems = this.session.items.filter((item) => selected.has(item.index));
        const pairedOutput = selectedItems.some((item) => item.negative.trim().length > 0);

        for (let position = 0; position < this.session.items.length; position += 1) {
            const item = this.session.items[position];
            if (!selected.has(item.index)) continue;
            if (!item.positive.trim() && !item.negative.trim()) {
                return {
                    ok: false,
                    position,
                    property: "positive",
                    message: `Prompt ${item.slot} cannot be empty in both fields.`,
                };
            }
            if (/\r|\n/.test(item.positive) || /\r|\n/.test(item.negative)) {
                return {
                    ok: false,
                    position,
                    property: /\r|\n/.test(item.positive) ? "positive" : "negative",
                    message: `Prompt ${item.slot} must stay on one logical line. Soft wrapping is supported.`,
                };
            }
            if (pairedOutput && /;N[1-9]\d*=/.test(`${item.positive}\n${item.negative}`)) {
                return {
                    ok: false,
                    position,
                    property: /;N[1-9]\d*=/.test(item.positive) ? "positive" : "negative",
                    message: `Prompt ${item.slot} contains a reserved ;N<number>= marker.`,
                };
            }
        }
        return { ok: true };
    }

    showValidationError(validation) {
        if (!this.session) return;
        this.session.detailPosition = validation.position ?? 0;
        this.session.view = "detail";
        this.session.status = validation.message;
        this.session.statusKind = "error";
        this.render();
        window.requestAnimationFrame(() => {
            const selector = `.opi-field[data-item-index="${this.session?.items[validation.position]?.index}"][data-prompt-property="${validation.property}"]`;
            const field = this.overlay?.querySelector(selector);
            if (field) field.dataset.invalid = "true";
            field?.querySelector("textarea")?.focus?.();
        });
        if (!this.session.paused) {
            this.postAction("pause")
                .then((result) => this.syncFromResponse(result, true))
                .catch((error) => this.setStatus(`Could not pause timeout: ${error.message}`, "error"));
        }
    }

    async confirm() {
        const session = this.session;
        if (!session || session.pending) return;
        const selection = session.items
            .filter((item) => session.selected.has(item.index))
            .map((item) => item.index);
        await this.submitSelection(selection);
    }

    async confirmAll() {
        const session = this.session;
        if (!session || session.pending) return;
        const selection = session.items.map((item) => item.index);
        await this.submitSelection(selection);
    }

    async submitSelection(selection) {
        const session = this.session;
        if (!session || session.pending) return;
        const validation = this.validateSelection(selection);
        if (!validation.ok) {
            this.showValidationError(validation);
            return;
        }

        session.pending = true;
        this.render();
        const requestId = session.requestId;
        try {
            await this.postAction("confirm", {
                selection,
                items: this.editedItems(),
            });
            if (this.session?.requestId === requestId) {
                this.setStatus("Selection accepted. Finishing execution…");
            }
        } catch (error) {
            if (this.session?.requestId !== requestId) return;
            session.pending = false;
            this.setStatus(`Selection was not accepted: ${error.message}`, "error");
            this.render();
        }
    }

    async cancel() {
        const session = this.session;
        if (!session || session.pending) return;
        session.pending = true;
        this.render();
        const requestId = session.requestId;
        try {
            await this.postAction("cancel");
            if (this.session?.requestId === requestId) {
                this.setStatus("Cancel accepted. Finishing execution…");
            }
        } catch (error) {
            if (this.session?.requestId !== requestId) return;
            session.pending = false;
            this.setStatus(`Cancel was not accepted: ${error.message}`, "error");
            this.render();
        }
    }

    async postAction(action, extra = {}) {
        const session = this.session;
        if (!session) throw new Error("No picker session is active.");
        const response = await api.fetchApi(RESPONSE_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                request_id: session.requestId,
                token: session.token,
                prompt_id: session.promptId,
                node_id: session.nodeId,
                action,
                ...extra,
            }),
        });

        let result = {};
        try {
            result = await response.json();
        } catch {
            if (!response.ok) throw new Error(`Request failed (${response.status}).`);
        }
        if (!response.ok || result?.ok === false) {
            throw new Error(asString(result?.error || result?.message) || `Request failed (${response.status}).`);
        }
        return result;
    }

    closeLocal() {
        const focusTarget = this.lastFocusedElement;
        this.removeUiElements();
        this.stopHeartbeat();
        if (this.touchHandle !== null) {
            window.clearTimeout(this.touchHandle);
            this.touchHandle = null;
        }
        this.dirtyIndexes.clear();
        this.session = null;
        this.lastFocusedElement = null;
        try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* no-op */ }
        if (focusTarget?.isConnected) {
            window.requestAnimationFrame(() => focusTarget.focus?.({ preventScroll: true }));
        }
    }
}

let pickerUi = null;

app.registerExtension({
    name: EXTENSION_NAME,

    setup() {
        injectStyles();
        if (pickerUi) return;
        pickerUi = new PromptImagePickerUi();
        api.addEventListener(OPEN_EVENT, (event) => pickerUi?.handleOpen(event.detail));
        api.addEventListener(TICK_EVENT, (event) => pickerUi?.handleTick(event.detail));
        api.addEventListener(CLOSE_EVENT, (event) => pickerUi?.handleClose(event.detail));
        api.addEventListener("execution_interrupted", (event) => {
            pickerUi?.handleExecutionEnd(event.detail, "Image selection was interrupted.");
        });
        api.addEventListener("execution_error", (event) => {
            pickerUi?.handleExecutionEnd(event.detail, "Image selection ended because execution failed.");
        });
        pickerUi.restorePersistedSession();
    },
});
