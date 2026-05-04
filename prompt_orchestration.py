import os
from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = "./js"


class PromptOrchestrator:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "curated_prompts_folder": ("STRING", {"default": ""}),
                "generated_prompts_folder": ("STRING", {"default": ""}),
                "multi_prompt_testing_editor": ("STRING", {"multiline": True}),
                "prompt_generation_editor": ("STRING", {"multiline": True}),
                "use_prompt_generation_branch": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("Multi-Prompt Testing Branch", "Prompt Generation Branch")
    FUNCTION = "run"
    CATEGORY = "Prompt"

    def run(
        self,
        curated_prompts_folder,
        generated_prompts_folder,
        multi_prompt_testing_editor,
        prompt_generation_editor,
        use_prompt_generation_branch
    ):
        if use_prompt_generation_branch:
            return (None, prompt_generation_editor)
        else:
            return (multi_prompt_testing_editor, None)


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
