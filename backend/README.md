# MODIS–VIIRS Harmonization — FastAPI Backend

Рабочий backend для NASA Space Apps Challenge **Harmonization of MODIS and VIIRS Hot Spots**. Загружает FIRMS CSV/ZIP, сохраняет спутниковые точки, строит общий показатель активности, обучает калибровку и возвращает календарь, сезонность, аномалии и GeoJSON для фронтенда.

В `reports/` лежат результаты фактической обработки всех четырёх предоставленных архивов: **15 656 817 входных строк**. В `examples/china_sample.csv` — небольшой реальный фрагмент для быстрого запуска. Полные исходные ZIP и многогигабайтная БД в пакет не включены.

Это проверяемый исследовательский прототип. Harmonized index — показатель зарегистрированной активности, а не восстановленное количество отдельных пожаров. Ночные MODIS-наблюдения не прошли проверку на приемлемое остаточное смещение; API сохраняет предупреждения.

## Быстрый запуск с реальными примерными данными

Нужен **Python 3.12**. Команды выполняются из этой папки.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/demo.py
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Windows: вместо `source` используйте `.venv\Scripts\activate`.

После запуска:

- Swagger: <http://localhost:8000/docs>
- OpenAPI: <http://localhost:8000/openapi.json>
- Проверка сервера: <http://localhost:8000/health>

`demo.py` импортирует **17 075 реальных наблюдений** из области 123–124°E, 44–45°N, создаёт свою модель и сохраняет готовый запрос календаря в `data/demo_calendar_request.json`. Это отдельная демонстрационная модель, не модель полного набора Китая.

```bash
curl -X POST http://localhost:8000/api/v1/analytics/calendar \
  -H 'Content-Type: application/json' \
  --data-binary @data/demo_calendar_request.json
```

## Docker

```bash
docker compose build
docker compose run --rm backend python scripts/demo.py
docker compose up -d
```

Сервис доступен по тому же адресу; данные сохраняются в named volume. Только один worker и один контейнер должны использовать одну DuckDB. Dockerfile предоставлен; в среде проверки Docker отсутствовал, поэтому проверен Python-запуск, а не сборка контейнера.

## Полные ваши данные

Остановите API и используйте новую пустую папку данных для полного набора, чтобы не смешивать его с demo. Поместите исходные архивы в `inputs/`:

- `MODISCHINA.zip`
- `SUOMIVIIRSCHINA.zip`
- `J1VIIRSCHINa.zip`
- `J2VIIRSCHINA.zip`

Одна команда импортирует архивы, обучает модель и повторяет отчёты:

```bash
python scripts/validate_china.py inputs --data-dir data_full --output reports/reproduced
DATA_DIR=data_full uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

В Windows установите `DATA_DIR` обычной командой вашей оболочки. Настройки читаются из переменных окружения и из `backend/.env` (переменные окружения важнее). Docker Compose читает `.env` для подстановки переменных.

Либо импортируйте архивы через `POST /api/v1/datasets/upload`, затем запустите `POST /api/v1/harmonization/calibrate`. Обе операции возвращают `202` и `job_id`; опрашивайте `/api/v1/jobs/{job_id}` до `succeeded` или `failed`. API хранит статусы задач в БД. При перезапуске незавершённые задачи получают `interrupted`; их нужно отправить снова.

Для CLI по шагам:

```bash
python -m app.cli --data-dir data_full import inputs/MODISCHINA.zip inputs/SUOMIVIIRSCHINA.zip inputs/J1VIIRSCHINa.zip inputs/J2VIIRSCHINA.zip
python -m app.cli --data-dir data_full calibrate --output model.json
python -m app.cli --data-dir data_full inspect
```

Не запускайте CLI с той же БД одновременно с API. Через API загрузки и обучение идут в одной очереди. Повторная загрузка идентичного файла идемпотентна по SHA-256.

## Что реализовано по задаче

| Задача | Реализация |
|---|---|
| Чтение MODIS и VIIRS | CSV/ZIP порциями, UTC, приведение Terra/Aqua/SNPP/NOAA20/NOAA21 |
| Очистка | Проверка координат/времени/спутника, аудит ошибок, отдельные правила confidence |
| Различие разрешений | Общая равноплощадная сетка 10 км; исходные точки доступны отдельно |
| Гармонизация | Калибровка активности по спутнику и D/N к SNPP, обучение на пересечении периодов |
| Оценка качества | Отложенный 2025 год, MAE/RMSE/смещение до и после, bootstrap по годам |
| Сопоставление точек | Кандидаты MODIS–VIIRS по геодезическому расстоянию и времени, many-to-many |
| Регион интереса | Bbox, Polygon/MultiPolygon, диапазон дат, выбор D/N и типа аномалии |
| Карта | Нативные точки и полигоны ячеек в GeoJSON, пагинация |
| Burning activity calendar | Помесячный ряд, один источник на месяц, общий пространственный support |
| Сезонность и необычные периоды | 12-месячный профиль, сравнение с предыдущими годами, описательные z-score |
| Выгрузки | CSV точек и календаря |
| Подключение FIRMS | Серверный клиент Area API с `FIRMS_MAP_KEY`; без ключа работает импорт файлов |

Калибровка по умолчанию: train **2013–2024**, test **2025**, reference **SNPP**, MODIS confidence ≥30, VIIRS nominal/high. Шкалы confidence разных сенсоров не считаются одинаковыми вероятностями.

До начала обучения применение коэффициентов возможно только с `allow_extrapolation=true` и отметкой `historical_extrapolation`. API не превращает пропущенные MODIS мелкие пожары в известные исторические события. Для NRT нельзя автоматически применить архивную калибровку.

## Основные endpoints

| Метод | URL | Результат |
|---|---|---|
| GET | `/health` | Доступность, ревизия |
| GET | `/api/v1/overview` | Всё для старта клиента: покрытие, границы, годы, последняя модель, включённые возможности |
| POST | `/api/v1/demo/load` | Фоновая загрузка встроенного реального примера и обучение модели одной задачей |
| GET | `/api/v1/datasets` | Импорты и аудит |
| GET | `/api/v1/coverage` | Фактические временные/пространственные границы файлов |
| POST | `/api/v1/datasets/upload` | Фоновая загрузка `file` в multipart |
| POST | `/api/v1/ingest/firms` | Загрузка FIRMS в фоне |
| GET | `/api/v1/jobs/{job_id}` | Статус и результат задачи |
| POST | `/api/v1/detections/query` | Точки GeoJSON |
| POST | `/api/v1/grid/query` | Сетка GeoJSON |
| POST | `/api/v1/harmonization/calibrate` | Обучение в фоне |
| GET | `/api/v1/harmonization/models` | Модели и признак устаревания |
| GET | `/api/v1/harmonization/models/{model_id}` | Коэффициенты, доверительные интервалы, метрики (`?compact=true` — без списков регионов) |
| POST | `/api/v1/harmonization/matches` | Кандидатные пары наблюдений с координатами обеих точек |
| POST | `/api/v1/harmonization/events` | Пиксели всех спутников, слитые в пространственно-временные события, с признаком согласия сенсоров |
| POST | `/api/v1/analytics/calendar` | Календарь активности |
| POST | `/api/v1/analytics/seasonality` | Сезонность, аномалии, активные месяцы |
| POST | `/api/v1/exports/detections.csv` | Страница исходных точек CSV |
| POST | `/api/v1/exports/calendar.csv` | Календарь CSV |
| GET | `/api/v1/methodology` | Определения и ограничения |

Подробности и последовательность запросов: [docs/frontend.md](docs/frontend.md). Рабочий клиент — `../frontend/src/api.js`; минимальный пример на TypeScript: [examples/frontend_client.ts](examples/frontend_client.ts), примеры запросов: [examples/requests.http](examples/requests.http).

## Интерфейс

Фронтенд лежит в `../frontend`. Для разработки запустите там `npm run dev` — Vite пересылает `/api` и `/health` на этот сервер. После `npm run build` сервер сам раздаёт `../frontend/dist` по адресу `/` (путь меняется переменной `FRONTEND_DIST`, пустое значение отключает раздачу). Пока сборки нет, `/` возвращает короткую подсказку в JSON.

Настройки можно держать в файле `backend/.env` (образец — `.env.example`): его читают сервер, `scripts/demo.py` и CLI; переменные окружения имеют приоритет, тесты файл не читают.

## Проверка качества

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

Проверка настоящих HTTP-запросов через Uvicorn после `demo.py` (при остановленном API):

```bash
python scripts/smoke_http.py
```

`docs/openapi.json` — снимок схемы; после изменения API обновите его командой `python scripts/export_openapi.py`.

Тесты покрывают слияние детекций в события, стартовый `/overview`, загрузку примера одной задачей, раздачу собранного интерфейса, чтение `.env`, импорт/дубликаты, UTC и полночь, разные confidence, геометрию, точную искусственно известную калибровку, отсутствие утечки test в train, устаревшие модели, экстраполяцию, CSV, фоновые задачи и HTTP API. FIRMS-клиент проверяется через mock-ответы; реальный запрос с ключом пользователя не выполнялся.

Полные фактические результаты: [reports/VALIDATION.md](reports/VALIDATION.md). На полном наборе импорт занял 289,4 с, обучение — 4,52 с в среде проверки; это измерение, не обещание для другой машины.

## Эксплуатационные границы

FastAPI + DuckDB рассчитаны здесь на один процесс, региональный набор данных и демонстрацию. Запросы к БД сериализованы; во время публикации нового снимка/обучения они могут ждать. Это не распределённый production-сервис. Для полного набора выделите ориентировочно 8 ГБ RAM и 10+ ГБ свободного места; DuckDB настроена на лимит 3 ГБ и два вычислительных потока, pandas использует дополнительную память.

Docker по умолчанию публикует порт только на localhost. Перед внешним доступом задайте `API_KEY`, подходящий `CORS_ORIGINS`, TLS и лимит тела запроса на reverse proxy. `X-API-Key` защищает все `/api/v1/*`; `/health` и документация открыты. Проверка файла в приложении ограничивает размер 256 MiB, но multipart уже может быть временно записан сервером до этой проверки — внешний лимит нужен для публичного хостинга.

Смена сетки требует новой БД; повторный импорт меняет ревизию, и прежняя модель становится `stale`. Автоматического переобучения или скрытой подмены модели нет.

Метод, формулы и научные ограничения: [docs/methodology.md](docs/methodology.md). NASA/FIRMS источники: [docs/sources.md](docs/sources.md).
