FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY brain ./brain
RUN pip install --no-cache-dir . && useradd --uid 10001 --create-home app && mkdir /app/data && chown app /app/data
USER app
EXPOSE 8000
CMD ["uvicorn", "brain.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
