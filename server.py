from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.app import create_app

ROOT = Path(__file__).resolve().parent
app = create_app()
DOCUMENTS = {
    "harvesters_evidence.xlsx": ("Доказательная карта: техника, параметры, источники", "XLSX"),
    "itles_report.docx": ("Технический отчёт — редактируемый документ", "DOCX"),
    "itles_report.pdf": ("Технический отчёт — версия для чтения", "PDF"),
    "itles_source.zip": ("Исходники, тесты и инструкции запуска", "ZIP"),
}


@app.middleware("http")
async def response_safety(request: Request, call_next):
    if request.method not in {"GET", "HEAD", "OPTIONS"} and request.url.path != "/api/ingest":
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site" or (origin and urlsplit(origin).netloc != request.headers.get("host")):
            return JSONResponse({"detail": "cross-origin mutation is not allowed"}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/documents")
def documents():
    return {"documents": [{"name": name, "title": title, "format": format_, "url": f"/api/documents/{name}"} for name, (title, format_) in DOCUMENTS.items() if (ROOT / "deliverables" / name).is_file()]}


@app.get("/api/documents/{name}")
def document(name: str):
    if name not in DOCUMENTS or not (ROOT / "deliverables" / name).is_file():
        raise HTTPException(404, "document not available")
    return FileResponse(ROOT / "deliverables" / name, filename=name)


if (ROOT / "frontend/dist/assets").is_dir():
    app.mount("/assets", StaticFiles(directory=ROOT / "frontend/dist/assets"), name="assets")


@app.get("/{path:path}")
def frontend(path: str):
    if path.startswith("api/") or path in {"api", "docs", "redoc"}:
        raise HTTPException(404, "not found")
    public_root = ROOT / "frontend/dist"
    candidate = (public_root / path).resolve()
    if candidate.is_relative_to(public_root) and candidate.is_file() and candidate.suffix in {".geojson", ".json", ".svg", ".png", ".ico", ".txt"}:
        return FileResponse(candidate)
    index = public_root / "index.html"
    if not index.is_file():
        raise HTTPException(503, "frontend build is not available; run the setup script")
    return FileResponse(index, headers={"Cache-Control": "no-cache"})
