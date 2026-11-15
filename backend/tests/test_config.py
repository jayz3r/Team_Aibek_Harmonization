from app.config import Settings, read_dotenv, _origins


def test_origins_tolerate_spaces_and_slashes():
    assert _origins(" http://localhost:5173/ , ,http://127.0.0.1:5173") == [
        "http://localhost:5173", "http://127.0.0.1:5173"]


def test_dotenv_reader(tmp_path):
    path = tmp_path / ".env"
    path.write_text('# comment\nAPI_KEY="secret value"\nexport FIRMS_MAP_KEY=abc\nBROKEN LINE\nEMPTY=\n', encoding="utf-8")
    assert read_dotenv(path) == {"API_KEY": "secret value", "FIRMS_MAP_KEY": "abc", "EMPTY": ""}
    assert read_dotenv(tmp_path / "missing.env") == {}


def test_environment_wins_over_dotenv_and_tests_ignore_dotenv(tmp_path, monkeypatch):
    path = tmp_path / ".env"
    path.write_text("API_KEY=from-file\nFIRMS_MAP_KEY=file-key\nFRONTEND_DIST=\n", encoding="utf-8")
    monkeypatch.setenv("API_KEY", "from-env")
    monkeypatch.delenv("FIRMS_MAP_KEY", raising=False)
    monkeypatch.delenv("FRONTEND_DIST", raising=False)
    settings = Settings.from_env(path)
    assert settings.api_key == "from-env" and settings.firms_map_key == "file-key"
    assert settings.frontend_dist is None  # blank value disables static serving
    assert Settings().firms_map_key == ""  # plain Settings() never reads .env
