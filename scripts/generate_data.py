#!/usr/bin/env python3
"""
Generuje frontend/data.json a frontend/params.json z aktuálních dat ČNB a Eurostatu.

Spouštěno z GitHub Actions (i lokálně pro testování statické verze).

Použití:
    python scripts/generate_data.py

Výstup:
    frontend/data.json   – časové řady (dates, actual_rate, cpi, gdp, pistar, generated_at)
    frontend/params.json – OLS-odhadnuté parametry Taylorova pravidla
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Cesty ──────────────────────────────────────────────────────────────────
ROOT    = Path(__file__).parent.parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"

sys.path.insert(0, str(BACKEND))

# Monkey-patch cache modulu PŘED importem data_fetcher.
# V CI nechceme používat soubory z .cache/ – chceme vždy čerstvá data.
import cache  # noqa: E402
cache.get_cached = lambda key: None
cache.set_cached  = lambda key, val: None

import httpx                          # noqa: E402
from data_fetcher import fetch_all_data  # noqa: E402
from taylor import calibrate_ols     # noqa: E402


def _series_to_list(series) -> list:
    """Převede pandas Series na Python list; NaN → None."""
    result = []
    for v in series:
        try:
            import math
            if math.isnan(float(v)):
                result.append(None)
            else:
                result.append(round(float(v), 4))
        except (TypeError, ValueError):
            result.append(None)
    return result


def main() -> None:
    print("Stahuji data z ČNB a Eurostatu…")

    with httpx.Client(timeout=90.0) as client:
        store = fetch_all_data(client)

    df = store.get("dataframe")
    if df is None or df.empty:
        raise RuntimeError("Nepodařilo se stáhnout data – DataFrame je prázdný.")

    print(
        f"  Načteno: {len(df)} měsíců "
        f"({df.index.min().strftime('%Y-%m')} – {df.index.max().strftime('%Y-%m')})"
    )

    # ── data.json ─────────────────────────────────────────────────────────
    data_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dates":        [d.strftime("%Y-%m") for d in df.index],
        "actual_rate":  _series_to_list(df["actual_rate"]),
        "cpi":          _series_to_list(df["cpi"]),
        "gdp":          _series_to_list(df["gdp"]),
        "pistar":       _series_to_list(df["pistar"]),
    }

    data_path = FRONTEND / "data.json"
    data_path.write_text(
        json.dumps(data_payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_kb = data_path.stat().st_size // 1024
    print(f"  Zapsáno: {data_path}  ({size_kb} kB)")

    # ── params.json ───────────────────────────────────────────────────────
    print("Kalibrace OLS parametrů…")
    params = calibrate_ols(df)
    params_payload = dict(params)

    params_path = FRONTEND / "params.json"
    params_path.write_text(
        json.dumps(params_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"  Zapsáno: {params_path}")
    print(f"  Parametry: {params_payload}")

    print("Hotovo ✓")


if __name__ == "__main__":
    main()
