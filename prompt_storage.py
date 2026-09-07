import json
import os
import re
import secrets
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from aiohttp import web
from server import PromptServer


STORAGE_VERSION = 1
STORAGE_ROOT_NAME = "PromptStorage"
BRANCH_NAMES = ("CuratedPrompts", "GeneratedPrompts")
KEY_PATTERN = re.compile(r"^po_[0-9a-f]{32}$")


class PromptStorageError(RuntimeError):
    pass


class DuplicateStorageError(PromptStorageError):
    pass


@dataclass(frozen=True)
class StorageRecord:
    key: str
    directory: Path
    curated_directory: Path
    generated_directory: Path
    created_at: str

    def as_response(self):
        return {
            "prompt_orchestrator_key": self.key,
            "storage_directory": str(self.directory),
            "curated_prompts_folder": str(self.curated_directory),
            "generated_prompts_folder": str(self.generated_directory),
            "created_at": self.created_at,
            "storage_version": STORAGE_VERSION,
        }


def toolkit_directory():
    return Path(__file__).resolve().parent


def prompt_storage_root():
    return toolkit_directory() / STORAGE_ROOT_NAME


def generate_prompt_orchestrator_key():
    return f"po_{secrets.token_hex(16)}"


def validate_prompt_orchestrator_key(value):
    if not isinstance(value, str) or not KEY_PATTERN.fullmatch(value):
        raise PromptStorageError("Invalid PromptOrchestrator key.")
    return value


