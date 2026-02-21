"""
FastAPI backend pro aplikaci Taylorovo pravidlo pro ČNB.

Endpointy:
  GET /api/data          – všechny časové řady
  GET /api/taylor        – implikovaná sazba + statistiky
  GET /api/default-params – OLS-odhadnuté parametry
  GET /api/status        – stav dat a cache
  GET /                  – statický frontend
"""
from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from cache import get_cache_info
from data_fetcher import fetch_all_data
from taylor import TaylorParams, calculate_taylor, calibrate_ols, compute_stats

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s – %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger(__name__)

# Globální datový store (načte se při startu)
_store: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Stáhne data při startu aplikace."""
    log.info("Spouštím aplikaci – stahuji data...")
    try:
        with httpx.Client() as client:
            _store.update(fetch_all_data(client))
        log.info("Data připravena.")
    except Exception as e:
        log.error(f"Chyba při stahování dat: {e}")
        log.warning("Aplikace poběží bez dat – zkontrolujte připojení k internetu.")
    yield
    log.info("Aplikace se ukončuje.")


app = FastAPI(
    title="Taylorovo pravidlo pro ČNB",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ─── Pomocné funkce ─────────────────────────────────────────────────────────

def _get_df() -> pd.DataFrame:
    df = _store.get("dataframe")
    if df is None or df.empty:
        raise HTTPException(status_code=503, detail="Data nejsou dostupná. Zkontrolujte připojení.")
    return df


def _safe_float(v) -> Optional[float]:
    try:
        f = float(v)
        return None if pd.isna(f) else round(f, 4)
    except (TypeError, ValueError):
        return None


def _filter_df(df: pd.DataFrame, date_from: str, date_to: str) -> pd.DataFrame:
    try:
        start = pd.to_datetime(date_from)
        end = pd.to_datetime(date_to) + pd.offsets.MonthEnd(0)
    except Exception:
        return df
    return df[(df.index >= start) & (df.index <= end)]


# ─── API endpointy ──────────────────────────────────────────────────────────

@app.get("/api/data")
def get_data():
    """Vrátí všechny časové řady jako JSON."""
    df = _get_df()
    return JSONResponse({
        "dates": [d.strftime("%Y-%m") for d in df.index],
        "actual_rate": [_safe_float(v) for v in df["actual_rate"]],
        "cpi": [_safe_float(v) for v in df["cpi"]],
        "gdp": [_safe_float(v) for v in df["gdp"]],
        "pistar": [_safe_float(v) for v in df["pistar"]],
    })


@app.get("/api/taylor")
def get_taylor(
    rho: float = Query(0.80, ge=0.0, le=0.99, description="Parametr setrvačnosti"),
    rstar: float = Query(1.5, ge=-2.0, le=5.0, description="Neutrální reálná sazba (%)"),
    alpha: float = Query(1.5, ge=0.0, le=3.0, description="Váha inflační mezery"),
    beta: float = Query(0.5, ge=0.0, le=3.0, description="Váha reálného růstu HDP"),
    date_from: str = Query("2000-01", description="Začátek období (YYYY-MM)"),
    date_to: str = Query("2026-12", description="Konec období (YYYY-MM)"),
):
    """Vrátí implikovanou repo sazbu dle Taylorova pravidla + statistiky."""
    df = _get_df()
    df_filtered = _filter_df(df, date_from, date_to)

    if df_filtered.empty:
        raise HTTPException(400, "Zvolené období neobsahuje žádná data.")

    implied = calculate_taylor(df_filtered, rho=rho, rstar=rstar, alpha=alpha, beta=beta)
    stats = compute_stats(df_filtered["actual_rate"], implied)

    return JSONResponse({
        "dates": [d.strftime("%Y-%m") for d in implied.index],
        "implied_rate": [_safe_float(v) for v in implied],
        "stats": stats,
    })


@app.get("/api/default-params")
def get_default_params():
    """Vrátí OLS-odhadnuté výchozí parametry Taylorova pravidla."""
    df = _get_df()
    params = calibrate_ols(df)
    return JSONResponse(dict(params))


@app.get("/api/status")
def get_status():
    """Vrátí stav dat: cache informace, počet observací, časový rozsah."""
    df = _store.get("dataframe")
    return JSONResponse({
        "repo_cache": get_cache_info("repo_rate"),
        "cpi_cache": get_cache_info("cpi"),
        "gdp_cache": get_cache_info("gdp"),
        "observations": len(df) if df is not None else 0,
        "date_range": {
            "from": df.index.min().strftime("%Y-%m") if df is not None and len(df) > 0 else None,
            "to": df.index.max().strftime("%Y-%m") if df is not None and len(df) > 0 else None,
        },
        "server_time": datetime.now().isoformat(),
        "data_available": df is not None and not df.empty,
    })


# ─── Statický frontend ───────────────────────────────────────────────────────

_FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
if _FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIR), html=True), name="frontend")
else:
    log.warning(f"Frontend adresář nenalezen: {_FRONTEND_DIR}")


# ─── Hlavní spuštění ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
