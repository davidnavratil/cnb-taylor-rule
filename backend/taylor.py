"""
Výpočet inertního Taylorova pravidla a OLS kalibrace defaultních parametrů.

Taylorovo pravidlo (inertní varianta):
    i_t = ρ · i_{t-1} + (1-ρ) · [r* + π_t + α·(π_t - π*_t) + β·g_t]

kde:
    i_{t-1} = SKUTEČNÁ repo sazba v předchozím měsíci (ne implikovaná)
    π*_t    = inflační cíl ČNB v čase t
    g_t     = meziroční reálný růst HDP

OLS regrese pro kalibraci:
    i_t = c + ρ·i_{t-1} + a·π_t + b·g_t + ε

Zpětný výpočet:
    α = a/(1-ρ) - 1
    β = b/(1-ρ)
    r* = c/(1-ρ) + α·π*_avg
"""
from __future__ import annotations

import logging
from typing import TypedDict

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)


class TaylorParams(TypedDict):
    rho: float
    rstar: float
    alpha: float
    beta: float


class TaylorStats(TypedDict):
    rmse: float
    mae: float
    correlation: float
    mean_deviation: float


def calculate_taylor(
    df: pd.DataFrame,
    rho: float,
    rstar: float,
    alpha: float,
    beta: float,
) -> pd.Series:
    """
    Vypočítá implikovanou repo sazbu dle inertního Taylorova pravidla.

    Parametry:
        df:    DataFrame s sloupci actual_rate, cpi, gdp, pistar (měsíční index)
        rho:   parametr setrvačnosti (0–0.99)
        rstar: neutrální reálná sazba (%)
        alpha: váha inflační mezery
        beta:  váha reálného růstu HDP

    Vrátí:
        pd.Series s implikovanou repo sazbou (stejný index jako df)

    Poznámka:
        i_{t-1} je vždy SKUTEČNÁ repo sazba z předchozího měsíce.
        Tím se předchází kumulaci chyb a výsledek je ekonomicky interpretovatelný
        jako "kam by ČNB sáhla, kdyby sledovala Taylor rule – ale s daným laggem".
    """
    result = pd.Series(index=df.index, dtype=float, name="implied_rate")
    actual = df["actual_rate"]

    for i, date in enumerate(df.index):
        row = df.loc[date]
        pi_t = row["cpi"]
        g_t = row["gdp"]
        pistar_t = row["pistar"]

        if pd.isna(pi_t) or pd.isna(g_t):
            result.iloc[i] = np.nan
            continue

        taylor_target = rstar + pi_t + alpha * (pi_t - pistar_t) + beta * g_t

        if i == 0:
            # První period: Taylor target bez setrvačnosti
            result.iloc[i] = (1 - rho) * taylor_target + rho * (actual.iloc[0] if pd.notna(actual.iloc[0]) else taylor_target)
        else:
            # Lagged SKUTEČNÁ (ne implikovaná) repo sazba
            i_prev = actual.iloc[i - 1]
            if pd.isna(i_prev):
                result.iloc[i] = (1 - rho) * taylor_target
            else:
                result.iloc[i] = rho * i_prev + (1 - rho) * taylor_target

    return result.round(4)


def calibrate_ols(df: pd.DataFrame) -> TaylorParams:
    """
    Odhadne OLS regresí optimální parametry Taylorova pravidla.

    Model:
        i_t = c + ρ·i_{t-1} + a·π_t + b·g_t + ε

    Zpětný výpočet parametrů:
        ρ    = koeficient u i_{t-1}
        α    = a/(1-ρ) - 1
        β    = b/(1-ρ)
        r*   = c/(1-ρ) + α·π*_avg

    Ořez výsledků na fyzikálně smysluplné rozsahy.
    """
    data = df[["actual_rate", "cpi", "gdp", "pistar"]].copy()
    data["lagged_rate"] = data["actual_rate"].shift(1)
    data = data.dropna()

    if len(data) < 20:
        log.warning("OLS: nedostatek dat, vracím výchozí parametry")
        return TaylorParams(rho=0.80, rstar=1.5, alpha=1.5, beta=0.5)

    # Design matrix: [1, i_{t-1}, π_t, g_t]
    X_arr = np.column_stack([
        np.ones(len(data)),
        data["lagged_rate"].values,
        data["cpi"].values,
        data["gdp"].values,
    ])
    y_arr = data["actual_rate"].values

    try:
        coeffs, _, _, _ = np.linalg.lstsq(X_arr, y_arr, rcond=None)
    except Exception as e:
        log.error(f"OLS selhala: {e}")
        return TaylorParams(rho=0.80, rstar=1.5, alpha=1.5, beta=0.5)

    c_hat, rho_hat, a_hat, b_hat = (float(v) for v in coeffs)

    # R² pro informaci v logu
    y_pred = X_arr @ coeffs
    ss_res = float(np.sum((y_arr - y_pred) ** 2))
    ss_tot = float(np.sum((y_arr - y_arr.mean()) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")

    log.info(
        f"OLS výsledky: const={c_hat:.3f}, rho={rho_hat:.3f}, "
        f"cpi={a_hat:.3f}, gdp={b_hat:.3f}, R²={r2:.3f}"
    )

    # Ořez rho na validní rozsah
    rho = float(np.clip(rho_hat, 0.0, 0.99))

    # Zpětný výpočet (ochrana proti dělení nulou)
    one_minus_rho = max(1 - rho, 0.01)

    alpha = a_hat / one_minus_rho - 1.0
    beta = b_hat / one_minus_rho
    pistar_avg = float(data["pistar"].mean())
    rstar = c_hat / one_minus_rho + alpha * pistar_avg

    # Ořez na smysluplné rozsahy
    params = TaylorParams(
        rho=round(rho, 3),
        rstar=round(float(np.clip(rstar, -2.0, 5.0)), 3),
        alpha=round(float(np.clip(alpha, 0.0, 3.0)), 3),
        beta=round(float(np.clip(beta, 0.0, 3.0)), 3),
    )

    log.info(f"Odhadnuté parametry: {params}")
    return params


def compute_stats(actual: pd.Series, implied: pd.Series) -> TaylorStats:
    """Vypočítá statistiky shody mezi skutečnou a implikovanou sazbou."""
    aligned = pd.DataFrame({"actual": actual, "implied": implied}).dropna()

    if len(aligned) < 2:
        return TaylorStats(rmse=float("nan"), mae=float("nan"),
                           correlation=float("nan"), mean_deviation=float("nan"))

    diff = aligned["actual"] - aligned["implied"]
    rmse = float(np.sqrt((diff ** 2).mean()))
    mae = float(diff.abs().mean())
    corr = float(aligned["actual"].corr(aligned["implied"]))
    mean_dev = float(diff.mean())

    return TaylorStats(
        rmse=round(rmse, 3),
        mae=round(mae, 3),
        correlation=round(corr, 3),
        mean_deviation=round(mean_dev, 3),
    )
