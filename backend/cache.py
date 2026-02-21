"""Souborový JSON cache s TTL pro ukládání stažených dat."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

CACHE_DIR = Path(__file__).parent.parent / ".cache"
TTL_SECONDS = 86400  # 24 hodin


def _cache_path(key: str) -> Path:
    CACHE_DIR.mkdir(exist_ok=True)
    return CACHE_DIR / f"{key}.json"


def get_cached(key: str) -> Optional[dict]:
    path = _cache_path(key)
    if not path.exists():
        return None
    with open(path) as f:
        data = json.load(f)
    if time.time() - data["timestamp"] > TTL_SECONDS:
        return None
    return data["payload"]


def set_cached(key: str, payload: dict) -> None:
    path = _cache_path(key)
    with open(path, "w") as f:
        json.dump({"timestamp": time.time(), "payload": payload}, f)


def get_cache_info(key: str) -> dict:
    path = _cache_path(key)
    if not path.exists():
        return {"exists": False, "age_hours": None}
    with open(path) as f:
        data = json.load(f)
    age_hours = (time.time() - data["timestamp"]) / 3600
    return {"exists": True, "age_hours": round(age_hours, 1), "timestamp": data["timestamp"]}
