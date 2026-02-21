"""
Stahování dat z veřejných zdrojů:

- 2T repo sazba ČNB: TXT soubor z webu ČNB
- CPI meziroční %: Eurostat HICP (prc_hicp_midx)
- HDP meziroční %: Eurostat (namq_10_gdp), výpočet YoY z indexu

Strategie: API → cache (24h TTL). Fallback na statické CSV soubory.
"""
from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Optional

import httpx
import pandas as pd

from cache import get_cached, set_cached

log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data"

# --- Inflační cíl ČNB (hardcoded historické hodnoty) ---
_PISTAR = [
    ("2000-01-01", "2001-12-31", 4.0),
    ("2002-01-01", "2009-12-31", 3.0),
    ("2010-01-01", "2099-12-31", 2.0),
]


def build_pistar_series(index: pd.DatetimeIndex) -> pd.Series:
    """Sestaví časovou řadu inflačního cíle ČNB pro daný DatetimeIndex."""
    values = []
    for d in index:
        target = 2.0
        for start, end, val in _PISTAR:
            if pd.Timestamp(start) <= d <= pd.Timestamp(end):
                target = val
                break
        values.append(target)
    return pd.Series(values, index=index, name="pistar")


# --- Repo sazba ČNB ---

def _parse_repo_txt(text: str) -> pd.Series:
    """Parsuje TXT soubor s historií repo sazby z ČNB."""
    text = text.lstrip("\ufeff")  # strip BOM
    df = pd.read_csv(io.StringIO(text), sep="|", decimal=",")
    df.columns = ["date_str", "rate"]
    df["date"] = pd.to_datetime(df["date_str"].astype(str), format="%Y%m%d")
    df = df[["date", "rate"]].set_index("date").sort_index()
    return df["rate"]


def fetch_repo_rate(client: httpx.Client) -> pd.Series:
    """
    Stáhne historii 2T repo sazby z ČNB.
    Vrátí měsíční časovou řadu (forward-fill od data změny).
    """
    cached = get_cached("repo_rate")
    if cached:
        log.info("Repo sazba: načteno z cache")
        s = pd.Series(cached["values"], index=pd.to_datetime(cached["dates"]))
        s.index = s.index + pd.offsets.MonthEnd(0)
        return s

    url = "https://www.cnb.cz/cs/casto-kladene-dotazy/.galleries/vyvoj_repo_historie.txt"
    try:
        log.info("Stahování repo sazby z ČNB...")
        r = client.get(url, timeout=30, follow_redirects=True)
        r.raise_for_status()
        changes = _parse_repo_txt(r.content.decode("utf-8"))
    except Exception as e:
        log.warning(f"Stahování repo sazby selhalo: {e}, zkouším fallback CSV")
        changes = _load_fallback_csv("repo_rate", index_col="date", value_col="rate")
        if changes is None:
            raise RuntimeError("Repo sazba není dostupná (API ani fallback CSV)") from e

    # Převod na měsíční frekvenci (forward-fill od data poslední změny)
    monthly_idx = pd.date_range("2000-01-01", "2026-12-31", freq="ME")
    # Pro každý měsíc najdeme poslední platnou sazbu (ffill)
    # Reindex raw changes series to daily, then resample to month-end
    daily_idx = pd.date_range(changes.index.min(), "2026-12-31", freq="D")
    daily = changes.reindex(daily_idx).ffill()
    monthly = daily.resample("ME").last()
    monthly = monthly[monthly.index >= "2000-01-01"]

    set_cached("repo_rate", {
        "dates": [d.isoformat() for d in monthly.index],
        "values": [round(float(v), 4) if pd.notna(v) else None for v in monthly],
    })
    return monthly


# --- CPI (HICP Eurostat) ---

def _parse_eurostat_jsonstat(data: dict) -> pd.Series:
    """Parsuje Eurostat JSON-STAT1 formát."""
    time_dim = data["dimension"]["time"]
    time_index = time_dim["category"]["index"]  # {period: int_pos}
    vals_raw = data["value"]  # dict {str_pos: value}

    series_vals = {}
    for period, pos in time_index.items():
        v = vals_raw.get(str(pos))
        if v is not None:
            series_vals[period] = float(v)
    return pd.Series(series_vals)


