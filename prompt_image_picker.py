from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import logging
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time
from typing import Any
import uuid

from aiohttp import web
import folder_paths
import torch

from comfy.model_management import (
    InterruptProcessingException,
    throw_exception_if_processing_interrupted,
)
from comfy_execution.utils import get_executing_context
from nodes import PreviewImage
from server import PromptServer


PICKER_SCHEMA_VERSION = 1
MAX_PICKER_ITEMS = 10

PICKER_OPEN_EVENT = "prompt_orchestration:image_picker_open"
PICKER_TICK_EVENT = "prompt_orchestration:image_picker_tick"
PICKER_CLOSE_EVENT = "prompt_orchestration:image_picker_close"
PICKER_RESPONSE_ROUTE = "/prompt_orchestration/image_picker/respond"

DISPLAY_MODES = ("Open picker", "Compact notification")
TIMEOUT_ACTIONS = ("Keep all", "Cancel")

_STATE_DIRECTORY_NAME = "orchestration_toolkit_prompt_image_picker"
_REQUEST_ID_PATTERN = re.compile(r"[0-9a-f]{32}\Z")
_RESERVED_NEGATIVE_MARKER = re.compile(r";N[1-9]\d*=")
_TERMINAL_STATES = frozenset({"confirmed", "cancelled", "timed_out", "interrupted"})
_ALLOWED_STATES = frozenset({"waiting", *_TERMINAL_STATES})
_ALLOWED_ACTIONS = frozenset({"pause", "heartbeat", "resume", "touch", "confirm", "cancel"})
_POLL_INTERVAL_SECONDS = 0.25
_TICK_INTERVAL_SECONDS = 1.0
_PAUSE_LEASE_SECONDS = 90.0
_MAX_PROMPT_CHARACTERS = 32_768
_MAX_PROTOCOL_BYTES = 4 * 1024 * 1024
_LOGGER = logging.getLogger(__name__)
# ComfyUI execution and HTTP handlers share one server process but may use different threads.
_STATE_LOCK = threading.RLock()


class PickerProtocolError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _stat_is_link_or_reparse(file_stat: os.stat_result) -> bool:
    reparse_attribute = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    file_attributes = getattr(file_stat, "st_file_attributes", 0)
    return stat.S_ISLNK(file_stat.st_mode) or bool(
        reparse_attribute and file_attributes & reparse_attribute
    )


def _path_is_link_or_reparse(path: Path) -> bool:
    try:
        return _stat_is_link_or_reparse(os.lstat(path))
    except FileNotFoundError:
        return False


def _state_root() -> Path:
    temp_root = Path(folder_paths.get_temp_directory()).resolve(strict=True)
    candidate = temp_root / _STATE_DIRECTORY_NAME

    if _path_is_link_or_reparse(candidate):
        raise RuntimeError("Prompt Image Picker state directory must not be a symlink.")

    candidate.mkdir(mode=0o700, exist_ok=True)
    resolved = candidate.resolve(strict=True)
    if resolved.parent != temp_root or resolved.name != _STATE_DIRECTORY_NAME:
        raise RuntimeError("Prompt Image Picker state directory escaped the ComfyUI temp directory.")
    candidate_stat = os.lstat(candidate)
    if _stat_is_link_or_reparse(candidate_stat) or not stat.S_ISDIR(
        candidate_stat.st_mode
    ):
        raise RuntimeError("Prompt Image Picker state directory is invalid.")
    return resolved


def _normalise_request_id(value: Any) -> str:
    if not isinstance(value, str) or _REQUEST_ID_PATTERN.fullmatch(value) is None:
        raise PickerProtocolError(400, "Invalid Prompt Image Picker request ID.")
    return value


def _request_state_path(request_id: str) -> Path:
    request_id = _normalise_request_id(request_id)
    root = _state_root()
    state_path = root / f"{request_id}.json"

    if state_path.parent != root or state_path.name != f"{request_id}.json":
        raise RuntimeError("Invalid Prompt Image Picker state path.")
    return state_path


def _no_follow_flag() -> int:
    return getattr(os, "O_NOFOLLOW", 0)


