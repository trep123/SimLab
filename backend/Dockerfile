FROM python:3.12.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/backend
COPY backend/requirements/production.lock.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY backend /app/backend
COPY assets /app/assets
COPY simulator /app/simulator
ENV PYTHONPATH=/app:/app/backend
RUN useradd --create-home --uid 10001 simlab && chown -R simlab:simlab /app
USER simlab
CMD ["uvicorn", "config.asgi:application", "--host", "0.0.0.0", "--port", "8000"]
