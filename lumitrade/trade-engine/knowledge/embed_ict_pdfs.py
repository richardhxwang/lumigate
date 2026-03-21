"""Parse ICT Mentorship PDFs and embed into trading RAG.

Run from host (not inside Docker):
  python3 lumitrade/trade-engine/knowledge/embed_ict_pdfs.py

Requires: file-parser running on localhost:18782, trade-engine on localhost:18793
"""
import json
import os
import sys
import urllib.request
import urllib.parse
from pathlib import Path

FILE_PARSER_URL = "http://localhost:18782/parse"
RAG_KNOWLEDGE_URL = "http://localhost:18793/rag/knowledge"
ICT_DIR = Path(__file__).parent.parent.parent / "ICT"  # lumitrade/ICT/

# Chunk long text into ~1500 char segments with overlap
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200


def chunk_text(text: str, title: str) -> list[dict]:
    """Split text into overlapping chunks for better RAG retrieval."""
    text = text.strip()
    if len(text) <= CHUNK_SIZE:
        return [{"title": title, "content": text, "category": "ict_mentorship"}]

    chunks = []
    start = 0
    part = 1
    while start < len(text):
        end = start + CHUNK_SIZE
        chunk = text[start:end]
        chunks.append({
            "title": f"{title} (part {part})",
            "content": chunk,
            "category": "ict_mentorship",
        })
        start = end - CHUNK_OVERLAP
        part += 1
    return chunks


def parse_pdf(pdf_path: str) -> str:
    """Send PDF to file-parser and get extracted text."""
    boundary = "----PdfBoundary"
    filename = os.path.basename(pdf_path)

    with open(pdf_path, "rb") as f:
        file_data = f.read()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: application/pdf\r\n\r\n"
    ).encode() + file_data + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        FILE_PARSER_URL,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
        return result.get("text", "")


def embed_docs(docs: list[dict]):
    """Send docs to trade-engine RAG knowledge endpoint."""
    data = json.dumps({"docs": docs}).encode()
    req = urllib.request.Request(
        RAG_KNOWLEDGE_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def main():
    if not ICT_DIR.exists():
        print(f"ICT directory not found: {ICT_DIR}")
        sys.exit(1)

    pdfs = sorted([f for f in ICT_DIR.iterdir() if f.suffix.lower() == ".pdf"])
    print(f"Found {len(pdfs)} PDFs in {ICT_DIR}")

    total_chunks = 0
    for pdf_path in pdfs:
        print(f"\nProcessing: {pdf_path.name} ({pdf_path.stat().st_size / 1024 / 1024:.1f}MB)")

        try:
            text = parse_pdf(str(pdf_path))
            if not text or len(text) < 100:
                print(f"  Skipped (too short: {len(text)} chars)")
                continue

            title = pdf_path.stem  # filename without extension
            chunks = chunk_text(text, title)
            print(f"  Extracted {len(text)} chars -> {len(chunks)} chunks")

            # Embed in batches of 10
            for i in range(0, len(chunks), 10):
                batch = chunks[i:i+10]
                result = embed_docs(batch)
                print(f"  Embedded batch {i//10+1}: {result}")

            total_chunks += len(chunks)
        except Exception as e:
            print(f"  ERROR: {e}")

    print(f"\nDone! Total chunks embedded: {total_chunks}")


if __name__ == "__main__":
    main()