def fetch_cpi(client: httpx.Client) -> pd.Series:
    """
    Stáhne HICP CPI pro ČR z Eurostat (prc_hicp_midx).
    Vrátí meziroční % změnu na měsíční frekvenci.
    """
    cached = get_cached("cpi")
    if cached:
        log.info("CPI: načteno z cache")
        s = pd.Series(cached["values"], index=pd.to_datetime(cached["dates"]))
        s.index = s.index + pd.offsets.MonthEnd(0)
        return s

    url = (
        "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"
        "prc_hicp_midx?geo=CZ&unit=I15&coicop=CP00&freq=M"
    )
    try:
        log.info("Stahování CPI z Eurostat...")
        r = client.get(url, timeout=30, headers={"Accept": "application/json"})
        r.raise_for_status()
        s_idx = _parse_eurostat_jsonstat(r.json())
    except Exception as e:
        log.warning(f"Stahování CPI selhalo: {e}, zkouším fallback CSV")
        s_idx = _load_fallback_csv("cpi_index", index_col="date", value_col="index")
        if s_idx is None:
            raise RuntimeError("CPI není dostupné (API ani fallback CSV)") from e

    # Převod na měsíc-konec datetime
    s_idx.index = pd.to_datetime(s_idx.index + "-01") + pd.offsets.MonthEnd(0)
    s_idx = s_idx.sort_index()

    # Meziroční % změna
    yoy = (s_idx / s_idx.shift(12) - 1) * 100
    yoy = yoy[yoy.index >= "2000-01-01"].dropna()

    set_cached("cpi", {
        "dates": [d.isoformat() for d in yoy.index],
        "values": [round(float(v), 4) if pd.notna(v) else None for v in yoy],
    })
    return yoy


# --- HDP Eurostat ---

def _quarter_to_month_end(q: str) -> pd.Timestamp:
    """'2000-Q1' -> 2000-03-31 (konec posledního měsíce čtvrtletí)"""
    year, qt = q.split("-Q")
    month = int(qt) * 3
    return pd.Timestamp(int(year), month, 1) + pd.offsets.MonthEnd(0)


def fetch_gdp(client: httpx.Client) -> pd.Series:
    """
    Stáhne čtvrtletní reálný HDP z Eurostat (namq_10_gdp, CLV10_MNAC, SCA).
    Vypočítá meziroční % změnu a forward-fill na měsíční frekvenci.
    """
    cached = get_cached("gdp")
    if cached:
        log.info("HDP: načteno z cache")
        s = pd.Series(cached["values"], index=pd.to_datetime(cached["dates"]))
        s.index = s.index + pd.offsets.MonthEnd(0)
        return s

    url = (
        "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"
        "namq_10_gdp?geo=CZ&unit=CLV10_MNAC&s_adj=SCA&na_item=B1GQ&freq=Q"
    )
    try:
        log.info("Stahování HDP z Eurostat...")
        r = client.get(url, timeout=30, headers={"Accept": "application/json"})
        r.raise_for_status()
        s_idx = _parse_eurostat_jsonstat(r.json())
    except Exception as e:
        log.warning(f"Stahování HDP selhalo: {e}, zkouším fallback CSV")
        s_idx = _load_fallback_csv("gdp_index", index_col="date", value_col="index")
        if s_idx is None:
            raise RuntimeError("HDP není dostupné (API ani fallback CSV)") from e

    # Čtvrtletní index → měsíc-konec
    s_idx.index = s_idx.index.map(_quarter_to_month_end)
    s_idx = s_idx.sort_index()

    # Meziroční % změna (srovnání se stejným čtvrtletím minulého roku)
    yoy_q = (s_idx / s_idx.shift(4) - 1) * 100
    yoy_q = yoy_q[yoy_q.index >= "2000-01-01"].dropna()

    # Forward-fill na měsíční frekvenci (Q1 hodnota platí pro leden, únor, březen)
    monthly_idx = pd.date_range("2000-01-01", "2026-12-31", freq="ME")
    yoy_m = yoy_q.reindex(monthly_idx, method="ffill")

    set_cached("gdp", {
        "dates": [d.isoformat() for d in yoy_m.index],
        "values": [round(float(v), 4) if pd.notna(v) else None for v in yoy_m],
    })
    return yoy_m


# --- Sestavení hlavního DataFramu ---

def fetch_all_data(client: httpx.Client) -> dict:
    """
    Stáhne všechna data a sestaví sjednocený DataFrame.
    Klíč 'dataframe' obsahuje pandas DataFrame s měsíčním indexem.
    """
    repo = fetch_repo_rate(client)
    cpi = fetch_cpi(client)
    gdp = fetch_gdp(client)

    # Sjednotit na společný měsíční index (průnik dostupných dat, od 2000-01)
    common_idx = repo.index[repo.index >= "2000-01-01"]

    pistar = build_pistar_series(common_idx)

    df = pd.DataFrame({
        "actual_rate": repo.reindex(common_idx),
        "cpi": cpi.reindex(common_idx),
        "gdp": gdp.reindex(common_idx),
        "pistar": pistar.values,
    }, index=common_idx)

    log.info(f"Data připravena: {len(df)} měsíců, {df.index.min().date()} – {df.index.max().date()}")
    return {"dataframe": df}


# --- Fallback CSV loader ---

def _load_fallback_csv(name: str, index_col: str, value_col: str) -> Optional[pd.Series]:
    """Načte fallback CSV soubor z adresáře data/."""
    path = DATA_DIR / f"{name}.csv"
    if not path.exists():
        log.error(f"Fallback CSV nenalezen: {path}")
        return None
    try:
        df = pd.read_csv(path, parse_dates=[index_col], index_col=index_col)
        return df[value_col]
    except Exception as e:
        log.error(f"Chyba při čtení fallback CSV {path}: {e}")
        return None