def _assert_regular_or_missing(path: Path) -> None:
    try:
        file_stat = os.lstat(path)
    except FileNotFoundError:
        return
    if _stat_is_link_or_reparse(file_stat) or not stat.S_ISREG(file_stat.st_mode):
        raise RuntimeError(f"Unsafe Prompt Image Picker state entry: {path.name}")


@contextmanager
def _request_lock(request_id: str):
    _normalise_request_id(request_id)
    with _STATE_LOCK:
        yield


def _atomic_write_state(request_id: str, state: dict[str, Any]) -> None:
    state_path = _request_state_path(request_id)
    _assert_regular_or_missing(state_path)

    encoded = json.dumps(
        state,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    if len(encoded) > _MAX_PROTOCOL_BYTES:
        raise RuntimeError("Prompt Image Picker state exceeds the supported size.")

    root = _state_root()
    temporary_path = root / f".{request_id}.{uuid.uuid4().hex}.tmp"
    descriptor = None
    try:
        descriptor = os.open(
            temporary_path,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | _no_follow_flag(),
            0o600,
        )
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = None
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, state_path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary_stat = os.lstat(temporary_path)
        except FileNotFoundError:
            temporary_stat = None
        if temporary_stat is not None:
            if _stat_is_link_or_reparse(temporary_stat) or not stat.S_ISREG(
                temporary_stat.st_mode
            ):
                raise RuntimeError("Unsafe Prompt Image Picker temporary state entry.")
            os.unlink(temporary_path)


def _read_state(request_id: str) -> dict[str, Any]:
    state_path = _request_state_path(request_id)
    _assert_regular_or_missing(state_path)
    flags = os.O_RDONLY | _no_follow_flag()
    try:
        descriptor = os.open(state_path, flags)
    except FileNotFoundError as exc:
        raise PickerProtocolError(404, "Prompt Image Picker request is no longer active.") from exc

    try:
        file_stat = os.fstat(descriptor)
        if _stat_is_link_or_reparse(file_stat) or not stat.S_ISREG(file_stat.st_mode):
            raise RuntimeError("Prompt Image Picker state entry is not a regular file.")
        if file_stat.st_size > _MAX_PROTOCOL_BYTES:
            raise RuntimeError("Prompt Image Picker state exceeds the supported size.")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = None
            payload = handle.read(_MAX_PROTOCOL_BYTES + 1)
    finally:
        if descriptor is not None:
            os.close(descriptor)

    if len(payload) > _MAX_PROTOCOL_BYTES:
        raise RuntimeError("Prompt Image Picker state exceeds the supported size.")
    try:
        state = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Prompt Image Picker state is not valid JSON.") from exc
    if not isinstance(state, dict):
        raise RuntimeError("Prompt Image Picker state must be a JSON object.")
    return state


def _safe_unlink(path: Path) -> None:
    root = _state_root()
    if path.parent != root:
        raise RuntimeError("Refusing to remove a Prompt Image Picker path outside its state directory.")
    try:
        file_stat = os.lstat(path)
    except FileNotFoundError:
        return
    if _stat_is_link_or_reparse(file_stat) or not stat.S_ISREG(file_stat.st_mode):
        raise RuntimeError(f"Refusing to remove unsafe Prompt Image Picker entry: {path.name}")
    os.unlink(path)


def _cleanup_request_files(request_id: str) -> None:
    state_path = _request_state_path(request_id)
    with _request_lock(request_id):
        _safe_unlink(state_path)


def _validate_state_identity(
    state: dict[str, Any],
    *,
    request_id: str,
    token: str,
    prompt_id: str,
    node_id: str,
    client_id: str | None = None,
) -> None:
    if state.get("schema_version") != PICKER_SCHEMA_VERSION:
        raise RuntimeError("Prompt Image Picker state uses an unsupported schema version.")
    if state.get("request_id") != request_id:
        raise RuntimeError("Prompt Image Picker state request ID does not match its filename.")
    stored_token = state.get("token")
    if not isinstance(stored_token, str) or not secrets.compare_digest(stored_token, token):
        raise PickerProtocolError(403, "Prompt Image Picker request token does not match.")
    if state.get("prompt_id") != prompt_id or state.get("node_id") != node_id:
        raise PickerProtocolError(409, "Prompt Image Picker execution identity does not match.")
    if client_id is not None and state.get("client_id") != client_id:
        raise RuntimeError("Prompt Image Picker client identity changed unexpectedly.")

    status_value = state.get("status")
    if status_value not in _ALLOWED_STATES:
        raise RuntimeError("Prompt Image Picker state contains an invalid status.")
    item_count = state.get("item_count")
    if (
        not isinstance(item_count, int)
        or isinstance(item_count, bool)
        or not 1 <= item_count <= MAX_PICKER_ITEMS
    ):
        raise RuntimeError("Prompt Image Picker state contains an invalid item count.")


def _increment_revision(state: dict[str, Any]) -> None:
    revision = state.get("revision", 0)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise RuntimeError("Prompt Image Picker state contains an invalid revision.")
    state["revision"] = revision + 1


def _advance_clock(state: dict[str, Any], now: float) -> bool:
    if state.get("status") != "waiting":
        return False

    changed = False
    if state.get("paused"):
        paused_at = state.get("paused_at_monotonic")
        lease_until = state.get("pause_lease_until_monotonic")
        deadline = state.get("deadline_monotonic")
        if not all(isinstance(value, (int, float)) for value in (paused_at, lease_until, deadline)):
            raise RuntimeError("Prompt Image Picker pause state is invalid.")
        if now >= float(lease_until):
            paused_duration = max(0.0, float(lease_until) - float(paused_at))
            state["deadline_monotonic"] = float(deadline) + paused_duration
            state["paused"] = False
            state["paused_at_monotonic"] = None
            state["pause_lease_until_monotonic"] = None
            changed = True

    if not state.get("paused"):
        deadline = state.get("deadline_monotonic")
        if not isinstance(deadline, (int, float)):
            raise RuntimeError("Prompt Image Picker deadline is invalid.")
        if now >= float(deadline):
            state["status"] = "timed_out"
            changed = True

    return changed


def _remaining_seconds(state: dict[str, Any], now: float | None = None) -> float:
    now = time.monotonic() if now is None else now
    deadline = state.get("deadline_monotonic")
    if not isinstance(deadline, (int, float)):
        raise RuntimeError("Prompt Image Picker deadline is invalid.")
    reference = now
    if state.get("paused"):
        paused_at = state.get("paused_at_monotonic")
        if not isinstance(paused_at, (int, float)):
            raise RuntimeError("Prompt Image Picker pause timestamp is invalid.")
        reference = float(paused_at)
    return max(0.0, float(deadline) - reference)


def _normalise_prompt_text(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise PickerProtocolError(422, f"{name} must be text.")
    if len(value) > _MAX_PROMPT_CHARACTERS:
        raise PickerProtocolError(422, f"{name} is too long.")
    if "\x00" in value:
        raise PickerProtocolError(422, f"{name} contains an unsupported null character.")
    return value.strip()


def _normalise_items(
    value: Any,
    item_count: int,
    negative_mode: bool,
) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) != item_count:
        raise PickerProtocolError(422, "Prompt Image Picker response must contain every prompt item.")

    by_index: dict[int, dict[str, Any]] = {}
    for raw_item in value:
        if not isinstance(raw_item, dict):
            raise PickerProtocolError(422, "Prompt Image Picker item must be an object.")
        index = raw_item.get("index")
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or not 0 <= index < item_count
            or index in by_index
        ):
            raise PickerProtocolError(422, "Prompt Image Picker item index is invalid or duplicated.")

        positive = _normalise_prompt_text(raw_item.get("positive"), f"Positive Prompt {index + 1}")
        negative = _normalise_prompt_text(raw_item.get("negative", ""), f"Negative Prompt {index + 1}")
        if not negative_mode and negative:
            raise PickerProtocolError(
                422,
                "A Negative Prompt cannot be added to a positive-only picker request.",
            )
        by_index[index] = {
            "index": index,
            "positive": positive,
            "negative": negative,
        }

    if set(by_index) != set(range(item_count)):
        raise PickerProtocolError(422, "Prompt Image Picker response item order is incomplete.")
    return [by_index[index] for index in range(item_count)]


