from .prompt_orchestration import PromptOrchestrator, WEB_DIRECTORY
from .dynamic_node_state_controller import NodeStateController

NODE_CLASS_MAPPINGS = {
    "PromptOrchestrator": PromptOrchestrator,
    "prompt_orchestration/node_state_controller": NodeStateController
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptOrchestrator": "PromptOrchestrator",
    "prompt_orchestration/node_state_controller": "Node State Controller"
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY"
]
