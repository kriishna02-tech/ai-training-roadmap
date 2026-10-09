FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY limiter ./limiter
RUN pip install --no-cache-dir . && useradd --uid 10001 --create-home app
USER app
EXPOSE 8000
CMD ["uvicorn", "limiter.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
