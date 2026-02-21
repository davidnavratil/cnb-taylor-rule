/**
 * Taylorovo pravidlo pro ČNB – frontend logika (statická verze pro GitHub Pages)
 *
 * Postup:
 *  1. Při načtení stránky: fetch data.json + params.json (paralelně)
 *  2. Inicializace tří Chart.js grafů
 *  3. Slidery + numerická pole: debounce 300ms → lokální výpočet Taylor rule → překreslit
 *  4. Tlačítko "Výchozí (OLS)": reset na kalibrované parametry
 *  5. Časový rozsah: překreslit grafy pro zvolené období
 */

"use strict";

const DEBOUNCE_MS = 280;

// ── Stav aplikace ──────────────────────────────────────────────────────────
const state = {
  raw: null,           // { dates, actual_rate, cpi, gdp, pistar, generated_at }
  defaults: null,      // { rho, rstar, alpha, beta }
  charts: {},
  debounceTimer: null,
  loading: false,
};

// ── DOM reference ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const PARAMS = ["rho", "rstar", "alpha", "beta"];

// ── Inicializace ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  showLoader(true, "Načítám data z ČNB a Eurostat…");

  try {
    await loadBaseData();
    initCharts();
    initControls();
    updateTaylorChart();
    updateStatusBadge();
  } catch (err) {
    console.error("Chyba při inicializaci:", err);
    showLoader(true, `Chyba: ${err.message}. Zkuste obnovit stránku.`);
    return;
  }

  showLoader(false);
});

// ── Načtení dat ────────────────────────────────────────────────────────────
async function loadBaseData() {
  const [dataRes, paramsRes] = await Promise.all([
    fetchJSON("data.json"),
    fetchJSON("params.json"),
  ]);

  state.raw = dataRes;
  state.defaults = paramsRes;

  setParamValues(state.defaults);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} při GET ${url}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

function updateStatusBadge() {
  try {
    const raw   = state.raw;
    const badge = $("data-status");
    const genAt = new Date(raw.generated_at);
    const dateStr = genAt.toLocaleDateString("cs-CZ", {
      day: "numeric", month: "long", year: "numeric",
    });
    badge.textContent = `Data: ${dateStr}`;
    badge.className   = "badge badge-ok";

    const n = raw.actual_rate.filter(v => v !== null).length;
    const dates = raw.dates;
    $("obs-count").textContent =
      `${n} měsíců (${dates[0]} – ${dates[dates.length - 1]})`;
  } catch (_) { /* tiché selhání */ }
}

// ── Filtrace dat dle časového rozsahu ──────────────────────────────────────
function getDateRange() {
  const from = $("date-from").value || "2000-01";
  const to   = $("date-to").value   || "2026-12";
  return { from, to };
}

function filterRaw(dates, values, from, to) {
  const f = from.replace("-", ""), t = to.replace("-", "");
  const result = { dates: [], values: [] };
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i].replace("-", "");
    if (d >= f && d <= t) {
      result.dates.push(dates[i]);
      result.values.push(values[i]);
    }
  }
  return result;
}

// ── Taylor rule (lokální výpočet v JS) ────────────────────────────────────
/**
 * Vypočítá implikovanou repo sazbu dle inertního Taylorova pravidla.
 * Vždy běží na CELÉM datasetu, aby inertní člen ρ·i_{t-1} byl historicky korektní.
 * Pro zobrazení se výsledek filtruje pomocí filterRaw().
 */
function calculateTaylor(data, rho, rstar, alpha, beta) {
  const n = data.dates.length;
  const result = new Array(n);

  for (let i = 0; i < n; i++) {
    const pi     = data.cpi[i];
    const g      = data.gdp[i];
    const pistar = data.pistar[i];

    if (pi === null || g === null) {
      result[i] = null;
      continue;
    }

    const target = rstar + pi + alpha * (pi - pistar) + beta * g;

    // i_{t-1} je vždy SKUTEČNÁ repo sazba z předchozího měsíce
    const iPrev = i === 0 ? data.actual_rate[0] : data.actual_rate[i - 1];
    const val   = iPrev === null
      ? (1 - rho) * target
      : rho * iPrev + (1 - rho) * target;

    result[i] = Math.round(val * 10000) / 10000;
  }

  return result;
}

