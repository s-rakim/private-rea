"""Python client for Tailchat, the end-to-end encrypted messenger on your tailnet."""

__version__ = "0.1.0"

from .api import ApiError, Client, Session  # noqa: E402,F401
from .state import State  # noqa: E402,F401
