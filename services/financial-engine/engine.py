#!/usr/bin/env python3
"""
Financial Calculation Engine for LumiGate.

Models:
  - DCF valuation (Discounted Cash Flow)
  - Black-Scholes option pricing with Greeks
  - Monte Carlo VaR (Value at Risk)

Usage:
  stdin/stdout mode (default):
    echo '{"model":"dcf","params":{...}}' | python engine.py

  HTTP server mode:
    python engine.py --server
    curl -X POST http://localhost:3102/calculate -d '{"model":"dcf","params":{...}}'
"""

import json
import math
import sys
from typing import Any, Dict, List, Optional

import numpy as np
from scipy import stats


# ── DCF Valuation ─────────────────────────────────────────────────────────────

def dcf_valuation(params: Dict[str, Any]) -> Dict[str, Any]:
    """Discounted Cash Flow valuation.

    Params:
        fcf: list of projected Free Cash Flow values (year 1, 2, ... N)
        wacc: Weighted Average Cost of Capital (decimal, e.g. 0.10 for 10%)
        terminal_growth: perpetual growth rate (decimal, e.g. 0.02 for 2%)
        net_debt: (optional) net debt to subtract for equity value
        shares_outstanding: (optional) for per-share value

    Returns:
        pv_fcfs: list of PV of each FCF
        terminal_value: undiscounted terminal value
        pv_terminal: present value of terminal value
        enterprise_value: sum of PV(FCFs) + PV(terminal)
        equity_value: enterprise_value - net_debt
        per_share: equity_value / shares_outstanding (if provided)
    """
    fcf = params.get("fcf") or []
    wacc = float(params.get("wacc", 0.10))
    terminal_growth = float(params.get("terminal_growth", 0.02))
    net_debt = float(params.get("net_debt", 0))
    shares = params.get("shares_outstanding")

    if not fcf:
        return {"error": "fcf (list of projected free cash flows) is required"}
    if wacc <= terminal_growth:
        return {"error": "wacc must be greater than terminal_growth"}

    fcf = [float(x) for x in fcf]
    n = len(fcf)

    # PV of each projected FCF
    pv_fcfs = []
    for i, cf in enumerate(fcf):
        pv = cf / ((1 + wacc) ** (i + 1))
        pv_fcfs.append(round(pv, 2))

    # Terminal value using Gordon Growth Model
    terminal_fcf = fcf[-1] * (1 + terminal_growth)
    terminal_value = terminal_fcf / (wacc - terminal_growth)
    pv_terminal = terminal_value / ((1 + wacc) ** n)

    enterprise_value = sum(pv_fcfs) + pv_terminal
    equity_value = enterprise_value - net_debt

    result = {
        "pv_fcfs": pv_fcfs,
        "sum_pv_fcfs": round(sum(pv_fcfs), 2),
        "terminal_value": round(terminal_value, 2),
        "pv_terminal": round(pv_terminal, 2),
        "enterprise_value": round(enterprise_value, 2),
        "equity_value": round(equity_value, 2),
    }

    if shares is not None and float(shares) > 0:
        result["per_share"] = round(equity_value / float(shares), 2)
        result["shares_outstanding"] = float(shares)

    return result


# ── Black-Scholes Option Pricing ──────────────────────────────────────────────

def black_scholes(params: Dict[str, Any]) -> Dict[str, Any]:
    """Black-Scholes option pricing with Greeks.

    Params:
        S: current stock price
        K: strike price
        T: time to expiration in years
        r: risk-free rate (decimal)
        sigma: volatility (decimal, e.g. 0.20 for 20%)
        option_type: "call" or "put" (default "call")

    Returns:
        call_price, put_price, delta, gamma, theta, vega, rho
    """
    S = float(params.get("S", 0))
    K = float(params.get("K", 0))
    T = float(params.get("T", 0))
    r = float(params.get("r", 0))
    sigma = float(params.get("sigma", 0))

    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return {"error": "S, K, T, and sigma must all be positive"}

    sqrt_T = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * sqrt_T)
    d2 = d1 - sigma * sqrt_T

    nd1 = stats.norm.cdf(d1)
    nd2 = stats.norm.cdf(d2)
    nd1_neg = stats.norm.cdf(-d1)
    nd2_neg = stats.norm.cdf(-d2)
    pdf_d1 = stats.norm.pdf(d1)

    call_price = S * nd1 - K * math.exp(-r * T) * nd2
    put_price = K * math.exp(-r * T) * nd2_neg - S * nd1_neg

    # Greeks
    delta_call = nd1
    delta_put = nd1 - 1
    gamma = pdf_d1 / (S * sigma * sqrt_T)
    theta_call = (-(S * pdf_d1 * sigma) / (2 * sqrt_T)
                  - r * K * math.exp(-r * T) * nd2) / 365
    theta_put = (-(S * pdf_d1 * sigma) / (2 * sqrt_T)
                 + r * K * math.exp(-r * T) * nd2_neg) / 365
    vega = S * pdf_d1 * sqrt_T / 100  # per 1% move in vol
    rho_call = K * T * math.exp(-r * T) * nd2 / 100
    rho_put = -K * T * math.exp(-r * T) * nd2_neg / 100

    return {
        "call_price": round(call_price, 4),
        "put_price": round(put_price, 4),
        "d1": round(d1, 6),
        "d2": round(d2, 6),
        "greeks": {
            "delta_call": round(delta_call, 6),
            "delta_put": round(delta_put, 6),
            "gamma": round(gamma, 6),
            "theta_call": round(theta_call, 6),
            "theta_put": round(theta_put, 6),
            "vega": round(vega, 6),
            "rho_call": round(rho_call, 6),
            "rho_put": round(rho_put, 6),
        },
    }