/**
 * Vypočítá statistiky shody mezi skutečnou a implikovanou sazbou.
 * Vstupy: filtrované pole hodnot (null jsou ignorovány).
 */
function computeStats(actual, implied) {
  const pairs = actual
    .map((a, i) => [a, implied[i]])
    .filter(([a, b]) => a !== null && b !== null);

  if (pairs.length < 2) {
    return { rmse: null, mae: null, correlation: null, mean_deviation: null };
  }

  const diffs   = pairs.map(([a, b]) => a - b);
  const rmse    = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
  const mae     = diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length;
  const meanDev = diffs.reduce((s, d) => s + d, 0) / diffs.length;

  const meanA = pairs.reduce((s, [a]) => s + a, 0) / pairs.length;
  const meanB = pairs.reduce((s, [, b]) => s + b, 0) / pairs.length;
  const cov   = pairs.reduce((s, [a, b]) => s + (a - meanA) * (b - meanB), 0);
  const stdA  = Math.sqrt(pairs.reduce((s, [a]) => s + (a - meanA) ** 2, 0));
  const stdB  = Math.sqrt(pairs.reduce((s, [, b]) => s + (b - meanB) ** 2, 0));
  const corr  = stdA > 0 && stdB > 0 ? cov / (stdA * stdB) : null;

  return {
    rmse:           Math.round(rmse    * 1000) / 1000,
    mae:            Math.round(mae     * 1000) / 1000,
    correlation:    corr !== null ? Math.round(corr * 1000) / 1000 : null,
    mean_deviation: Math.round(meanDev * 1000) / 1000,
  };
}

// ── Grafy ─────────────────────────────────────────────────────────────────

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 150 },
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: {
      position: "top",
      labels: { boxWidth: 14, font: { size: 12 }, padding: 12 },
    },
    tooltip: {
      callbacks: {
        label: ctx => {
          const v = ctx.parsed.y;
          if (v === null || v === undefined) return null;
          return `${ctx.dataset.label}: ${v.toFixed(2)} %`;
        },
      },
    },
  },
  scales: {
    x: {
      ticks: {
        maxTicksLimit: 16,
        font: { size: 11 },
        maxRotation: 0,
      },
      grid: { color: "rgba(0,0,0,.05)" },
    },
    y: {
      title: { display: true, text: "%", font: { size: 11 } },
      grid: { color: "rgba(0,0,0,.05)" },
      ticks: { font: { size: 11 } },
    },
  },
};

