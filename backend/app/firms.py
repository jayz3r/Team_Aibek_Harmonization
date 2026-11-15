from pathlib import Path
from urllib.parse import quote

import httpx

from .config import InputError
from .ingest import ingest_file


def import_firms(store, request, progress=None):
    key = store.settings.firms_map_key
    if not key:
        raise InputError("Set FIRMS_MAP_KEY on the server to enable FIRMS imports")
    bbox = ",".join(str(x) for x in request.area.bbox)
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{quote(key, safe='')}/{request.source}/{bbox}/{request.days}"
    if request.start:
        url += f"/{request.start.isoformat()}"
    import tempfile
    with tempfile.TemporaryDirectory(dir=store.settings.data_dir) as tmp:
        path = Path(tmp) / f"firms_{request.source}.csv"
        try:
            with httpx.Client(timeout=60, follow_redirects=False) as client:
                with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise InputError(f"FIRMS returned HTTP {response.status_code}; verify key and date availability")
                    size = 0
                    with path.open("wb") as handle:
                        for block in response.iter_bytes(65536):
                            size += len(block)
                            if size > store.settings.max_upload_bytes:
                                raise InputError("FIRMS response exceeds size limit; narrow area")
                            handle.write(block)
        except httpx.HTTPError:
            # HTTPX errors may contain the credential in the request URL.
            raise InputError("FIRMS request failed or timed out; verify connectivity and key") from None
        with path.open("rb") as handle:
            header = handle.readline(4096).decode("utf-8-sig", errors="replace").lower()
        if "latitude" not in header or "longitude" not in header:
            raise InputError("FIRMS did not return a hotspot CSV; check key, product and date availability")
        return ingest_file(store, path, progress=progress)
