from agent.memory_provider import MemoryProvider

from .client import HubClient
from .provider import build_provider_class

OmniMemoryProvider = build_provider_class(MemoryProvider, HubClient)


def register(ctx):
    ctx.register_memory_provider(OmniMemoryProvider())