function initCharts() {
  const raw = state.raw;
  const { from, to } = getDateRange();

  // Hlavní graf (repo sazba + Taylor)
  state.charts.main = new Chart($("main-chart"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Skutečná repo sazba ČNB",
          borderColor: "#1565C0",
          backgroundColor: "rgba(21,101,192,.08)",
          borderWidth: 2.2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0,
          data: [],
          fill: false,
        },
        {
          label: "Taylorova implikovaná sazba",
          borderColor: "#C62828",
          borderDash: [6, 3],
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0,
          data: [],
          fill: false,
        },
        {
          label: "Inflační cíl ČNB",
          borderColor: "#BDBDBD",
          borderDash: [2, 4],
          borderWidth: 1.2,
          pointRadius: 0,
          tension: 0,
          data: [],
          fill: false,
        },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        title: { display: false },
      },
    },
  });

  // CPI graf
  const cpiFiltered    = filterRaw(raw.dates, raw.cpi,    from, to);
  const pistarFiltered = filterRaw(raw.dates, raw.pistar, from, to);

  state.charts.cpi = new Chart($("cpi-chart"), {
    type: "line",
    data: {
      labels: cpiFiltered.dates,
      datasets: [
        {
          label: "HICP inflace (meziroční %)",
          borderColor: "#2E7D32",
          backgroundColor: "rgba(46,125,50,.08)",
          borderWidth: 1.8,
          pointRadius: 0,
          tension: 0,
          data: cpiFiltered.values,
        },
        {
          label: "Inflační cíl ČNB",
          borderColor: "#BDBDBD",
          borderDash: [3, 4],
          borderWidth: 1.2,
          pointRadius: 0,
          tension: 0,
          data: pistarFiltered.values,
        },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: {
          ...CHART_DEFAULTS.plugins.legend,
          labels: { ...CHART_DEFAULTS.plugins.legend.labels, boxWidth: 12, font: { size: 11 } },
        },
      },
      scales: {
        ...CHART_DEFAULTS.scales,
        x: { ...CHART_DEFAULTS.scales.x, ticks: { maxTicksLimit: 10, font: { size: 10 }, maxRotation: 0 } },
        y: { ...CHART_DEFAULTS.scales.y, ticks: { font: { size: 10 } } },
      },
    },
  });

  // HDP graf (sloupcový)
  const gdpFiltered = filterRaw(raw.dates, raw.gdp, from, to);

  state.charts.gdp = new Chart($("gdp-chart"), {
    type: "bar",
    data: {
      labels: gdpFiltered.dates,
      datasets: [
        {
          label: "Reálný růst HDP (meziroční %)",
          backgroundColor: gdpFiltered.values.map(v =>
            v === null ? "rgba(200,200,200,.4)" : v >= 0 ? "rgba(46,125,50,.65)" : "rgba(198,40,40,.65)"
          ),
          borderWidth: 0,
          data: gdpFiltered.values,
        },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: {
          ...CHART_DEFAULTS.plugins.legend,
          labels: { ...CHART_DEFAULTS.plugins.legend.labels, boxWidth: 12, font: { size: 11 } },
        },
      },
      scales: {
        ...CHART_DEFAULTS.scales,
        x: { ...CHART_DEFAULTS.scales.x, ticks: { maxTicksLimit: 10, font: { size: 10 }, maxRotation: 0 } },
        y: { ...CHART_DEFAULTS.scales.y, ticks: { font: { size: 10 } } },
      },
    },
  });
}

// ── Aktualizace grafů ──────────────────────────────────────────────────────
function updateTaylorChart() {
  if (!state.raw) return;

  const params = getParamValues();
  const { from, to } = getDateRange();

  // Vedlejší grafy – bez závislosti na parametrech
  updateSecondaryCharts(from, to);

  // Výpočet Taylor rule na CELÉM datasetu (zachová korektnost inertního členu)
  const allImplied = calculateTaylor(
    state.raw, params.rho, params.rstar, params.alpha, params.beta
  );

  // Filtrovat pro zobrazení a statistiky
  const actualF  = filterRaw(state.raw.dates, state.raw.actual_rate, from, to);
  const impliedF = filterRaw(state.raw.dates, allImplied,            from, to);
  const pistarF  = filterRaw(state.raw.dates, state.raw.pistar,      from, to);

  // Aktualizovat hlavní graf
  const chart = state.charts.main;
  chart.data.labels            = actualF.dates;
  chart.data.datasets[0].data  = actualF.values;
  chart.data.datasets[1].data  = impliedF.values;
  chart.data.datasets[2].data  = pistarF.values;
  chart.update("none");

  // Statistiky z filtrovaného rozsahu
  const stats = computeStats(actualF.values, impliedF.values);
  updateStats(stats);
}

function updateSecondaryCharts(from, to) {
  const raw = state.raw;

  // CPI
  const cpiF    = filterRaw(raw.dates, raw.cpi,    from, to);
  const pistarF = filterRaw(raw.dates, raw.pistar,  from, to);
  const cpiChart = state.charts.cpi;
  cpiChart.data.labels            = cpiF.dates;
  cpiChart.data.datasets[0].data  = cpiF.values;
  cpiChart.data.datasets[1].data  = pistarF.values;
  cpiChart.update("none");

  // HDP
  const gdpF    = filterRaw(raw.dates, raw.gdp, from, to);
  const gdpChart = state.charts.gdp;
  gdpChart.data.labels = gdpF.dates;
  gdpChart.data.datasets[0].data = gdpF.values;
  // Barvy podle znaménka
  gdpChart.data.datasets[0].backgroundColor = gdpF.values.map(v =>
    v === null ? "rgba(200,200,200,.4)" : v >= 0 ? "rgba(46,125,50,.65)" : "rgba(198,40,40,.65)"
  );
  gdpChart.update("none");
}