# ── Monte Carlo VaR ──────────────────────────────────────────────────────────

def monte_carlo_var(params: Dict[str, Any]) -> Dict[str, Any]:
    """Monte Carlo Value at Risk estimation.

    Params:
        returns: list of historical return values (decimal, e.g. [-0.02, 0.01, ...])
        confidence: confidence level (e.g. 0.95 or 0.99)
        horizon: holding period in days (default 1)
        simulations: number of Monte Carlo paths (default 10000)
        portfolio_value: (optional) portfolio value to convert VaR to dollar amount

    Returns:
        var_pct: VaR as percentage loss
        var_dollar: VaR in dollar terms (if portfolio_value given)
        cvar_pct: Conditional VaR (Expected Shortfall)
        cvar_dollar: CVaR in dollar terms
        stats: mean, std, skew, kurtosis of the return distribution
    """
    returns = params.get("returns") or []
    confidence = float(params.get("confidence", 0.95))
    horizon = int(params.get("horizon", 1))
    simulations = int(params.get("simulations", 10000))
    portfolio_value = params.get("portfolio_value")

    if not returns or len(returns) < 5:
        return {"error": "At least 5 historical return observations are required"}
    if not (0.5 < confidence < 1.0):
        return {"error": "confidence must be between 0.5 and 1.0"}

    returns_arr = np.array([float(x) for x in returns])
    mu = float(np.mean(returns_arr))
    sigma = float(np.std(returns_arr, ddof=1))

    if sigma == 0:
        return {"error": "Standard deviation of returns is zero; cannot estimate VaR"}

    # Simulate returns over the horizon
    np.random.seed(42)  # reproducible
    simulated = np.random.normal(
        mu * horizon,
        sigma * math.sqrt(horizon),
        simulations,
    )

    # VaR: loss at the (1-confidence) percentile
    var_pct = -float(np.percentile(simulated, (1 - confidence) * 100))

    # CVaR (Expected Shortfall): average loss beyond VaR
    tail = simulated[simulated <= -var_pct]
    cvar_pct = -float(np.mean(tail)) if len(tail) > 0 else var_pct

    result: Dict[str, Any] = {
        "var_pct": round(var_pct, 6),
        "cvar_pct": round(cvar_pct, 6),
        "confidence": confidence,
        "horizon_days": horizon,
        "simulations": simulations,
        "stats": {
            "mean": round(mu, 6),
            "std": round(sigma, 6),
            "skew": round(float(stats.skew(returns_arr)), 6),
            "kurtosis": round(float(stats.kurtosis(returns_arr)), 6),
            "observations": len(returns_arr),
        },
    }

    if portfolio_value is not None:
        pv = float(portfolio_value)
        result["var_dollar"] = round(var_pct * pv, 2)
        result["cvar_dollar"] = round(cvar_pct * pv, 2)
        result["portfolio_value"] = pv

    return result


# ── Dispatcher ────────────────────────────────────────────────────────────────

MODELS = {
    "dcf": dcf_valuation,
    "black_scholes": black_scholes,
    "bs": black_scholes,
    "monte_carlo_var": monte_carlo_var,
    "var": monte_carlo_var,
}


def dispatch(payload: Dict[str, Any]) -> Dict[str, Any]:
    model = str(payload.get("model", "")).strip().lower()
    params = payload.get("params") or {}

    if model not in MODELS:
        return {
            "ok": False,
            "error": f"Unknown model: {model}",
            "available_models": list(MODELS.keys()),
        }

    try:
        result = MODELS[model](params)
        if "error" in result:
            return {"ok": False, "error": result["error"], "model": model}
        return {"ok": True, "model": model, "result": result}
    except Exception as e:
        return {"ok": False, "error": str(e), "model": model}


# ── stdin/stdout mode ─────────────────────────────────────────────────────────

def run_stdio():
    raw = sys.stdin.read()
    if not raw.strip():
        out = {"ok": False, "error": "Empty input. Send JSON: {\"model\":\"dcf\",\"params\":{...}}"}
    else:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            out = {"ok": False, "error": f"Invalid JSON: {e}"}
        else:
            out = dispatch(payload)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


# ── HTTP server mode ──────────────────────────────────────────────────────────

def run_server(port: int = 3102):
    from http.server import HTTPServer, BaseHTTPRequestHandler

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # Suppress default logging; print our own format
            print(f"[financial-engine] {args[0]}" if args else "")

        def _send_json(self, code: int, data: dict):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send_json(200, {
                    "status": "ok",
                    "service": "financial-engine",
                    "models": list(MODELS.keys()),
                })
            else:
                self._send_json(404, {"error": "Not found"})

        def do_POST(self):
            if self.path != "/calculate":
                self._send_json(404, {"error": "Use POST /calculate"})
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError as e:
                self._send_json(400, {"ok": False, "error": f"Invalid JSON: {e}"})
                return
            result = dispatch(payload)
            code = 200 if result.get("ok") else 400
            self._send_json(code, result)

    server = HTTPServer(("0.0.0.0", port), Handler)
    print(f"[financial-engine] Listening on :{port}")
    print(f"[financial-engine] Models: {', '.join(MODELS.keys())}")
    print(f"[financial-engine] Endpoints: GET /health, POST /calculate")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[financial-engine] Shutting down")
        server.server_close()


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if "--server" in sys.argv:
        port = 3102
        for i, arg in enumerate(sys.argv):
            if arg == "--port" and i + 1 < len(sys.argv):
                port = int(sys.argv[i + 1])
        run_server(port)
    else:
        run_stdio()