def _is_relative_to(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _validated_root(create=False):
    toolkit = toolkit_directory()
    root = prompt_storage_root()

    if toolkit.is_symlink() or not toolkit.is_dir():
        raise PromptStorageError("The toolkit installation directory is not a safe directory.")

    toolkit_real = toolkit.resolve(strict=True)

    if not root.exists():
        if not create:
            return None
        try:
            root.mkdir()
        except FileExistsError:
            pass
        except OSError as error:
            raise PromptStorageError(f"PromptStorage cannot be created: {error}") from error

    if root.is_symlink() or not root.is_dir():
        raise PromptStorageError("PromptStorage must be a real directory, not a symlink.")

    root_real = root.resolve(strict=True)
    if root_real.parent != toolkit_real:
        raise PromptStorageError("PromptStorage resolves outside the toolkit directory.")

    return root_real


def _load_storage_record(storage_directory, root_real):
    if storage_directory.is_symlink() or not storage_directory.is_dir():
        raise PromptStorageError("Storage must be a real directory, not a symlink.")

    storage_real = storage_directory.resolve(strict=True)
    if storage_real.parent != root_real:
        raise PromptStorageError("Storage resolves outside PromptStorage.")

    metadata_path = storage_directory / "storage.json"
    if metadata_path.is_symlink() or not metadata_path.is_file():
        raise PromptStorageError("Storage metadata is missing or unsafe.")

    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PromptStorageError("Storage metadata is not valid UTF-8 JSON.") from error

    if not isinstance(metadata, dict):
        raise PromptStorageError("Storage metadata must be a JSON object.")

    key = validate_prompt_orchestrator_key(metadata.get("prompt_orchestrator_key"))

    if metadata.get("storage_version") != STORAGE_VERSION:
        raise PromptStorageError("Unsupported PromptStorage version.")

    created_at = metadata.get("created_at")
    if not isinstance(created_at, str):
        raise PromptStorageError("Storage metadata has no valid creation date.")
    try:
        date.fromisoformat(created_at)
    except ValueError as error:
        raise PromptStorageError("Storage metadata has no valid creation date.") from error

    branch_paths = {}
    for branch_name in BRANCH_NAMES:
        branch_path = storage_directory / branch_name
        if branch_path.is_symlink() or not branch_path.is_dir():
            raise PromptStorageError(f"{branch_name} is missing or unsafe.")
        branch_real = branch_path.resolve(strict=True)
        if branch_real.parent != storage_real or not _is_relative_to(branch_real, root_real):
            raise PromptStorageError(f"{branch_name} resolves outside its storage.")
        branch_paths[branch_name] = branch_real

    return StorageRecord(
        key=key,
        directory=storage_real,
        curated_directory=branch_paths["CuratedPrompts"],
        generated_directory=branch_paths["GeneratedPrompts"],
        created_at=created_at,
    )


def _matching_records(key):
    validate_prompt_orchestrator_key(key)
    root_real = _validated_root(create=False)
    if root_real is None:
        return [], []

    matches = []
    invalid_expected = []
    try:
        entries = list(root_real.iterdir())
    except OSError as error:
        raise PromptStorageError(f"PromptStorage cannot be read: {error}") from error

    for entry in entries:
        if not entry.is_dir() or entry.is_symlink():
            continue
        try:
            record = _load_storage_record(entry, root_real)
        except PromptStorageError as error:
            if entry.name.endswith(f"__{key}"):
                invalid_expected.append(f"{entry.name}: {error}")
            continue
        if record.key == key:
            matches.append(record)

    return matches, invalid_expected


def resolve_storage(key):
    matches, invalid_expected = _matching_records(key)
    if len(matches) > 1:
        raise DuplicateStorageError("Duplicate storage identity detected.")
    if len(matches) == 1:
        return matches[0]
    if invalid_expected:
        raise PromptStorageError(
            "A storage directory for this key exists, but its structure or metadata is invalid."
        )
    return None


def describe_storage(key, expected=False):
    validate_prompt_orchestrator_key(key)
    try:
        record = resolve_storage(key)
    except DuplicateStorageError as error:
        return {
            "state": "duplicate",
            "message": str(error),
            "prompt_orchestrator_key": key,
        }
    except PromptStorageError as error:
        return {
            "state": "invalid",
            "message": str(error),
            "prompt_orchestrator_key": key,
        }

    if record is not None:
        return {
            "state": "existing",
            "message": "PromptStorage found.",
            **record.as_response(),
        }

    return {
        "state": "missing" if expected else "none",
        "message": (
            "Previous PromptStorage was not found."
            if expected
            else "PromptStorage is not initialized."
        ),
        "prompt_orchestrator_key": key,
    }


def _cleanup_created_storage(storage_directory, created_paths):
    for path in reversed(created_paths):
        try:
            if path.is_symlink():
                continue
            if path.is_file():
                path.unlink()
            elif path.is_dir():
                path.rmdir()
        except OSError:
            pass
    try:
        if storage_directory.exists() and not storage_directory.is_symlink():
            storage_directory.rmdir()
    except OSError:
        pass


def create_storage(key):
    validate_prompt_orchestrator_key(key)
    root_real = _validated_root(create=True)

    existing = resolve_storage(key)
    if existing is not None:
        raise PromptStorageError("This PromptOrchestrator already has a valid storage.")

    storage_directory = root_real / f"{date.today().strftime('%d-%m-%Y')}__{key}"
    created_paths = []

    try:
        storage_directory.mkdir()
        for branch_name in BRANCH_NAMES:
            branch_path = storage_directory / branch_name
            branch_path.mkdir()
            created_paths.append(branch_path)

        metadata_path = storage_directory / "storage.json"
        metadata = {
            "prompt_orchestrator_key": key,
            "created_at": date.today().isoformat(),
            "storage_version": STORAGE_VERSION,
        }
        with metadata_path.open("x", encoding="utf-8", newline="\n") as metadata_file:
            json.dump(metadata, metadata_file, ensure_ascii=False, indent=2)
            metadata_file.write("\n")
        created_paths.append(metadata_path)
    except FileExistsError as error:
        _cleanup_created_storage(storage_directory, created_paths)
        raise PromptStorageError("The target PromptStorage directory already exists.") from error
    except OSError as error:
        _cleanup_created_storage(storage_directory, created_paths)
        raise PromptStorageError(f"PromptStorage could not be created: {error}") from error

    return _load_storage_record(storage_directory, root_real)


def initialize_storage(key, expected=False):
    status = describe_storage(key, expected=expected)
    if status["state"] == "existing":
        raise PromptStorageError("This PromptOrchestrator already has a valid storage.")
    if status["state"] == "duplicate":
        raise DuplicateStorageError(status["message"])
    if status["state"] == "invalid":
        raise PromptStorageError(status["message"])

    record = create_storage(key)
    return {
        "state": "created",
        "message": (
            "Storage recreated — previous files not found"
            if expected
            else "Storage initialized"
        ),
        **record.as_response(),
    }


def create_independent_storage():
    for _ in range(100):
        key = generate_prompt_orchestrator_key()
        if resolve_storage(key) is None:
            record = create_storage(key)
            return {
                "state": "created_independent",
                "message": "Independent PromptStorage created. Save nodes must detect again.",
                **record.as_response(),
            }
    raise PromptStorageError("A unique PromptOrchestrator key could not be generated.")


def validate_branch_source(key, branch_name, source_value):
    validate_prompt_orchestrator_key(key)
    if branch_name not in BRANCH_NAMES:
        raise PromptStorageError("Invalid PromptStorage branch.")
    if not isinstance(source_value, str) or not source_value.strip():
        raise PromptStorageError(
            "The selected PromptOrchestrator source folder is empty. Initialize Prompt Storage first."
        )

    record = resolve_storage(key)
    if record is None:
        raise PromptStorageError(
            "PromptOrchestrator storage is not initialized or valid. Initialize Prompt Storage first."
        )

    source_path = Path(source_value)
    if source_path.is_symlink():
        raise PromptStorageError("The selected source folder must not be a symlink.")
    try:
        source_real = source_path.resolve(strict=True)
    except OSError as error:
        raise PromptStorageError("The selected source folder does not exist.") from error

    expected_path = (
        record.curated_directory
        if branch_name == "CuratedPrompts"
        else record.generated_directory
    )
    if source_real != expected_path:
        raise PromptStorageError(
            "The selected source folder is not the verified PromptStorage branch owned by this PromptOrchestrator."
        )
    if not source_real.is_dir() or not os.access(source_real, os.W_OK):
        raise PromptStorageError("The selected PromptStorage branch is not writable.")

    return source_real


async def _request_json(request):
    try:
        data = await request.json()
    except Exception as error:
        raise PromptStorageError("The request body must be valid JSON.") from error
    if not isinstance(data, dict):
        raise PromptStorageError("The request body must be a JSON object.")
    return data


@PromptServer.instance.routes.post("/prompt_orchestration/storage/status")
async def prompt_storage_status(request):
    try:
        data = await _request_json(request)
        result = describe_storage(
            data.get("prompt_orchestrator_key"),
            expected=data.get("expected") is True,
        )
        return web.json_response(result)
    except PromptStorageError as error:
        return web.json_response({"error": str(error)}, status=400)


@PromptServer.instance.routes.post("/prompt_orchestration/storage/action")
async def prompt_storage_action(request):
    try:
        data = await _request_json(request)
        action = data.get("action")
        if action == "initialize":
            result = initialize_storage(
                data.get("prompt_orchestrator_key"),
                expected=data.get("expected") is True,
            )
        elif action == "independent":
            result = create_independent_storage()
        else:
            raise PromptStorageError("Unknown PromptStorage action.")
        return web.json_response(result)
    except DuplicateStorageError as error:
        return web.json_response({"state": "duplicate", "error": str(error)}, status=409)
    except PromptStorageError as error:
        return web.json_response({"error": str(error)}, status=400)
    except OSError as error:
        return web.json_response(
            {"error": f"PromptStorage filesystem operation failed: {error}"},
            status=500,
        )
