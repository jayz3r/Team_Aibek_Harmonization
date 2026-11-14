# FireBridge — гармонизация горячих точек MODIS и VIIRS

Проект для NASA Space Apps Challenge, тема **Harmonization of MODIS and VIIRS Hot Spots**.
Бэкенд (FastAPI + DuckDB) и фронтенд (React + MapLibre) теперь работают как одно приложение.

```
FireBridge/
  backend/    API: импорт FIRMS, сетка 10 км, калибровка, календарь, сезонность, события
  frontend/   Карта и «лаборатория гармонизации»
  start.bat   Запуск обоих серверов в Windows
  start.sh    То же для macOS / Linux
```

## Запуск

Нужны **Python 3.12** и **Node.js 22.12+** (или 20.19+).

**Окно 1 — бэкенд**

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows;  macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

**Окно 2 — фронтенд**

```bash
cd frontend
npm ci
npm run dev
```

Откройте адрес, который напечатает Vite (обычно <http://localhost:5173>). Vite сам пересылает
`/api` и `/health` на бэкенд, настраивать CORS не нужно. В шапке должна появиться плашка
**LIVE API · REV …**.

В пустой базе нажмите плашку → **Load real sample + calibrate**: загрузится реальный фрагмент
данных (17 075 детекций, северо-восток Китая, 2001–2026) и обучится модель. Свои архивы FIRMS
(CSV или ZIP) загружаются там же кнопкой **Upload FIRMS CSV / ZIP**; после загрузки откройте
**Harmonize → Validation → Re-calibrate**.

`start.bat` / `start.sh` делают то же самое одной командой (при первом запуске ставят зависимости).

### Один порт для показа жюри

```bash
cd frontend && npm run build      # создаёт frontend/dist
cd ../backend && uvicorn app.main:app --port 8000 --workers 1
```

Теперь всё приложение открывается на <http://localhost:8000>, документация API — на `/docs`.

### Если бэкенд не запущен

Фронтенд не падает: плашка показывает **OFFLINE SHOWCASE**, на карте — синтетические точки
(подписаны как демо), а в лаборатории — заранее посчитанный этим бэкендом отчёт по полным
архивам Китая (15,6 млн детекций, 2000–2025). Это страховка на случай сбоя во время демо.

## Что умеет приложение

| Где | Что |
|---|---|
| Шкала времени внизу | Год и месяц; столбцы — гармонизированный индекс активности, полоска под столбцом — спутник-источник месяца |
| **Pixels / Density** | Исходные детекции MODIS (оранжевые) и VIIRS (светлые), фильтр по сенсору, день/ночь, архив/NRT |
| **Grid 10 km** | Равноплощадная сетка — единица, из которой строится индекс; выбор спутника |
| **Events** | Пиксели всех спутников, слитые в пространственно-временные кластеры; цвет — кто видел (оба семейства / только VIIRS / только MODIS) |
| Scene settings → **Draw area** | Своя область интереса: карта, календарь и аномалии считаются по ней |
| **Harmonize → Burning calendar** | Календарь горения за все годы, сравнение «сырой ряд против гармонизированного», флаги, CSV |
| **Harmonize → Seasonality** | Сезонный профиль, отклонения выбранного года (z-оценка), самые активные месяцы |
| **Harmonize → Validation** | Коэффициенты с доверительными интервалами, ошибка до/после на отложенном годе, честный список ограничений, кнопка переобучения |
| **Harmonize → Sensor agreement** | Совпадение пикселей MODIS–VIIRS по расстоянию и времени, доля событий, увиденных обоими сенсорами |
| Плашка статуса → панель данных | Загрузка файлов на сервер, импорт свежих данных NASA FIRMS, покрытие по спутникам, экспорт CSV |

Импорт свежих данных из NASA FIRMS: получите бесплатный MAP_KEY, скопируйте
`backend/.env.example` в `backend/.env`, впишите `FIRMS_MAP_KEY=...` и перезапустите сервер.
Ключ остаётся на сервере.

## Проверка

```bash
cd backend  && pip install -r requirements-dev.txt && python -m pytest -q
cd frontend && npm test
```

Что именно было проверено при сборке этой версии и что нужно прогнать у себя — в
[CHANGES.md](CHANGES.md).

## Документация

- [backend/README.md](backend/README.md) — API, данные, ограничения
- [backend/docs/methodology.md](backend/docs/methodology.md) — метод гармонизации
- [backend/docs/frontend.md](backend/docs/frontend.md) — контракт API для фронтенда
- [backend/reports/VALIDATION.md](backend/reports/VALIDATION.md) — результаты на полных архивах Китая
- [frontend/README.md](frontend/README.md) — устройство интерфейса
