import os
from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = "./js"


class PromptOrchestrator:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_string_1": ("STRING", {"default": ""}),
                "folder_string_2": ("STRING", {"default": ""}),
                "editor_1": ("STRING", {"multiline": True}),
                "editor_2": ("STRING", {"multiline": True}),
                "use_editor_2": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("Editor 1", "Editor 2")
    FUNCTION = "run"
    CATEGORY = "Prompt"

    def run(self, folder_string_1, folder_string_2, editor_1, editor_2, use_editor_2):
        if use_editor_2:
            return (None, editor_2)
        else:
            return (editor_1, None)


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
