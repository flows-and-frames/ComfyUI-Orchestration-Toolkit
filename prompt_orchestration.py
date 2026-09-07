import os
import re
from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = "./js"

PROMPT_FORMAT_POSITIVE_ONLY = "Positive only"
PROMPT_FORMAT_POSITIVE_NEGATIVE = "Positive + Negative"
PROMPT_FORMATS = (
    PROMPT_FORMAT_POSITIVE_ONLY,
    PROMPT_FORMAT_POSITIVE_NEGATIVE,
)


def _non_empty_prompt_lines(value):
    lines = []
    for physical_line_number, raw_line in enumerate(str(value).splitlines(), start=1):
        line = raw_line.strip()
        if line:
            lines.append((physical_line_number, line))
    if not lines:
        raise ValueError("Prompt Testing is empty. Add at least one prompt line.")
    return lines


def _parse_positive_only(value):
    positive_prompts = [line for _, line in _non_empty_prompt_lines(value)]
    return positive_prompts, [""] * len(positive_prompts)


def _parse_positive_negative(value):
    positive_prompts = []
    negative_prompts = []

    for expected_index, (physical_line_number, line) in enumerate(
        _non_empty_prompt_lines(value),
        start=1,
    ):
        prefix_match = re.fullmatch(r"P([1-9]\d*)=(.*)", line)
        if not prefix_match or int(prefix_match.group(1)) != expected_index:
            raise ValueError(
                f"Prompt Testing line {physical_line_number} must start with P{expected_index}=."
            )

        remainder = prefix_match.group(2)
        negative_markers = re.findall(r";N([1-9]\d*)=", remainder)
        if negative_markers != [str(expected_index)]:
            raise ValueError(
                f"Prompt Testing line {physical_line_number} must contain exactly one "
                f";N{expected_index}= delimiter."
            )

        positive_prompt, negative_prompt = remainder.split(f";N{expected_index}=", 1)
        positive_prompt = positive_prompt.strip()
        negative_prompt = negative_prompt.strip()
        if not positive_prompt and not negative_prompt:
            raise ValueError(
                f"Prompt Testing line {physical_line_number} has no positive or negative prompt."
            )

        positive_prompts.append(positive_prompt)
        negative_prompts.append(negative_prompt)

    return positive_prompts, negative_prompts


class PromptOrchestrator:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "curated_prompts_folder": ("STRING", {"default": ""}),
                "generated_prompts_folder": ("STRING", {"default": ""}),
                "multi_prompt_testing_editor": ("STRING", {"multiline": True}),
                "prompt_generation_editor": ("STRING", {"multiline": True}),
                "use_prompt_generation_branch": ("BOOLEAN", {"default": True}),
                "system_prompt": ("STRING", {"multiline": True, "default": ""}),
                "prompt_orchestrator_key": ("STRING", {"default": ""}),
            },
            "optional": {
                "prompt_testing_format": (PROMPT_FORMATS, {"default": PROMPT_FORMAT_POSITIVE_ONLY}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = (
        "Positive Prompt",
        "Negative Prompt",
        "Prompt Generation",
        "System Prompt"
    )
    OUTPUT_IS_LIST = (True, True, False, False)
    FUNCTION = "run"
    CATEGORY = "prompt_orchestration"

    def run(
        self,
        curated_prompts_folder,
        generated_prompts_folder,
        multi_prompt_testing_editor,
        prompt_generation_editor,
        use_prompt_generation_branch,
        system_prompt,
        prompt_orchestrator_key,
        prompt_testing_format=PROMPT_FORMAT_POSITIVE_ONLY,
    ):
        if use_prompt_generation_branch:
            return ([None], [None], prompt_generation_editor, system_prompt)

        if prompt_testing_format == PROMPT_FORMAT_POSITIVE_ONLY:
            positive_prompts, negative_prompts = _parse_positive_only(
                multi_prompt_testing_editor
            )
        elif prompt_testing_format == PROMPT_FORMAT_POSITIVE_NEGATIVE:
            positive_prompts, negative_prompts = _parse_positive_negative(
                multi_prompt_testing_editor
            )
        else:
            raise ValueError(f"Unsupported Prompt Testing format: {prompt_testing_format}")

        return (positive_prompts, negative_prompts, None, system_prompt)


@PromptServer.instance.routes.post("/prompt_orchestration/load_latest")
async def load_latest(request):

    data = await request.json()
    folder_path = data.get("folder")

    if not folder_path:
        return web.json_response({"value": None})

    if not os.path.exists(folder_path):
        return web.json_response({"value": f"Ordner existiert nicht:\n{folder_path}"})

    try:
        files = [
            os.path.join(folder_path, f)
            for f in os.listdir(folder_path)
            if f.lower().endswith(".txt")
        ]

        if not files:
            return web.json_response({"value": "Keine .txt Dateien gefunden."})

        latest_file = max(files, key=os.path.getmtime)

        with open(latest_file, "r", encoding="utf-8") as file:
            content = file.read()

        return web.json_response({"value": content})

    except Exception as e:
        return web.json_response({"value": f"Fehler:\n{str(e)}"})
