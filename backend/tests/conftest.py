import os

import pytest


for variable in ("MEMORY_HUB_DATABASE", "MEMORY_HUB_TOKEN", "MEMORY_HUB_WEB_DIR"):
    os.environ.pop(variable, None)


@pytest.fixture(autouse=True)
def isolate_memory_hub_environment(monkeypatch):
    for name in (
        "MEMORY_HUB_DATABASE",
        "MEMORY_HUB_TOKEN",
        "MEMORY_HUB_WEB_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
