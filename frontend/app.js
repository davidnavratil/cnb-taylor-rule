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

// ── Plugin: poutky s poslední hodnotou na pravém okraji ───────────────────

const lastValuePlugin = {
  id: "lastValueLabel",
  afterDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const yScale = scales.y;
    if (!yScale || !chartArea) return;

    // exportScale je nastaveno v doDownloadPNG → poutky se proporcionálně zvětší
    const sf      = chart.config.options.exportScale ?? 1;
    const FONT_SZ = Math.round(10 * sf);
    const PAD_X   = Math.round(5  * sf);
    const PAD_Y   = Math.round(2  * sf);
    const PILL_H  = Math.round(14 * sf) + PAD_Y * 2;
    const MIN_GAP = Math.round(20 * sf);
    const RADIUS  = Math.round(3  * sf);
    const x0      = chartArea.right + Math.round(4 * sf);

    // Sbírat labely ze všech viditelných datasetů s příznakem lastValueLabel
    const toRender = [];
    chart.data.datasets.forEach((dataset, di) => {
      if (dataset.lastValueLabel === false) return;
      if (!chart.isDatasetVisible(di)) return;

      // Poslední nenulová hodnota v datasetu
      const data = dataset.data;
      let lastVal = null;
      for (let i = data.length - 1; i >= 0; i--) {
        const v = data[i];
        if (v !== null && v !== undefined && !isNaN(v)) { lastVal = v; break; }
      }
      if (lastVal === null) return;

      const yPx = yScale.getPixelForValue(lastVal);
      if (yPx < chartArea.top || yPx > chartArea.bottom) return;

      // Barva: line charty mají borderColor; bar chart → podle znaménka hodnoty
      let color = dataset.borderColor;
      if (!color || typeof color !== "string" || color === "rgba(0,0,0,0)") {
        color = lastVal >= 0 ? "#2E7D32" : "#C62828";
      }
      const dec = dataset.lastValueDecimals ?? 2;
      toRender.push({ yPx, color, text: lastVal.toFixed(dec) + " %" });
    });

    if (!toRender.length) return;

    // Seřadit shora dolů, pak rozlišit překrytí
    toRender.sort((a, b) => a.yPx - b.yPx);
    for (let i = 1; i < toRender.length; i++) {
      if (toRender[i].yPx - toRender[i - 1].yPx < MIN_GAP) {
        toRender[i].yPx = toRender[i - 1].yPx + MIN_GAP;
      }
    }
    // Clamp – nepřetéct přes dolní okraj
    for (let i = toRender.length - 1; i >= 0; i--) {
      if (toRender[i].yPx > chartArea.bottom - PILL_H / 2) {
        toRender[i].yPx = chartArea.bottom - PILL_H / 2;
        if (i > 0) toRender[i - 1].yPx = Math.min(toRender[i - 1].yPx, toRender[i].yPx - MIN_GAP);
      }
    }

    // Kreslit poutky
    ctx.save();
    ctx.font         = `bold ${FONT_SZ}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";

    toRender.forEach(({ yPx, color, text }) => {
      const tw = ctx.measureText(text).width;
      const bw = tw + PAD_X * 2;
      const bh = PILL_H;
      const bx = x0;
      const by = yPx - bh / 2;
      const r  = RADIUS;

      // Zaoblený obdélník (ručně, kompatibilita se staršími Safari)
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(bx + r, by);
      ctx.lineTo(bx + bw - r, by);
      ctx.quadraticCurveTo(bx + bw, by,      bx + bw, by + r);
      ctx.lineTo(bx + bw, by + bh - r);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
      ctx.lineTo(bx + r, by + bh);
      ctx.quadraticCurveTo(bx, by + bh,      bx, by + bh - r);
      ctx.lineTo(bx, by + r);
      ctx.quadraticCurveTo(bx, by,            bx + r, by);
      ctx.closePath();
      ctx.fill();

      // Bílý text
      ctx.fillStyle = "#fff";
      ctx.fillText(text, bx + PAD_X, yPx);
    });

    ctx.restore();
  },
};

Chart.register(lastValuePlugin);

// ── Grafy ─────────────────────────────────────────────────────────────────

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 150 },
  interaction: { mode: "index", intersect: false },
  layout: { padding: { right: 62 } },
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
          lastValueLabel: true,
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
          lastValueLabel: true,
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
          lastValueLabel: true,
          lastValueDecimals: 1,
          data: cpiFiltered.values,
        },
        {
          label: "Inflační cíl ČNB",
          borderColor: "#BDBDBD",
          borderDash: [3, 4],
          borderWidth: 1.2,
          pointRadius: 0,
          tension: 0,
          lastValueLabel: false,
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
          lastValueLabel: true,
          lastValueDecimals: 1,
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

  // Aktualizovat hlavní graf
  const chart = state.charts.main;
  chart.data.labels            = actualF.dates;
  chart.data.datasets[0].data  = actualF.values;
  chart.data.datasets[1].data  = impliedF.values;
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

// ── Export / stažení grafů ─────────────────────────────────────────────────

const CHART_META = {
  main: { base: "cnb-taylor-repo-sazba", title: "Repo sazba ČNB vs. Taylorovo pravidlo" },
  cpi:  { base: "cnb-taylor-inflace",    title: "CPI inflace a inflační cíl ČNB" },
  gdp:  { base: "cnb-taylor-hdp",        title: "Reálný růst HDP" },
};

function downloadChart(chartKey, format) {
  if (!state.raw) return;
  const meta = CHART_META[chartKey];
  if (!meta) return;

  if (format === "png") {
    doDownloadPNG(chartKey, meta.base);
    return;
  }

  const { headers, rows, metaLines } = getChartExportData(chartKey, meta.title);
  if (format === "csv")  doDownloadCSV(meta.base,  headers, rows, metaLines);
  if (format === "xlsx") doDownloadXLSX(meta.base, headers, rows, metaLines);
}

/** Vrátí aktuálně zobrazená data grafu včetně metadat pro export. */
function getChartExportData(chartKey, title) {
  const { from, to } = getDateRange();
  const params = getParamValues();
  const genAt  = state.raw.generated_at
    ? new Date(state.raw.generated_at).toLocaleDateString("cs-CZ")
    : "";

  const metaLines = [
    [title],
    [`Staženo: ${genAt}   Období: ${from} – ${to}`],
    ...(chartKey === "main"
      ? [[`Parametry: ρ=${params.rho}  r*=${params.rstar}  α=${params.alpha}  β=${params.beta}`]]
      : []),
    [],   // prázdný oddělovač
  ];

  switch (chartKey) {
    case "main": {
      const allImplied = calculateTaylor(
        state.raw, params.rho, params.rstar, params.alpha, params.beta
      );
      const actualF  = filterRaw(state.raw.dates, state.raw.actual_rate, from, to);
      const impliedF = filterRaw(state.raw.dates, allImplied,            from, to);
      return {
        headers: ["Datum", "Skutečná repo sazba (%)", "Taylorova implikovaná sazba (%)"],
        rows: actualF.dates.map((d, i) => [d, actualF.values[i], impliedF.values[i]]),
        metaLines,
      };
    }
    case "cpi": {
      const cpiF    = filterRaw(state.raw.dates, state.raw.cpi,    from, to);
      const pistarF = filterRaw(state.raw.dates, state.raw.pistar, from, to);
      return {
        headers: ["Datum", "HICP inflace (%)", "Inflační cíl ČNB (%)"],
        rows: cpiF.dates.map((d, i) => [d, cpiF.values[i], pistarF.values[i]]),
        metaLines,
      };
    }
    case "gdp": {
      const gdpF = filterRaw(state.raw.dates, state.raw.gdp, from, to);
      return {
        headers: ["Datum", "Reálný růst HDP (%)"],
        rows: gdpF.dates.map((d, i) => [d, gdpF.values[i]]),
        metaLines,
      };
    }
    default:
      return { headers: [], rows: [], metaLines: [] };
  }
}

/** Pomocná funkce – spustí download přes dočasný <a> v DOM. */
function triggerDownload(href, filename) {
  const link = document.createElement("a");
  link.href     = href;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  // Malá prodleva před odstraněním, aby stihlo spustit stahování
  setTimeout(() => {
    document.body.removeChild(link);
    if (href.startsWith("blob:")) URL.revokeObjectURL(href);
  }, 200);
}

/** PNG – bílé pozadí, název grafu nahoře, pevný formát 16:9 (1920×1080 px).
 *  Graf se překreslí v plném rozlišení se škálovanými fonty a poutkami –
 *  žádné letterboxing mezery, žádné zkreslení textu. */
function doDownloadPNG(chartKey, filenameBase) {
  const W       = 1920;
  const H       = 1080;   // 16:9
  const TITLE_H = 60;     // výška pruhu s názvem
  const CHART_H = H - TITLE_H;

  // Exportní canvas (titulek + plocha grafu)
  const exp = document.createElement("canvas");
  exp.width  = W;
  exp.height = H;
  const ctx  = exp.getContext("2d");

  // Bílé pozadí
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Název grafu
  const title = CHART_META[chartKey]?.title ?? "";
  ctx.font         = "bold 28px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillStyle    = "#212121";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, W / 2, TITLE_H / 2);

  // Jemná oddělovací linka pod názvem
  ctx.strokeStyle = "#E0E0E0";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(20, TITLE_H - 1);
  ctx.lineTo(W - 20, TITLE_H - 1);
  ctx.stroke();

  // ── Překreslení grafu v plném rozlišení ────────────────────────────────
  const tmpCanvas  = document.createElement("canvas");
  tmpCanvas.width  = W;
  tmpCanvas.height = CHART_H;

  const srcChart = state.charts[chartKey];
  // Referenční šířka 960 px → SF ≈ 2 při exportu 1920 px
  const SF = W / 960;

  // Klonování dat ze zdrojového grafu (bez sdílených referencí)
  const clonedData = {
    labels: [...srcChart.data.labels],
    datasets: srcChart.data.datasets.map(ds => ({
      ...ds,
      data: [...ds.data],
      ...(Array.isArray(ds.backgroundColor) && {
        backgroundColor: [...ds.backgroundColor],
      }),
    })),
  };

  // Škálované options – fonty, legendy, padding; exportScale předáno do lastValuePlugin
  const srcOpts    = srcChart.config.options;
  const exportOpts = {
    ...srcOpts,
    responsive:  false,
    animation:   false,
    exportScale: SF,
    layout: { padding: { right: Math.round(62 * SF) } },
    plugins: {
      ...srcOpts.plugins,
      legend: {
        ...srcOpts.plugins?.legend,
        labels: {
          ...srcOpts.plugins?.legend?.labels,
          boxWidth: Math.round(14 * SF),
          font:     { size: Math.round(12 * SF) },
          padding:  Math.round(12 * SF),
        },
      },
      tooltip: { enabled: false },
    },
    scales: {
      x: {
        ...srcOpts.scales?.x,
        ticks: {
          ...srcOpts.scales?.x?.ticks,
          font:         { size: Math.round(11 * SF) },
          maxRotation:  0,
        },
        grid: { color: "rgba(0,0,0,.05)" },
      },
      y: {
        ...srcOpts.scales?.y,
        title: { display: true, text: "%", font: { size: Math.round(11 * SF) } },
        ticks: {
          ...srcOpts.scales?.y?.ticks,
          font: { size: Math.round(11 * SF) },
        },
        grid: { color: "rgba(0,0,0,.05)" },
      },
    },
  };

  // Chart.js s animation:false kreslí synchronně → canvas je ihned připraven
  const tmpChart = new Chart(tmpCanvas, {
    type:    srcChart.config.type,
    data:    clonedData,
    options: exportOpts,
  });

  ctx.drawImage(tmpCanvas, 0, TITLE_H);
  tmpChart.destroy();

  triggerDownload(exp.toDataURL("image/png"), `${filenameBase}.png`);
}

/** CSV – středník jako oddělovač, čárka jako desetinný oddělovač (cs-CZ). */
function doDownloadCSV(filenameBase, headers, rows, metaLines) {
  const fmt = v => (v === null || v === undefined) ? "" : String(v).replace(".", ",");
  const lines = [];
  for (const m of metaLines) lines.push(m.map(String).join(";"));
  lines.push(headers.join(";"));
  for (const row of rows) lines.push(row.map(fmt).join(";"));

  // BOM pro správné otevření UTF-8 v Excelu
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  triggerDownload(URL.createObjectURL(blob), `${filenameBase}.csv`);
}

/** XLSX – používá SheetJS (načtený z CDN). */
function doDownloadXLSX(filenameBase, headers, rows, metaLines) {
  if (typeof XLSX === "undefined") {
    alert("Knihovna XLSX není dostupná. Zkuste CSV.");
    return;
  }

  const wsData = [];
  for (const m of metaLines) wsData.push(m);
  wsData.push(headers);
  for (const row of rows) wsData.push(row.map(v => v === null ? "" : v));

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = headers.map((_, i) => ({ wch: i === 0 ? 10 : 28 }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, `${filenameBase}.xlsx`);
}

// ── Loader ─────────────────────────────────────────────────────────────────
function showLoader(visible, msg) {
  const el = $("loader");
  el.style.display = visible ? "flex" : "none";
  if (msg) $("loader-msg").textContent = msg;
}
