# Интеграция с фронтендом

Все даты включительны, UTC. Координаты GeoJSON — `[longitude, latitude]`. `bbox` — `[west, south, east, north]`. POST-запросы аналитики читают данные и ничего не публикуют.

## Старт клиента

`GET /api/v1/overview` одним запросом отдаёт всё, что нужно интерфейсу при запуске: `revision`, число детекций по потокам, `coverage` (границы файлов по спутникам для archive и NRT), общий `bounds`, диапазоны лет `years`, последнюю модель без списков регионов (`latest_model`, поле `stale` показывает устаревание) и `capabilities` (`firms_live`, `auth_required`, `demo_sample`). Клиент сравнивает `revision` из `/health` со своей и перезагружает `overview` при изменении.

`POST /api/v1/demo/load` импортирует встроенный реальный пример и обучает модель одной фоновой задачей; в `result` — `dataset_id` и `model_id`.

## Последовательность

1. Загрузить CSV/ZIP через `/api/v1/datasets/upload` (`multipart/form-data`, поле `file`).
2. Опросить возвращённый `status_url`. В успешном job результат импорта лежит в `result`.
3. После всех импортов отправить `{}` на `/api/v1/harmonization/calibrate`.
4. Дождаться job `succeeded`. **`result.id` — это model_id**, не job_id.
5. Передавать model_id календарю и seasonality. Для сырой карты модель не нужна.
6. После новых импортов переобучить модель. Использование stale-модели возвращает 409.

Пример клиента для React/Vue — `examples/frontend_client.ts`. Код не привязан к библиотеке карт. GeoJSON можно передать в MapLibre/Leaflet.

## Карта

```json
{
  "start": "2025-03-01",
  "end": "2025-03-31",
  "area": {"bbox": [123, 44, 124, 45]},
  "platforms": ["Aqua", "SNPP", "NOAA20", "NOAA21"],
  "daynight": "both",
  "processing": "archive",
  "quality_only": true,
  "limit": 1000,
  "offset": 0
}
```

Отправить на `POST /api/v1/detections/query`. Ответ — `FeatureCollection`, `properties` содержит platform, sensor, UTC-время, confidence, FRP, scan/track, processing, hotspot_type, dataset_id/source_member. `meta.has_more` и `next_offset` обеспечивают пагинацию. Максимум 10 000 точек на страницу.

Для полигона замените area:

```json
{"polygon":{"type":"Polygon","coordinates":[[[123,44],[124,44],[123.5,45],[123,44]]]}}
```

Для `POST /api/v1/grid/query` вместо `platforms` передайте `platform: "SNPP"`. Полигон каждой ячейки имеет `active_cell_days`, `detection_count`, `frp_max_mw`. Сетка — аналитическая, её не следует называть выгоревшей площадью. Лимит 20 000 ячеек на страницу.

## События и связи

`POST /api/v1/harmonization/events` принимает поля карты (`area`, `start`, `end`, `daynight`, `processing`, `platforms`, `quality_only`) и `distance_km` (1.5), `gap_hours` (36), `min_detections` (1), `limit` (2000). Интервал — не более 31 дня, на входе не более 60 000 точек. Ответ — `FeatureCollection` центров событий; в `properties`: `detections`, `modis_detections`, `viirs_detections`, `agreement` (`both` / `modis_only` / `viirs_only`), `detections_by_platform`, `first_seen`, `last_seen`, `duration_hours`, `active_days`, `frp_max_mw`, `bbox`. В `summary` — число событий и пикселей по классам согласия. `summary` считается по всем событиям, а `min_detections` и `limit` ограничивают только список `features`.

`POST /api/v1/harmonization/matches` в каждой паре возвращает `modis_lonlat` и `viirs_lonlat` (`[longitude, latitude]`), поэтому связь можно нарисовать без дополнительного запроса точек; в `summary` есть `matched_modis_pct` и `matched_viirs_pct`.

## Календарь

```json
{
  "start": "2002-01-01",
  "end": "2025-12-31",
  "model_id": "ID_ИЗ_РЕЗУЛЬТАТА_ОБУЧЕНИЯ",
  "platform": "auto",
  "daynight": "D",
  "allow_extrapolation": true
}
```

Отправить на `POST /api/v1/analytics/calendar`. Каждый `rows[]` — один месяц. Для heatmap используйте year/month и `harmonized_index`. Null показывайте отдельным нейтральным цветом, без замены на 0.

| Поле | Отображение/смысл |
|---|---|
| `harmonized_index` | Сопоставимый экспериментальный индекс на общей пространственной поддержке |
| `detection_counts_by_platform` | Число детекций пикселей каждого спутника в выборке |
| `raw_by_platform` | Число занятых ячейко-дней каждого спутника до калибровки |
| `selected_platform` | Единственный источник итогового значения месяца |
| `excluded_cell_days` | Активность вне общей обучающей пространственной поддержки |
| `flags` | Предупреждения, которые необходимо показывать рядом с графиком |
| `components` | Коэффициенты и D/N-компоненты конкретного месяца |

Для удобного выбора периода `coverage` даёт границы файлов; это не оценка облачности или успешности наблюдений. До начала файлов платформы `raw_by_platform` равно null; нулевое значение внутри диапазона означает отсутствие записей. Первые/последние неполные файловые месяцы платформ перечислены в `partial_span_platforms`.

`historical_extrapolation`, `validation_warning`, `partial_spatial_support` нельзя скрывать и выдавать ряд за подтверждённое число исторических пожаров. Режим `hotspot_scope=all` следует подписывать «тепловые аномалии / активные горячие точки». Режим `vegetation` — «предполагаемые очаги горения растительности».

## Сезонность

На `POST /api/v1/analytics/seasonality` передаются поля календаря и:

```json
{"baseline_start_year":2013,"baseline_end_year":2024,"min_baseline_years":3}
```

Для target используйте `start=2025-01-01`, `end=2025-12-31`. Ответ содержит `seasonal_profile` из 12 месяцев, `anomalies` по запрошенным месяцам и `historically_active_months`. Это аналитика прошлого, не прогноз вероятности будущего пожара.

## Экспорт, авторизация, ошибки

`exports/calendar.csv` принимает тот же body, что calendar. `exports/detections.csv` принимает тот же body и **те же limit/offset**, что карта. Для полного экспорта точек переберите страницы с одинаковыми фильтрами; endpoint не обещает выдать все миллионы точек одной загрузкой. При нескольких страницах убедитесь, что `/health.revision` не изменился, иначе повторите выгрузку на стабильном снимке.

При заданном серверном `API_KEY` отправляйте `X-API-Key` во всех `/api/v1/*` запросах. Не добавляйте ключ NASA FIRMS в браузер: он хранится только на backend. Общий API_KEY подходит для закрытой демонстрации; полноценные персональные аккаунты и роли не реализованы.

| Статус | Причина |
|---|---|
| 202 | Задача принята; требуется polling |
| 401 | Не передан или неверен API_KEY |
| 404 | Не найден job/model |
| 409 | Модель устарела либо очередь заполнена |
| 413 | Загрузка больше лимита |
| 422 | Некорректная схема/геометрия/даты или метод неприменим к данным |
| 503 | FIRMS_MAP_KEY не настроен |

Ошибки фоновой задачи находятся в `job.error`, при этом сам запрос статуса возвращает 200. Нельзя считать 202 завершением импорта.

Swagger `/docs` описывает параметры запросов. Снимок схемы лежит в `docs/openapi.json`. Ответы аналитики описаны здесь и в примерах; frontend-клиент включает базовые TypeScript-типы календаря.
