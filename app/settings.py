import os
from dotenv import load_dotenv
import redis.asyncio


load_dotenv()

APP_ID = os.getenv("APP_ID", f"pid-{os.getpid()}")
REDIS_CHANNEL = "broadcast"


def _normalize_base_path(raw: str) -> str:
    """Public URL prefix as seen by the browser (e.g. /httpsticky). Empty if at domain root."""
    value = (raw or "").strip()
    if not value or value == "/":
        return ""
    return "/" + value.strip("/")


BASE_PATH = _normalize_base_path(os.getenv("BASE_PATH", ""))
COOKIE_PATH = BASE_PATH or "/"

redis = redis.asyncio.from_url("redis://redis:6379", decode_responses=True, db=1)
