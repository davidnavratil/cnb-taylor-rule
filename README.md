# Taylorovo pravidlo pro ČNB

Interaktivní webová aplikace simulující repo sazbu ČNB pomocí inertního Taylorova pravidla.

## Spuštění

```bash
# 1. Instalace závislostí
pip install -r requirements.txt

# 2. Spuštění serveru (z adresáře backend/)
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000

# 3. Otevřít v prohlížeči
open http://localhost:8000
```

## Datové zdroje (stahují se automaticky při prvním spuštění)

| Proměnná | Zdroj |
|----------|-------|
| 2T repo sazba ČNB | ČNB (TXT soubor, bez API klíče) |
| CPI inflace (meziroční %) | Eurostat HICP – `prc_hicp_midx` |
| Reálný růst HDP (meziroční %) | Eurostat – `namq_10_gdp`, čtvrtletní, forward-fill |

Data se ukládají do cache (`.cache/`) s TTL 24 hodin.

## Taylorovo pravidlo (inertní varianta)

```
i_t = ρ · i_{t-1} + (1-ρ) · [r* + π_t + α·(π_t - π*_t) + β·g_t]
```

| Parametr | Popis | Rozsah |
|----------|-------|--------|
| ρ | setrvačnost sazby | 0 – 0.99 |
| r* | neutrální reálná sazba (%) | −2 – 5 |
| α | váha inflační mezery | 0 – 3 |
| β | váha reálného růstu HDP | 0 – 3 |

Výchozí parametry jsou odhadnuty OLS regresí na datech 2000–2025.
