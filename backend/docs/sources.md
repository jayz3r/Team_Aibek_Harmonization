# Источники и границы использования

Проверено 14 ноября 2026 года. Использованы первичные описания продуктов NASA и документация библиотек. Ни один сторонний backend проекта другого участника не копировался.

- [Официальная страница challenge](https://www.spaceappschallenge.org/2026/challenges/harmonization-of-modis-and-viirs-hot-spots/). Во время проверки полный текст страницы возвращал 502; краткая официальная формулировка о harmonized burning activity calendar и выбранном AOI была доступна в индексе сайта и [официальной карточке команды/челленджа](https://www.spaceappschallenge.org/2026/find-a-team/harmonova/).
- [Обсуждение challenge в NASA/spaceapps](https://github.com/nasa/spaceapps/discussions/2016): допустимость регионального решения и акцент на harmonization/calendar. Это ответ Navigator, не научная сертификация метода этого проекта.
- [NASA FIRMS — VIIRS attributes](https://firms.modaps.eosdis.nasa.gov/content/descriptions/FIRMS_VIIRS_Firehotspots.html): I4, scan/track, UTC, confidence l/n/h, FRP, processing versions, hotspot type.
- [NASA MODAPS — MODIS MCD14DL](https://modaps.modaps.eosdis.nasa.gov/services/about/products/c61-nrt/MCD14DL-NRT.html): нативные пиксели около 1 км в надире, каналы, confidence, FRP, дополнительные тепловые аномалии.
- [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/area/): CSV URL, bbox west/south/east/north, источник, MAP_KEY, диапазон 1–5 дней на запрос.
- [FIRMS active fire downloads](https://firms.modaps.eosdis.nasa.gov/content/active_fire/): standard и NRT продукты, рекомендация standard для научного анализа.
- [VIIRS Collection 2 user guide](https://www.earthdata.nasa.gov/s3fs-public/2024-07/VIIRS_C2_AF-375m_User_Guide_1.0.pdf): справочный материал для следующей стадии работы с L2 масками и footprint/FRP.
- [FastAPI file uploads](https://fastapi.tiangolo.com/tutorial/request-files/) и [testing](https://fastapi.tiangolo.com/tutorial/testing/).
- [DuckDB Python API](https://duckdb.org/docs/stable/clients/python/overview).

Даты начала разных продуктов в справочных страницах не всегда совпадают с датами пользовательских архивов: например, в предоставленном NOAA-21 CSV есть записи с марта 2023 года. Backend сообщает фактические даты из файлов и их source/version, не переобозначая их как подтверждённую официальную доступность продукта. Аналогично NRT SNPP в этих файлах заканчивается 2 ноября 2026 года.

Научная схема сетки, коэффициентов, support, диагностических порогов и календаря — реализованный здесь экспериментальный baseline, а не утверждённый NASA универсальный алгоритм. Данные предоставлены пользователем из FIRMS; сохраняйте указание NASA FIRMS/LANCE и атрибуцию соответствующих MODIS/VIIRS продуктов при демонстрации.
