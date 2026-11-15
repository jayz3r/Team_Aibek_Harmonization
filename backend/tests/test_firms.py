import httpx
import pandas as pd
import pytest

from app.firms import import_firms
from app.config import InputError
from app.schemas import FirmsRequest
from conftest import observation


def test_firms_import_with_mocked_response(store, monkeypatch):
    store.settings.firms_map_key = "private-demo-key"
    body = pd.DataFrame([observation(version="2.0NRT")]).to_csv(index=False)
    real_client = httpx.Client
    def transport(request):
        assert request.url.host == "firms.modaps.eosdis.nasa.gov"
        assert request.url.path.endswith("/1/2023-01-01")
        return httpx.Response(200, text=body)
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(transport), **kwargs))
    result = import_firms(store, FirmsRequest(source="VIIRS_SNPP_NRT", area={"bbox": [90, 10, 110, 40]}, start="2023-01-01"))
    assert result["revision"] == 1
    assert store.records("SELECT processing FROM detections")[0]["processing"] == "NRT"


def test_firms_network_errors_do_not_reveal_key(store, monkeypatch):
    store.settings.firms_map_key = "private-demo-key"
    real_client = httpx.Client
    def transport(request):
        raise httpx.ConnectError(f"failed {request.url}", request=request)
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(transport), **kwargs))
    with pytest.raises(InputError) as error:
        import_firms(store, FirmsRequest(source="MODIS_NRT", area={"bbox": [90, 10, 110, 40]}))
    assert "private-demo-key" not in str(error.value)
