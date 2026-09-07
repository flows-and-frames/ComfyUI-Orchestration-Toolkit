import re

from .prompt_storage import (
    PromptStorageError,
    validate_branch_source,
    validate_prompt_orchestrator_key,
)


ORCHESTRATOR_CLASS_TYPE = "PromptOrchestrator"
SAVE_CLASS_TYPE = "prompt_orchestration/save_string_for_orchestrator"
BRANCH_SOURCE_INPUTS = {
    "CuratedPrompts": "curated_prompts_folder",
    "GeneratedPrompts": "generated_prompts_folder",
}
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


def _prompt_node(prompt, node_id):
    if not isinstance(prompt, dict):
        return None
    return prompt.get(str(node_id), prompt.get(node_id))


def _linked_node_id(value, prompt):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    node_id, output_index = value
    if not isinstance(output_index, int):
        return None
    return node_id if _prompt_node(prompt, node_id) is not None else None


def _reachable_orchestrators(prompt, save_node_id):
    save_node = _prompt_node(prompt, save_node_id)
    if not isinstance(save_node, dict) or save_node.get("class_type") != SAVE_CLASS_TYPE:
        raise PromptStorageError("The current Save node could not be identified in the execution graph.")

    save_inputs = save_node.get("inputs")
    if not isinstance(save_inputs, dict):
        raise PromptStorageError("The current Save node has no valid execution inputs.")

    content_source = _linked_node_id(save_inputs.get("content"), prompt)
    if content_source is None:
        return []

    pending = [content_source]
    visited = set()
    orchestrators = set()

    while pending:
        node_id = pending.pop()
        normalized_id = str(node_id)
        if normalized_id in visited:
            continue
        visited.add(normalized_id)

        node = _prompt_node(prompt, node_id)
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == ORCHESTRATOR_CLASS_TYPE:
            orchestrators.add(normalized_id)
            continue

        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for value in inputs.values():
            upstream_id = _linked_node_id(value, prompt)
            if upstream_id is not None:
                pending.append(upstream_id)

    return sorted(orchestrators)


def _validated_filename_prefix(value):
    if not isinstance(value, str) or not value:
        raise PromptStorageError("filename_prefix must not be empty.")
    if len(value) > 180:
        raise PromptStorageError("filename_prefix is too long.")
    if value in {".", ".."} or ".." in value:
        raise PromptStorageError("filename_prefix must not contain traversal semantics.")
    if value[-1] in {" ", "."}:
        raise PromptStorageError("filename_prefix must not end with a space or dot.")
    if any(ord(character) < 32 for character in value):
        raise PromptStorageError("filename_prefix must not contain control characters.")
    if any(character in '<>:"/\\|?*\0' for character in value):
        raise PromptStorageError("filename_prefix contains a path or invalid filename character.")

    reserved_candidate = value.split(".", 1)[0].upper()
    if reserved_candidate in WINDOWS_RESERVED_NAMES:
        raise PromptStorageError("filename_prefix is a reserved Windows filename.")
    return value


def _next_counter(directory, prefix):
    pattern = re.compile(rf"^{re.escape(prefix)}_(\d{{5,}})_\.txt$")
    highest = 0
    try:
        entries = directory.iterdir()
        for entry in entries:
            if not entry.is_file() or entry.is_symlink():
                continue
            match = pattern.fullmatch(entry.name)
            if match:
                highest = max(highest, int(match.group(1)))
    except OSError as error:
        raise PromptStorageError(f"The PromptStorage branch cannot be scanned: {error}") from error
    return highest + 1


def _save_exact_text(directory, prefix, content):
    counter = _next_counter(directory, prefix)
    encoded_content = content.encode("utf-8")

    for _ in range(1_000_000):
        filename = f"{prefix}_{counter:05d}_.txt"
        target = directory / filename
        try:
            with target.open("xb") as output_file:
                output_file.write(encoded_content)
            return target
        except FileExistsError:
            counter += 1
        except OSError as error:
            raise PromptStorageError(f"The prompt could not be saved: {error}") from error

    raise PromptStorageError("No free sequential filename could be allocated.")


class SaveStringForOrchestrator:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "content": ("STRING", {"multiline": True, "forceInput": True}),
                "filename_prefix": ("STRING", {"default": "Prompt"}),
                "target_branch": (("CuratedPrompts", "GeneratedPrompts"),),
                "detected_prompt_orchestrator_key": ("STRING", {"default": ""}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filename",)
    FUNCTION = "save"
    CATEGORY = "prompt_orchestration"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return float("nan")

    def save(
        self,
        content,
        filename_prefix,
        target_branch,
        detected_prompt_orchestrator_key,
        prompt=None,
        unique_id=None,
    ):
        key = validate_prompt_orchestrator_key(detected_prompt_orchestrator_key)
        prefix = _validated_filename_prefix(filename_prefix)

        orchestrator_ids = _reachable_orchestrators(prompt, unique_id)
        if not orchestrator_ids:
            raise PromptStorageError(
                "No PromptOrchestrator is reachable from the current content input. Detect Orchestrator first."
            )
        if len(orchestrator_ids) > 1:
            raise PromptStorageError(
                "Multiple PromptOrchestrators are reachable from the current content input."
            )

        orchestrator = _prompt_node(prompt, orchestrator_ids[0])
        orchestrator_inputs = orchestrator.get("inputs", {})
        current_key = orchestrator_inputs.get("prompt_orchestrator_key")
        if current_key != key:
            raise PromptStorageError(
                "The detected PromptOrchestrator relationship is stale. Use Detect Orchestrator again."
            )

        source_input_name = BRANCH_SOURCE_INPUTS.get(target_branch)
        if source_input_name is None:
            raise PromptStorageError("Invalid PromptStorage branch.")
        source_value = orchestrator_inputs.get(source_input_name)
        if not isinstance(source_value, str):
            raise PromptStorageError(
                "The selected PromptOrchestrator source must be a direct folder value."
            )

        destination = validate_branch_source(key, target_branch, source_value)
        saved_content = str(content)
        saved_path = _save_exact_text(destination, prefix, saved_content)
        result = (str(saved_path),)

        return {
            "ui": {
                "saved_prompt_message": [
                    {
                        "prompt_orchestrator_key": key,
                        "content": saved_content,
                        "saved_path": str(saved_path),
                        "target_branch": target_branch,
                    }
                ]
            },
            "result": result,
        }
