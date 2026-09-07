from .prompt_orchestration import PromptOrchestrator, WEB_DIRECTORY
from .node_state_controller import NodeStateController
from .save_string_for_orchestrator import SaveStringForOrchestrator
from .prompt_image_picker import PromptImagePicker
from .prompt_routing import PromptCollector, PromptDistributor, PromptSlotPicker
from . import prompt_storage as _prompt_storage

NODE_CLASS_MAPPINGS = {
    "PromptOrchestrator": PromptOrchestrator,
    "prompt_orchestration/node_state_controller": NodeStateController,
    "prompt_orchestration/save_string_for_orchestrator": SaveStringForOrchestrator,
    "prompt_orchestration/prompt_distributor": PromptDistributor,
    "prompt_orchestration/prompt_slot_picker": PromptSlotPicker,
    "prompt_orchestration/prompt_collector": PromptCollector,
    "prompt_orchestration/prompt_image_picker": PromptImagePicker
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptOrchestrator": "PromptOrchestrator",
    "prompt_orchestration/node_state_controller": "Node State Controller",
    "prompt_orchestration/save_string_for_orchestrator": "Save String for Orchestrator",
    "prompt_orchestration/prompt_distributor": "Prompt Distributor",
    "prompt_orchestration/prompt_slot_picker": "Prompt Slot Picker",
    "prompt_orchestration/prompt_collector": "Prompt Collector",
    "prompt_orchestration/prompt_image_picker": "Prompt Image Picker"
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY"
]
