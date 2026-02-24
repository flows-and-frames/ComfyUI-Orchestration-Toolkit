from .prompt_orchestration import PromptOrchestrator, WEB_DIRECTORY
from .dynamic_node_state_controller import DynamicNodeStateController

NODE_CLASS_MAPPINGS = {
    "PromptOrchestrator": PromptOrchestrator,
    "prompt_orchestration/dynamic_node_state_controller": DynamicNodeStateController
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptOrchestrator": "PromptOrchestrator",
    "prompt_orchestration/dynamic_node_state_controller": "Dynamic Node State Controller"
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY"
]