def _normalise_selection(value: Any, item_count: int) -> list[int]:
    if not isinstance(value, list) or not value:
        raise PickerProtocolError(422, "Select at least one image before confirming.")
    selection: set[int] = set()
    for index in value:
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or not 0 <= index < item_count
            or index in selection
        ):
            raise PickerProtocolError(422, "Prompt Image Picker selection is invalid or duplicated.")
        selection.add(index)
    return sorted(selection)


def _validate_selected_prompts(
    items: list[dict[str, Any]],
    selection: list[int],
) -> None:
    selected_items = [items[index] for index in selection]
    for item in selected_items:
        if not item["positive"] and not item["negative"]:
            raise PickerProtocolError(
                422,
                f"Selected Prompt {item['index'] + 1} is empty in both fields.",
            )
        if any("\r" in item[field] or "\n" in item[field] for field in ("positive", "negative")):
            raise PickerProtocolError(
                422,
                f"Selected Prompt {item['index'] + 1} must contain one logical line per field.",
            )

    if any(item["negative"] for item in selected_items):
        for item in selected_items:
            if _RESERVED_NEGATIVE_MARKER.search(item["positive"]) or _RESERVED_NEGATIVE_MARKER.search(
                item["negative"]
            ):
                raise PickerProtocolError(
                    422,
                    "Prompt text contains a reserved ;N<number>= marker.",
                )


