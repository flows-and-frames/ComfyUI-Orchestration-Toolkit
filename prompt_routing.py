import logging

import torch
from comfy_execution.graph_utils import ExecutionBlocker


PROMPT_MANIFEST_TYPE = "ORCHESTRATION_PROMPT_MANIFEST"
PROMPT_MANIFEST_SCHEMA_VERSION = 1
MAX_PROMPT_SLOTS = 10

_UNCONNECTED = object()
_LOGGER = logging.getLogger(__name__)


def _single_widget_value(value, name):
    if not isinstance(value, (list, tuple)) or len(value) != 1:
        raise ValueError(f"{name} must contain exactly one widget value.")
    return value[0]


def _normalise_prompt_lists(positive_prompts, negative_prompts):
    positives = list(positive_prompts)
    negatives = list(negative_prompts)

    if positives == [None] and negatives == [None]:
        return [], []

    if len(positives) != len(negatives):
        raise ValueError(
            "Positive Prompts and Negative Prompts must have the same number of items."
        )

    for index, (positive, negative) in enumerate(zip(positives, negatives), start=1):
        if not isinstance(positive, str) or not isinstance(negative, str):
            raise ValueError(
                f"Prompt item {index} must contain STRING values for Positive and Negative."
            )
        if not positive and not negative:
            raise ValueError(f"Prompt item {index} is empty in both Positive and Negative.")

    return positives, negatives


def _validate_manifest(manifest):
    if not isinstance(manifest, dict):
        raise ValueError("Prompt Manifest is invalid: expected a manifest object.")
    if manifest.get("schema_version") != PROMPT_MANIFEST_SCHEMA_VERSION:
        raise ValueError("Prompt Manifest uses an unsupported schema version.")
    if manifest.get("max_slots") != MAX_PROMPT_SLOTS:
        raise ValueError("Prompt Manifest has an incompatible slot capacity.")

    configured_branches = manifest.get("configured_branches")
    if (
        not isinstance(configured_branches, int)
        or isinstance(configured_branches, bool)
        or not 1 <= configured_branches <= MAX_PROMPT_SLOTS
    ):
        raise ValueError("Prompt Manifest contains an invalid Branches value.")

    slots = manifest.get("slots")
    if not isinstance(slots, (list, tuple)) or len(slots) != MAX_PROMPT_SLOTS:
        raise ValueError(
            f"Prompt Manifest must contain exactly {MAX_PROMPT_SLOTS} ordered slots."
        )

    for expected_slot, slot_data in enumerate(slots, start=1):
        if not isinstance(slot_data, dict) or slot_data.get("slot") != expected_slot:
            raise ValueError("Prompt Manifest slot order is invalid.")
        if not isinstance(slot_data.get("active"), bool):
            raise ValueError(f"Prompt Manifest slot {expected_slot} has no valid state.")

        positive = slot_data.get("positive")
        negative = slot_data.get("negative")
        if slot_data["active"]:
            if not isinstance(positive, str) or not isinstance(negative, str):
                raise ValueError(
                    f"Prompt Manifest slot {expected_slot} has invalid prompt values."
                )
            if not positive and not negative:
                raise ValueError(
                    f"Prompt Manifest slot {expected_slot} is active but empty."
                )
        elif positive is not None or negative is not None:
            raise ValueError(
                f"Prompt Manifest slot {expected_slot} is inactive but contains prompts."
            )

    return manifest


def _manifest_from_input(prompt_manifest):
    if isinstance(prompt_manifest, (list, tuple)):
        if len(prompt_manifest) != 1:
            raise ValueError("Prompt Collector requires exactly one Prompt Manifest.")
        prompt_manifest = prompt_manifest[0]
    return _validate_manifest(prompt_manifest)


def _active_slots(manifest):
    return [slot for slot in manifest["slots"] if slot["active"]]


def _lazy_value_is_missing(value):
    if value is None:
        return True
    return isinstance(value, (list, tuple)) and len(value) == 1 and value[0] is None


def _single_image(value, slot_number):
    if value is _UNCONNECTED:
        raise ValueError(
            f"Prompt Collector Image {slot_number} is not connected for active prompt slot "
            f"{slot_number}."
        )

    values = list(value) if isinstance(value, (list, tuple)) else [value]
    if len(values) != 1 or values[0] is None:
        raise ValueError(
            f"Prompt Collector Image {slot_number} must provide exactly one IMAGE item."
        )

    image = values[0]
    if not torch.is_tensor(image) or image.ndim != 4:
        raise ValueError(
            f"Prompt Collector Image {slot_number} must be an IMAGE tensor shaped [B,H,W,C]."
        )
    if image.shape[0] != 1:
        raise ValueError(
            f"Prompt Collector Image {slot_number} must contain exactly one image; "
            f"received batch size {image.shape[0]}."
        )
    return image


