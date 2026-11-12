from fastapi import FastAPI

from app.config import Settings
from app.api.routes_repo import router as repo_router
from app.api.routes_ask import router as ask_router



app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "app": Settings.app_name}



app.include_router(repo_router)
app.include_router(ask_router)