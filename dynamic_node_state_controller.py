class DynamicNodeStateController:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {}
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "prompt_orchestration"

    def noop(self):
        return ()
