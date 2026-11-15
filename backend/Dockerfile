FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN useradd --create-home appuser && mkdir /app/data && chown appuser:appuser /app/data
COPY --chown=appuser:appuser app ./app
COPY --chown=appuser:appuser examples ./examples
COPY --chown=appuser:appuser scripts ./scripts
USER appuser
ENV DATA_DIR=/app/data PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