function updateStats(stats) {
  const fmtPP = v => (v !== null && !isNaN(v)) ? `${v.toFixed(3)} p.p.` : "—";
  const fmtR  = v => (v !== null && !isNaN(v)) ? v.toFixed(3) : "—";
  const fmtDev = v => {
    if (v === null || isNaN(v)) return "—";
    const s = v > 0 ? "+" : "";
    return `${s}${v.toFixed(3)} p.p.`;
  };

  $("stat-rmse").textContent = fmtPP(stats.rmse);
  $("stat-mae").textContent  = fmtPP(stats.mae);
  $("stat-corr").textContent = fmtR(stats.correlation);
  $("stat-dev").textContent  = fmtDev(stats.mean_deviation);
}

// ── Ovládací prvky ─────────────────────────────────────────────────────────
function initControls() {
  // Synchronizace slider ↔ numerické pole + debounce update
  PARAMS.forEach(param => {
    const slider   = $(param);
    const numInput = $(`${param}-num`);

    slider.addEventListener("input", () => {
      numInput.value = parseFloat(slider.value).toFixed(param === "rho" ? 2 : 1);
      scheduleUpdate();
    });

    numInput.addEventListener("change", () => {
      const min = parseFloat(slider.min);
      const max = parseFloat(slider.max);
      let val = parseFloat(numInput.value);
      if (isNaN(val)) val = parseFloat(slider.value);
      val = Math.max(min, Math.min(max, val));
      numInput.value = val.toFixed(param === "rho" ? 2 : 1);
      slider.value   = val;
      scheduleUpdate();
    });
  });

  // Reset na OLS parametry
  $("reset-btn").addEventListener("click", () => {
    setParamValues(state.defaults);
    updateTaylorChart();
  });

  // Časový rozsah
  $("date-from").addEventListener("change", scheduleUpdate);
  $("date-to").addEventListener("change",   scheduleUpdate);

  // Zoom tlačítka
  $("zoom-5y").addEventListener("click",  () => setZoom(5));
  $("zoom-10y").addEventListener("click", () => setZoom(10));
  $("zoom-all").addEventListener("click", () => {
    $("date-from").value = "2000-01";
    $("date-to").value   = latestAvailableDate();
    scheduleUpdate();
  });
}

function setZoom(years) {
  const now  = new Date();
  const toY  = now.getFullYear();
  const toM  = String(now.getMonth() + 1).padStart(2, "0");
  const fromY = toY - years;
  $("date-from").value = `${fromY}-${toM}`;
  $("date-to").value   = `${toY}-${toM}`;
  scheduleUpdate();
}

function latestAvailableDate() {
  if (!state.raw || !state.raw.dates.length) return "2025-12";
  return state.raw.dates[state.raw.dates.length - 1];
}

function scheduleUpdate() {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(updateTaylorChart, DEBOUNCE_MS);
}

// ── Helpery pro parametry ──────────────────────────────────────────────────
function getParamValues() {
  return {
    rho:   parseFloat($("rho").value),
    rstar: parseFloat($("rstar").value),
    alpha: parseFloat($("alpha").value),
    beta:  parseFloat($("beta").value),
  };
}

function setParamValues(params) {
  PARAMS.forEach(p => {
    const dec = p === "rho" ? 2 : 1;
    $(`${p}`).value     = params[p];
    $(`${p}-num`).value = parseFloat(params[p]).toFixed(dec);
  });
}

// ── Loader ─────────────────────────────────────────────────────────────────
function showLoader(visible, msg) {
  const el = $("loader");
  el.style.display = visible ? "flex" : "none";
  if (msg) $("loader-msg").textContent = msg;
}
