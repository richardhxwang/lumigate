FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ curl && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir setuptools wheel

# Step 1: Install smartmoneyconcepts FIRST — it pins numpy==1.24.3, numba==0.58.1,
# llvmlite==0.41.1, pandas==2.0.2. These must not be overridden.
RUN pip install --no-cache-dir smartmoneyconcepts

# Step 2: Install remaining deps. None of these should touch numpy/pandas.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Step 3: vectorbt (optional, heavy). Install everything with numpy<1.25 constraint
# to prevent any dep from upgrading numpy past what smartmoneyconcepts requires.
RUN pip install --no-cache-dir --no-deps vectorbt && \
    pip install --no-cache-dir "numpy<1.25" \
        "scipy<1.12" "scikit-learn<1.4" "matplotlib<3.9" \
        plotly dateparser schedule dill tqdm imageio \
        ipywidgets anywidget mypy_extensions || \
    echo "vectorbt install failed (optional)"

# Step 4: ib_insync for IBKR broker connectivity (optional, needs TWS/IB Gateway at runtime)
RUN pip install --no-cache-dir ib_insync || echo "ib_insync install failed (optional)"

COPY . .

EXPOSE 3200

HEALTHCHECK --interval=10s --timeout=3s --retries=2 --start-period=15s \
    CMD curl -sf http://127.0.0.1:3200/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3200"]