class PromptDistributor:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive_prompts": ("STRING", {"forceInput": True}),
                "negative_prompts": ("STRING", {"forceInput": True}),
                "branches": (
                    "INT",
                    {"default": 4, "min": 1, "max": MAX_PROMPT_SLOTS, "step": 1},
                ),
            }
        }

    RETURN_TYPES = (PROMPT_MANIFEST_TYPE,)
    RETURN_NAMES = ("Prompt Manifest",)
    INPUT_IS_LIST = True
    FUNCTION = "distribute"
    CATEGORY = "prompt_orchestration"

    def distribute(self, positive_prompts, negative_prompts, branches):
        branch_count = _single_widget_value(branches, "Branches")
        if (
            not isinstance(branch_count, int)
            or isinstance(branch_count, bool)
            or not 1 <= branch_count <= MAX_PROMPT_SLOTS
        ):
            raise ValueError(f"Branches must be between 1 and {MAX_PROMPT_SLOTS}.")

        positives, negatives = _normalise_prompt_lists(
            positive_prompts,
            negative_prompts,
        )
        source_count = len(positives)
        distributed_count = min(source_count, branch_count)
        truncated_count = max(0, source_count - branch_count)

        if truncated_count:
            first_ignored = branch_count + 1
            _LOGGER.warning(
                "Prompt Distributor: %d prompts found, but only %d branches are active. "
                "Prompts %d to %d were ignored.",
                source_count,
                branch_count,
                first_ignored,
                source_count,
            )

        slots = []
        for slot_number in range(1, MAX_PROMPT_SLOTS + 1):
            if slot_number <= distributed_count:
                slots.append(
                    {
                        "slot": slot_number,
                        "active": True,
                        "positive": positives[slot_number - 1],
                        "negative": negatives[slot_number - 1],
                    }
                )
            else:
                slots.append(
                    {
                        "slot": slot_number,
                        "active": False,
                        "positive": None,
                        "negative": None,
                    }
                )

        manifest = {
            "schema_version": PROMPT_MANIFEST_SCHEMA_VERSION,
            "max_slots": MAX_PROMPT_SLOTS,
            "source_count": source_count,
            "configured_branches": branch_count,
            "distributed_count": distributed_count,
            "truncated_count": truncated_count,
            "slots": slots,
        }
        return (manifest,)


class PromptSlotPicker:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_manifest": (PROMPT_MANIFEST_TYPE, {"forceInput": True}),
                "slot": (
                    "INT",
                    {"default": 1, "min": 1, "max": MAX_PROMPT_SLOTS, "step": 1},
                ),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("Positive Prompt", "Negative Prompt")
    FUNCTION = "pick"
    CATEGORY = "prompt_orchestration"

    def pick(self, prompt_manifest, slot):
        manifest = _validate_manifest(prompt_manifest)
        if not isinstance(slot, int) or isinstance(slot, bool) or not 1 <= slot <= MAX_PROMPT_SLOTS:
            raise ValueError(f"Slot must be between 1 and {MAX_PROMPT_SLOTS}.")

        slot_data = manifest["slots"][slot - 1]
        if not slot_data["active"]:
            blocker = ExecutionBlocker(None)
            return (blocker, blocker)

        return (slot_data["positive"], slot_data["negative"])


class PromptCollector:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_manifest": (PROMPT_MANIFEST_TYPE, {"forceInput": True}),
            },
            "optional": {
                f"image_{slot_number}": ("IMAGE", {"lazy": True})
                for slot_number in range(1, MAX_PROMPT_SLOTS + 1)
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = (
        "Images",
        "Positive Prompts",
        "Negative Prompts",
        "Prompt Count",
        "Active Slots",
    )
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True, True, True, False, False)
    FUNCTION = "collect"
    CATEGORY = "prompt_orchestration"

    def check_lazy_status(
        self,
        prompt_manifest,
        image_1=_UNCONNECTED,
        image_2=_UNCONNECTED,
        image_3=_UNCONNECTED,
        image_4=_UNCONNECTED,
        image_5=_UNCONNECTED,
        image_6=_UNCONNECTED,
        image_7=_UNCONNECTED,
        image_8=_UNCONNECTED,
        image_9=_UNCONNECTED,
        image_10=_UNCONNECTED,
    ):
        manifest = _manifest_from_input(prompt_manifest)
        images = {
            1: image_1,
            2: image_2,
            3: image_3,
            4: image_4,
            5: image_5,
            6: image_6,
            7: image_7,
            8: image_8,
            9: image_9,
            10: image_10,
        }

        needed = []
        for slot_data in _active_slots(manifest):
            slot_number = slot_data["slot"]
            value = images[slot_number]
            if value is _UNCONNECTED:
                raise ValueError(
                    f"Prompt Collector Image {slot_number} must be connected because prompt "
                    f"slot {slot_number} is active."
                )
            if _lazy_value_is_missing(value):
                needed.append(f"image_{slot_number}")
        return needed

    def collect(
        self,
        prompt_manifest,
        image_1=_UNCONNECTED,
        image_2=_UNCONNECTED,
        image_3=_UNCONNECTED,
        image_4=_UNCONNECTED,
        image_5=_UNCONNECTED,
        image_6=_UNCONNECTED,
        image_7=_UNCONNECTED,
        image_8=_UNCONNECTED,
        image_9=_UNCONNECTED,
        image_10=_UNCONNECTED,
    ):
        manifest = _manifest_from_input(prompt_manifest)
        active_slots = _active_slots(manifest)
        if not active_slots:
            blocker = ExecutionBlocker(None)
            return ([blocker], [blocker], [blocker], 0, "")

        image_inputs = {
            1: image_1,
            2: image_2,
            3: image_3,
            4: image_4,
            5: image_5,
            6: image_6,
            7: image_7,
            8: image_8,
            9: image_9,
            10: image_10,
        }

        images = []
        positive_prompts = []
        negative_prompts = []
        slot_numbers = []

        for slot_data in active_slots:
            slot_number = slot_data["slot"]
            images.append(_single_image(image_inputs[slot_number], slot_number))
            positive_prompts.append(slot_data["positive"])
            negative_prompts.append(slot_data["negative"])
            slot_numbers.append(slot_number)

        active_slots_text = ",".join(str(slot_number) for slot_number in slot_numbers)
        return (
            images,
            positive_prompts,
            negative_prompts,
            len(images),
            active_slots_text,
        )