def _set_draft_items(state: dict[str, Any], payload: dict[str, Any]) -> bool:
    if "items" not in payload:
        return False
    items = _normalise_items(
        payload["items"],
        state["item_count"],
        bool(state.get("negative_mode")),
    )
    state["draft_items"] = items
    return True


def _pause_state(state: dict[str, Any], now: float) -> None:
    if not state.get("paused"):
        state["paused"] = True
        state["paused_at_monotonic"] = now
    state["pause_lease_until_monotonic"] = now + _PAUSE_LEASE_SECONDS


def _resume_state(state: dict[str, Any], now: float) -> bool:
    if not state.get("paused"):
        return False
    paused_at = state.get("paused_at_monotonic")
    deadline = state.get("deadline_monotonic")
    if not isinstance(paused_at, (int, float)) or not isinstance(deadline, (int, float)):
        raise RuntimeError("Prompt Image Picker pause state is invalid.")
    state["deadline_monotonic"] = float(deadline) + max(0.0, now - float(paused_at))
    state["paused"] = False
    state["paused_at_monotonic"] = None
    state["pause_lease_until_monotonic"] = None
    return True


def _handle_picker_action(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise PickerProtocolError(400, "Prompt Image Picker response must be a JSON object.")
    if payload.get("schema_version", PICKER_SCHEMA_VERSION) != PICKER_SCHEMA_VERSION:
        raise PickerProtocolError(400, "Unsupported Prompt Image Picker protocol version.")

    request_id = _normalise_request_id(payload.get("request_id"))
    token = payload.get("token")
    prompt_id = payload.get("prompt_id")
    node_id = payload.get("node_id")
    action = payload.get("action")
    if not isinstance(token, str) or not 20 <= len(token) <= 256:
        raise PickerProtocolError(400, "Invalid Prompt Image Picker request token.")
    if not isinstance(prompt_id, str) or not prompt_id:
        raise PickerProtocolError(400, "Invalid Prompt Image Picker prompt ID.")
    if not isinstance(node_id, str) or not node_id:
        raise PickerProtocolError(400, "Invalid Prompt Image Picker node ID.")
    if action not in _ALLOWED_ACTIONS:
        raise PickerProtocolError(400, "Unsupported Prompt Image Picker action.")

    with _request_lock(request_id):
        state = _read_state(request_id)
        _validate_state_identity(
            state,
            request_id=request_id,
            token=token,
            prompt_id=prompt_id,
            node_id=node_id,
        )

        now = time.monotonic()
        changed = _advance_clock(state, now)
        if state["status"] != "waiting":
            if changed:
                _increment_revision(state)
                _atomic_write_state(request_id, state)
            raise PickerProtocolError(409, "Prompt Image Picker request is already closed.")

        if action == "pause":
            changed = _set_draft_items(state, payload) or changed
            _pause_state(state, now)
            changed = True
        elif action == "heartbeat":
            changed = _set_draft_items(state, payload) or changed
            _pause_state(state, now)
            changed = True
        elif action == "resume":
            changed = _set_draft_items(state, payload) or changed
            changed = _resume_state(state, now) or changed
        elif action == "touch":
            changed = _set_draft_items(state, payload) or changed
            if state.get("paused"):
                state["pause_lease_until_monotonic"] = now + _PAUSE_LEASE_SECONDS
                changed = True
        elif action == "confirm":
            if "items" not in payload:
                raise PickerProtocolError(422, "Confirm requires every edited prompt item.")
            items = _normalise_items(
                payload["items"],
                state["item_count"],
                bool(state.get("negative_mode")),
            )
            selection = _normalise_selection(payload.get("selection"), state["item_count"])
            _validate_selected_prompts(items, selection)
            state["draft_items"] = items
            state["response"] = {
                "selection": selection,
                "items": items,
            }
            state["status"] = "confirmed"
            state["paused"] = False
            state["paused_at_monotonic"] = None
            state["pause_lease_until_monotonic"] = None
            changed = True
        elif action == "cancel":
            state["status"] = "cancelled"
            state["response"] = None
            state["paused"] = False
            state["paused_at_monotonic"] = None
            state["pause_lease_until_monotonic"] = None
            changed = True

        if changed:
            _increment_revision(state)
            _atomic_write_state(request_id, state)

        return {
            "ok": True,
            "remaining_seconds": round(_remaining_seconds(state, now), 3),
            "paused": bool(state.get("paused")),
            "closed": state["status"] in _TERMINAL_STATES,
        }


@PromptServer.instance.routes.post(PICKER_RESPONSE_ROUTE)
async def prompt_image_picker_response(request):
    try:
        raw_body = await request.read()
        if len(raw_body) > _MAX_PROTOCOL_BYTES:
            return web.json_response(
                {"ok": False, "error": "Prompt Image Picker response is too large."},
                status=413,
            )
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise PickerProtocolError(400, "Prompt Image Picker response is not valid JSON.")
        result = await asyncio.to_thread(_handle_picker_action, payload)
        return web.json_response(result)
    except PickerProtocolError as exc:
        return web.json_response({"ok": False, "error": exc.message}, status=exc.status)
    except Exception:
        _LOGGER.exception("Prompt Image Picker response handling failed.")
        return web.json_response(
            {"ok": False, "error": "Prompt Image Picker response handling failed."},
            status=500,
        )


def _single_input_value(value: Any, name: str) -> Any:
    if not isinstance(value, (list, tuple)) or len(value) != 1:
        raise ValueError(f"{name} must contain exactly one widget value.")
    return value[0]


def _source_prompt(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a STRING value.")
    if len(value) > _MAX_PROMPT_CHARACTERS:
        raise ValueError(f"{name} is too long.")
    if "\r" in value or "\n" in value or "\x00" in value:
        raise ValueError(f"{name} must contain one logical line.")
    return value.strip()


def _normalise_picker_inputs(
    images: Any,
    positive_prompts: Any,
    negative_prompts: Any,
) -> tuple[list[torch.Tensor], list[str], list[str]]:
    if not isinstance(images, (list, tuple)):
        raise ValueError("Images must be provided as a ComfyUI IMAGE list.")
    if not isinstance(positive_prompts, (list, tuple)) or not isinstance(
        negative_prompts, (list, tuple)
    ):
        raise ValueError("Positive Prompts and Negative Prompts must be ComfyUI lists.")

    image_list = list(images)
    positive_list = list(positive_prompts)
    negative_list = list(negative_prompts)
    if not 1 <= len(image_list) <= MAX_PICKER_ITEMS:
        raise ValueError(f"Prompt Image Picker requires between 1 and {MAX_PICKER_ITEMS} images.")
    if len(positive_list) != len(image_list) or len(negative_list) != len(image_list):
        raise ValueError(
            "Images, Positive Prompts and Negative Prompts must contain the same number of items."
        )

    clean_positives: list[str] = []
    clean_negatives: list[str] = []
    for index, image in enumerate(image_list, start=1):
        if not torch.is_tensor(image) or image.ndim != 4:
            raise ValueError(f"Image {index} must be an IMAGE tensor shaped [1,H,W,C].")
        if image.shape[0] != 1:
            raise ValueError(f"Image {index} must contain exactly one image.")
        if image.shape[1] <= 0 or image.shape[2] <= 0 or image.shape[3] not in (3, 4):
            raise ValueError(f"Image {index} has an unsupported IMAGE shape.")

        positive = _source_prompt(positive_list[index - 1], f"Positive Prompt {index}")
        negative = _source_prompt(negative_list[index - 1], f"Negative Prompt {index}")
        if not positive and not negative:
            raise ValueError(f"Prompt item {index} is empty in both Positive and Negative.")
        clean_positives.append(positive)
        clean_negatives.append(negative)

    return image_list, clean_positives, clean_negatives


def _create_previews(images: list[torch.Tensor]) -> list[dict[str, Any]]:
    preview_node = PreviewImage()
    previews: list[dict[str, Any]] = []
    for index, image in enumerate(images, start=1):
        result = preview_node.save_images(image, filename_prefix="PromptImagePicker")
        image_descriptors = result.get("ui", {}).get("images", [])
        if not isinstance(image_descriptors, list) or len(image_descriptors) != 1:
            raise RuntimeError(f"Prompt Image Picker could not create preview {index}.")
        descriptor = image_descriptors[0]
        if not isinstance(descriptor, dict):
            raise RuntimeError(f"Prompt Image Picker preview {index} is invalid.")
        filename = descriptor.get("filename")
        subfolder = descriptor.get("subfolder", "")
        image_type = descriptor.get("type")
        if not isinstance(filename, str) or not isinstance(subfolder, str) or image_type != "temp":
            raise RuntimeError(f"Prompt Image Picker preview {index} is invalid.")
        previews.append(
            {
                "filename": filename,
                "subfolder": subfolder,
                "type": "temp",
                "width": int(image.shape[2]),
                "height": int(image.shape[1]),
            }
        )
    return previews


def _format_chosen_prompt(
    items: list[dict[str, Any]],
    selection: list[int],
) -> str:
    _validate_selected_prompts(items, selection)
    selected_items = [items[index] for index in selection]
    if all(not item["negative"] for item in selected_items):
        return "\n".join(item["positive"] for item in selected_items)
    return "\n".join(
        f"P{output_index}={item['positive']};N{output_index}={item['negative']}"
        for output_index, item in enumerate(selected_items, start=1)
    )


def _result_from_selection(
    images: list[torch.Tensor],
    items: list[dict[str, Any]],
    selection: list[int],
) -> tuple[str, list[torch.Tensor], str]:
    ordered_selection = sorted(selection)
    chosen_prompt = _format_chosen_prompt(items, ordered_selection)
    selected_images = [images[index] for index in ordered_selection]
    indexes = ",".join(str(index) for index in ordered_selection)
    return chosen_prompt, selected_images, indexes


def _create_request_state(
    *,
    request_id: str,
    token: str,
    prompt_id: str,
    node_id: str,
    execution_node_id: str,
    client_id: str,
    timeout_seconds: int,
    on_timeout: str,
    display_mode: str,
    positives: list[str],
    negatives: list[str],
) -> dict[str, Any]:
    now = time.monotonic()
    items = [
        {
            "index": index,
            "positive": positive,
            "negative": negative,
        }
        for index, (positive, negative) in enumerate(zip(positives, negatives))
    ]
    return {
        "schema_version": PICKER_SCHEMA_VERSION,
        "request_id": request_id,
        "token": token,
        "prompt_id": prompt_id,
        "node_id": node_id,
        "execution_node_id": execution_node_id,
        "client_id": client_id,
        "item_count": len(items),
        "negative_mode": any(negative for negative in negatives),
        "timeout_seconds": timeout_seconds,
        "on_timeout": on_timeout,
        "display_mode": display_mode,
        "created_at_epoch": time.time(),
        "deadline_monotonic": now + timeout_seconds,
        "paused": False,
        "paused_at_monotonic": None,
        "pause_lease_until_monotonic": None,
        "status": "waiting",
        "draft_items": items,
        "response": None,
        "revision": 0,
    }


def _persist_new_request(state: dict[str, Any]) -> None:
    request_id = state["request_id"]
    state_path = _request_state_path(request_id)
    with _request_lock(request_id):
        _assert_regular_or_missing(state_path)
        if state_path.exists():
            raise RuntimeError("Prompt Image Picker request ID collision.")
        _atomic_write_state(request_id, state)


def _poll_request_state(
    *,
    request_id: str,
    token: str,
    prompt_id: str,
    node_id: str,
    client_id: str,
) -> dict[str, Any]:
    with _request_lock(request_id):
        state = _read_state(request_id)
        _validate_state_identity(
            state,
            request_id=request_id,
            token=token,
            prompt_id=prompt_id,
            node_id=node_id,
            client_id=client_id,
        )
        if _advance_clock(state, time.monotonic()):
            _increment_revision(state)
            _atomic_write_state(request_id, state)
        return state


class PromptImagePicker:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"forceInput": True}),
                "positive_prompts": ("STRING", {"forceInput": True}),
                "negative_prompts": ("STRING", {"forceInput": True}),
                "timeout": (
                    "INT",
                    {"default": 600, "min": 1, "max": 86400, "step": 1},
                ),
                "on_timeout": (TIMEOUT_ACTIONS, {"default": "Keep all"}),
                "display_mode": (DISPLAY_MODES, {"default": "Open picker"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "STRING")
    RETURN_NAMES = ("Chosen Prompt", "Images", "Indexes")
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (False, True, False)
    FUNCTION = "pick"
    CATEGORY = "prompt_orchestration"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def pick(
        self,
        images,
        positive_prompts,
        negative_prompts,
        timeout,
        on_timeout,
        display_mode,
        unique_id,
    ):
        image_list, positives, negatives = _normalise_picker_inputs(
            images,
            positive_prompts,
            negative_prompts,
        )
        timeout_value = _single_input_value(timeout, "Timeout")
        on_timeout_value = _single_input_value(on_timeout, "On Timeout")
        display_mode_value = _single_input_value(display_mode, "Display Mode")
        frontend_node_id = str(_single_input_value(unique_id, "Unique ID"))

        if (
            not isinstance(timeout_value, int)
            or isinstance(timeout_value, bool)
            or not 1 <= timeout_value <= 86400
        ):
            raise ValueError("Timeout must be between 1 and 86400 seconds.")
        if on_timeout_value not in TIMEOUT_ACTIONS:
            raise ValueError("Unsupported Prompt Image Picker timeout action.")
        if display_mode_value not in DISPLAY_MODES:
            raise ValueError("Unsupported Prompt Image Picker display mode.")

        execution_context = get_executing_context()
        if execution_context is None or not execution_context.prompt_id:
            raise RuntimeError("Prompt Image Picker requires an active ComfyUI execution context.")
        prompt_id = str(execution_context.prompt_id)
        execution_node_id = str(execution_context.node_id)

        server = PromptServer.instance
        client_id = server.client_id
        initial_items = [
            {"index": index, "positive": positive, "negative": negative}
            for index, (positive, negative) in enumerate(zip(positives, negatives))
        ]
        all_indices = list(range(len(image_list)))

        if not isinstance(client_id, str) or not client_id or client_id not in server.sockets:
            raise RuntimeError(
                "Prompt Image Picker requires the initiating ComfyUI browser client to be connected."
            )

        previews = _create_previews(image_list)
        request_id = uuid.uuid4().hex
        token = secrets.token_urlsafe(32)
        state = _create_request_state(
            request_id=request_id,
            token=token,
            prompt_id=prompt_id,
            node_id=frontend_node_id,
            execution_node_id=execution_node_id,
            client_id=client_id,
            timeout_seconds=timeout_value,
            on_timeout=on_timeout_value,
            display_mode=display_mode_value,
            positives=positives,
            negatives=negatives,
        )
        _persist_new_request(state)

        open_items = [
            {
                "index": index,
                "slot": index + 1,
                "image": previews[index],
                "positive": positives[index],
                "negative": negatives[index],
            }
            for index in range(len(image_list))
        ]
        server.send_sync(
            PICKER_OPEN_EVENT,
            {
                "schema_version": PICKER_SCHEMA_VERSION,
                "request_id": request_id,
                "token": token,
                "prompt_id": prompt_id,
                "node_id": frontend_node_id,
                "title": "Prompt Image Picker",
                "display_mode": display_mode_value,
                "timeout_seconds": timeout_value,
                "on_timeout": on_timeout_value,
                "remaining_seconds": float(timeout_value),
                "paused": False,
                "negative_mode": any(negatives),
                "items": open_items,
            },
            client_id,
        )

        close_reason = "error"
        primary_exception: BaseException | None = None
        next_tick = 0.0
        try:
            while True:
                throw_exception_if_processing_interrupted()
                current_state = _poll_request_state(
                    request_id=request_id,
                    token=token,
                    prompt_id=prompt_id,
                    node_id=frontend_node_id,
                    client_id=client_id,
                )
                status_value = current_state["status"]
                if status_value in _TERMINAL_STATES:
                    break

                now = time.monotonic()
                if now >= next_tick:
                    server.send_sync(
                        PICKER_TICK_EVENT,
                        {
                            "request_id": request_id,
                            "prompt_id": prompt_id,
                            "node_id": frontend_node_id,
                            "remaining_seconds": round(_remaining_seconds(current_state, now), 3),
                            "paused": bool(current_state.get("paused")),
                        },
                        client_id,
                    )
                    next_tick = now + _TICK_INTERVAL_SECONDS
                time.sleep(_POLL_INTERVAL_SECONDS)

            throw_exception_if_processing_interrupted()
            if status_value == "confirmed":
                response = current_state.get("response")
                if not isinstance(response, dict):
                    raise RuntimeError("Prompt Image Picker confirmation response is missing.")
                items = _normalise_items(
                    response.get("items"),
                    len(image_list),
                    bool(current_state.get("negative_mode")),
                )
                selection = _normalise_selection(response.get("selection"), len(image_list))
                _validate_selected_prompts(items, selection)
                close_reason = "confirmed"
                return _result_from_selection(image_list, items, selection)

            if status_value == "cancelled":
                close_reason = "cancelled"
                raise InterruptProcessingException()
            if status_value == "timed_out":
                if on_timeout_value == "Cancel":
                    close_reason = "timeout_cancel"
                    raise InterruptProcessingException()
                close_reason = "timeout_keep_all"
                draft_items = current_state.get("draft_items")
                try:
                    validated_drafts = _normalise_items(
                        draft_items,
                        len(image_list),
                        bool(current_state.get("negative_mode")),
                    )
                    return _result_from_selection(image_list, validated_drafts, all_indices)
                except PickerProtocolError:
                    _LOGGER.warning(
                        "Prompt Image Picker timed out with invalid drafts; using original prompts."
                    )
                    return _result_from_selection(image_list, initial_items, all_indices)
            if status_value == "interrupted":
                close_reason = "interrupted"
                raise InterruptProcessingException()
            raise RuntimeError("Prompt Image Picker reached an unsupported terminal state.")
        except BaseException as exc:
            primary_exception = exc
            if isinstance(exc, InterruptProcessingException) and close_reason == "error":
                close_reason = "interrupted"
            raise
        finally:
            cleanup_error = None
            try:
                _cleanup_request_files(request_id)
            except Exception as exc:
                cleanup_error = exc
                _LOGGER.exception("Prompt Image Picker request cleanup failed.")
            finally:
                try:
                    server.send_sync(
                        PICKER_CLOSE_EVENT,
                        {
                            "request_id": request_id,
                            "prompt_id": prompt_id,
                            "node_id": frontend_node_id,
                            "reason": close_reason,
                        },
                        client_id,
                    )
                except Exception:
                    _LOGGER.exception("Prompt Image Picker close notification failed.")
            if cleanup_error is not None and primary_exception is None:
                raise RuntimeError("Prompt Image Picker request cleanup failed.") from cleanup_error
