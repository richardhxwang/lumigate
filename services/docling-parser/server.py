"""
Docling-based PDF/document parser microservice.

Provides high-quality table extraction using IBM's docling library.
Listens on port 3102. Intended as an optional enhanced parser alongside
the standard Node.js file-parser.

POST /parse  — multipart/form-data with a "file" field
Returns: { ok, text, tables[], pages, engine }

GET /health  — health check
"""

import json
import os
import sys
import tempfile
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from io import BytesIO
from urllib.parse import parse_qs

# ---------------------------------------------------------------------------
# Lazy-load docling (heavy import ~5s, only do it once)
# ---------------------------------------------------------------------------

_converter = None


def get_converter():
    global _converter
    if _converter is None:
        from docling.document_converter import DocumentConverter
        _converter = DocumentConverter()
    return _converter


# ---------------------------------------------------------------------------
# Multipart parser (minimal, no external deps)
# ---------------------------------------------------------------------------

def parse_multipart(body: bytes, content_type: str):
    """Extract the first file part from multipart/form-data."""
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part[len("boundary="):].strip('"')
            break
    if not boundary:
        raise ValueError("No boundary in Content-Type")

    delimiter = f"--{boundary}".encode()
    parts = body.split(delimiter)
    for part in parts[1:]:  # skip preamble
        if part.startswith(b"--"):
            break  # closing delimiter
        # Split headers from body
        header_end = part.find(b"\r\n\r\n")
        if header_end == -1:
            continue
        headers = part[:header_end].decode("utf-8", errors="replace")
        file_body = part[header_end + 4:]
        # Remove trailing \r\n
        if file_body.endswith(b"\r\n"):
            file_body = file_body[:-2]

        if 'name="file"' in headers:
            # Extract filename
            filename = "document.pdf"
            for h in headers.split("\r\n"):
                if "filename=" in h:
                    start = h.index("filename=") + len("filename=")
                    fn = h[start:].strip().strip('"')
                    if fn:
                        filename = fn
                    break
            return filename, file_body

    raise ValueError('No "file" field in multipart body')


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

class DoclingHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {
                "status": "ok",
                "service": "docling-parser",
                "engine": "docling",
            })
            return
        self._json_response(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if self.path != "/parse":
            self._json_response(404, {"ok": False, "error": "Use POST /parse"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            content_type = self.headers.get("Content-Type", "")

            if "multipart/form-data" not in content_type:
                self._json_response(400, {"ok": False, "error": "Expected multipart/form-data"})
                return

            filename, file_data = parse_multipart(body, content_type)

            # Write to temp file (docling needs a file path)
            suffix = os.path.splitext(filename)[1] or ".pdf"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                f.write(file_data)
                tmp_path = f.name

            try:
                result = self._convert(tmp_path)
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

            self._json_response(200, {
                "ok": True,
                "filename": filename,
                "text": result["text"],
                "tables": result["tables"],
                "pages": result["pages"],
                "engine": "docling",
            })

        except Exception as e:
            traceback.print_exc()
            self._json_response(500, {
                "ok": False,
                "error": f"Docling parse failed: {str(e)}",
            })

    def _convert(self, file_path: str) -> dict:
        """Run docling conversion and extract text + tables."""
        converter = get_converter()
        result = converter.convert(file_path)
        doc = result.document

        # Full document as markdown (preserves table structure)
        text = doc.export_to_markdown()

        # Extract individual tables as CSV
        tables = []
        for table in doc.tables:
            try:
                df = table.export_to_dataframe()
                csv_str = df.to_csv(index=False)
                tables.append(csv_str)
            except Exception:
                # Some tables may fail to convert to DataFrame
                pass

        # Page count
        pages = len(doc.pages) if hasattr(doc, "pages") else 0

        return {"text": text, "tables": tables, "pages": pages}

    def _json_response(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        """Prefix log messages with service name."""
        sys.stderr.write(f"[docling-parser] {format % args}\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3102"))
    server = HTTPServer(("0.0.0.0", port), DoclingHandler)
    print(f"[docling-parser] Listening on :{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[docling-parser] Shutting down")
        server.server_close()
