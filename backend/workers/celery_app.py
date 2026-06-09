"""
Celery application configuration.
"""
from celery import Celery
from config import config

celery_app = Celery(
    "manga_bliss",
    broker=config.REDIS_URL,
    backend=config.REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Ho_Chi_Minh",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=300,  # 5 min max per task
    worker_max_tasks_per_child=100,
)

# Auto-discover tasks
celery_app.autodiscover_tasks(["workers"])
