#!/usr/bin/env python3
import json
import os
import re
import sys
import tempfile
from typing import Any, Dict, List, Optional, Tuple

# ── Optional: docling for structured PDF table extraction ──
try:
    from docling.document_converter import DocumentConverter as _DoclingConverter
    _DOCLING_AVAILABLE = True
except ImportError:
    _DoclingConverter = None
    _DOCLING_AVAILABLE = False


def _load_payload() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _to_float(token: str) -> Optional[float]:
    if token is None:
        return None
    s = str(token).strip().replace(",", "").replace("，", "")
    if not s:
        return None
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    try:
        return float(s)
    except Exception:
        return None


def _find_number(text: str, patterns: List[str]) -> Optional[float]:
    for p in patterns:
        m = re.search(p, text, flags=re.IGNORECASE | re.MULTILINE)
        if not m:
            continue
        for g in m.groups()[::-1]:
            v = _to_float(g)
            if v is not None:
                return v
    return None


# ── 2A: Docling PDF → structured table extraction ──

def extract_with_docling(pdf_path: str) -> Dict[str, Optional[float]]:
    """Use docling's DocumentConverter to parse a PDF and extract financial fields
    from structured tables. Returns a dict of field_name → float | None."""
    if not _DOCLING_AVAILABLE or not pdf_path or not os.path.isfile(pdf_path):
        return {}
    try:
        converter = _DoclingConverter()
        result = converter.convert(pdf_path)
        doc = result.document

        # Collect all table text into a single blob for regex extraction
        table_texts: List[str] = []
        for table in doc.tables:
            # Each table has a grid of cells; flatten to lines
            for row in table.data:
                cells = [str(cell.text).strip() for cell in row if cell and hasattr(cell, "text")]
                table_texts.append(" | ".join(cells))

        # Also include the full markdown export (covers non-table data)
        try:
            md_text = doc.export_to_markdown()
            table_texts.append(md_text)
        except Exception:
            pass

        merged = "\n".join(table_texts)
        if not merged.strip():
            return {}
        return _extract_fields(merged)
    except Exception:
        return {}


# ── 2B: Enhanced multi-language regex field extraction ──

def _extract_fields(text: str) -> Dict[str, Optional[float]]:
    num = r"([\-]?\(?\d[\d,]*(?:\.\d+)?\)?)"
    # Separator pattern for table formats (pipe, tab, multiple spaces)
    sep = r"[\s|,\t]+"

    # Helper: build pattern that matches label then number, including on the next line
    def lbl(alts: str) -> List[str]:
        """Given a pipe-separated string of label alternatives, return patterns that
        match the label followed by a number (same line or next line)."""
        return [
            rf"(?:{alts}){sep}{num}",
            rf"(?:{alts})\s*\n\s*{num}",
        ]

    fields: Dict[str, List[str]] = {
        # ── Inventory ──
        "inventory_bs": [
            rf"balance\s*sheet[^.\n]*inventory[^0-9\-()]*{num}",
            rf"inventory[^.\n]*(?:balance\s*sheet|statement\s*of\s*financial\s*position)[^0-9\-()]*{num}",
            *lbl(r"inventories|inventory|存货|存貨|库存|庫存"),
        ],
        "inventory_raw": [
            *lbl(r"raw\s*materials|原材料|原材料"),
        ],
        "inventory_finished": [
            *lbl(r"finished\s*goods|产成品|產成品|成品|库存商品|庫存商品"),
        ],

        # ── Accounts Receivable ──
        "ar_bs": [
            *lbl(
                r"trade\s*(?:and\s*other\s*)?receivables|accounts?\s*receivable"
                r"|应收账款|應收賬款|应收帐款|應收帳款"
                r"|trade\s*receivables|贸易应收款|貿易應收款"
                r"|应收款项|應收款項"
            ),
        ],
        "ar_0_30": [
            rf"(?:0[\-–]30|0\s*to\s*30)\s*days?{sep}{num}",
            rf"(?:0[\-–]30|0\s*to\s*30)\s*days?\s*\n\s*{num}",
        ],
        "ar_31_60": [
            rf"(?:31[\-–]60|31\s*to\s*60)\s*days?{sep}{num}",
            rf"(?:31[\-–]60|31\s*to\s*60)\s*days?\s*\n\s*{num}",
        ],
        "ar_60_plus": [
            rf"(?:over\s*60|60\+|61[\-–]90|>60)\s*days?{sep}{num}",
            rf"(?:over\s*60|60\+|61[\-–]90|>60)\s*days?\s*\n\s*{num}",
        ],

        # ── Loans / Borrowings ──
        "loan_current": [
            *lbl(
                r"current\s*(?:portion\s*of\s*)?(?:bank\s*)?(?:loans?|borrowings?)"
                r"|短期借款|短期貸款|流动负债.*借款|流動負債.*借款"
            ),
        ],
        "loan_non_current": [
            *lbl(
                r"non[\-\s]*current\s*(?:bank\s*)?(?:loans?|borrowings?)"
                r"|长期借款|長期借款|非流动.*借款|非流動.*借款"
            ),
        ],
        "loan_lt_1y": [
            *lbl(r"within\s*(?:one|1)\s*year|<\s*1y|less\s*than\s*(?:one|1)\s*year|一年以内|一年以內"),
        ],
        "loan_1_2y": [
            *lbl(r"(?:1[\-–]2|one\s*to\s*two)\s*years?|一至二年|1至2年"),
        ],
        "loan_gt_2y": [
            *lbl(r"(?:over\s*(?:two|2)|>\s*2y|more\s*than\s*(?:two|2))\s*years?|二年以上|两年以上|兩年以上"),
        ],

        # ── Property, Plant and Equipment ──
        "ppe_open": [
            rf"(?:ppe|property,?\s*plant\s*(?:and|&)\s*equipment|固定资产|固定資產|物業、?廠房及設備|物业、?厂房及设备)[^.\n]*(?:opening|期初|年初)[^0-9\-()]*{num}",
            rf"(?:opening|期初|年初)[^.\n]*(?:ppe|property,?\s*plant|固定资产|固定資產)[^0-9\-()]*{num}",
        ],
        "ppe_add": [
            *lbl(r"additions?|增加|本期增加|添置"),
        ],
        "ppe_disp": [
            *lbl(r"disposals?|处置|處置|报废|報廢|减少|減少"),
        ],
        "ppe_dep": [
            *lbl(r"depreciation|折旧|折舊|累计折旧|累計折舊"),
        ],
        "ppe_close": [
            rf"(?:closing|期末|年末)[^.\n]*(?:ppe|property,?\s*plant|固定资产|固定資產)[^0-9\-()]*{num}",
            rf"(?:ppe|property,?\s*plant\s*(?:and|&)\s*equipment|固定资产|固定資產|物業、?廠房及設備|物业、?厂房及设备)[^.\n]*(?:closing|期末|年末)[^0-9\-()]*{num}",
        ],

        # ── Income Statement ──
        "revenue": [
            *lbl(r"(?:total\s*)?revenue|turnover|营业收入|營業收入|收入|营业额|營業額|销售收入|銷售收入"),
        ],
        "cogs": [
            *lbl(
                r"(?:cogs|cost\s*of\s*(?:goods\s*)?(?:sold|sales)|cost\s*of\s*revenue)"
                r"|营业成本|營業成本|销售成本|銷售成本|主营业务成本|主營業務成本"
            ),
        ],
        "gross_profit": [
            *lbl(r"gross\s*profit|毛利|毛利润|毛利潤"),
        ],

        # ── Cash Flow Statement ──
        "cfo": [
            *lbl(
                r"\bcfo\b|cash\s*(?:flows?\s*)?(?:from|used\s*in)\s*operat(?:ing|ions)"
                r"|经营活动现金流|經營活動現金流|经营活动产生的现金|經營活動產生的現金"
            ),
        ],
        "cfi": [
            *lbl(
                r"\bcfi\b|cash\s*(?:flows?\s*)?(?:from|used\s*in)\s*invest(?:ing|ment)"
                r"|投资活动现金流|投資活動現金流|投资活动产生的现金|投資活動產生的現金"
            ),
        ],
        "cff": [
            *lbl(
                r"\bcff\b|cash\s*(?:flows?\s*)?(?:from|used\s*in)\s*financ(?:ing|e)"
                r"|筹资活动现金流|籌資活動現金流|融资活动|融資活動"
            ),
        ],
        "cash_open": [
            *lbl(
                r"(?:opening|beginning)\s*(?:balance\s*of\s*)?cash"
                r"|cash[^.\n]*(?:at\s*)?(?:beginning|opening)"
                r"|期初现金|期初現金|年初现金|年初現金"
            ),
        ],
        "cash_close": [
            *lbl(
                r"(?:closing|ending)\s*(?:balance\s*of\s*)?cash"
                r"|cash[^.\n]*(?:at\s*)?(?:end|closing)"
                r"|期末现金|期末現金|年末现金|年末現金"
            ),
        ],

        # ── Retained Earnings ──
        "re_open": [
            rf"(?:retained\s*earnings?|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^.\n]*(?:opening|期初|年初)[^0-9\-()]*{num}",
        ],
        "re_profit": [
            rf"(?:retained\s*earnings?|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^.\n]*(?:profit|net\s*income|净利润|淨利潤|溢利)[^0-9\-()]*{num}",
        ],
        "re_div": [
            rf"(?:retained\s*earnings?|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^.\n]*(?:dividends?|股息|股利|分红|分紅)[^0-9\-()]*{num}",
        ],
        "re_close": [
            rf"(?:retained\s*earnings?|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^.\n]*(?:closing|期末|年末)[^0-9\-()]*{num}",
        ],

        # ── Balance Sheet Totals ──
        "total_assets": [
            *lbl(
                r"total\s*assets|资产总计|資產總計|资产总额|資產總額|总资产|總資產"
                r"|total\s*assets\s*and\s*liabilities"
            ),
        ],
        "total_liabilities": [
            *lbl(
                r"total\s*liabilities|负债总计|負債總計|负债合计|負債合計|总负债|總負債"
                r"|负债总额|負債總額"
            ),
        ],
        "total_equity": [
            *lbl(
                r"total\s*(?:shareholders?[''']?\s*)?equity|equity\s*attributable"
                r"|权益总额|權益總額|权益合计|權益合計|股东权益合计|股東權益合計"
                r"|所有者权益|所有者權益"
            ),
        ],
    }
    out: Dict[str, Optional[float]] = {}
    for key, patterns in fields.items():
        out[key] = _find_number(text, patterns)
    return out


def _check(
    check_id: str,
    formula: str,
    inputs: Dict[str, Optional[float]],
    expected: Optional[float],
    computed: Optional[float],
    tol: float = 1e-6,
) -> Dict[str, Any]:
    missing = [k for k, v in inputs.items() if v is None]
    if expected is None or computed is None or missing:
        return {
            "check": check_id,
            "formula": formula,
            "reported": expected,
            "computed": computed,
            "difference": None,
            "status": "insufficient",
            "missing_fields": missing,
        }
    diff = expected - computed
    status = "tie" if abs(diff) <= tol else "not_tie"
    return {
        "check": check_id,
        "formula": formula,
        "reported": expected,
        "computed": computed,
        "difference": diff,
        "status": status,
        "missing_fields": [],
    }


def _validate_with_pandera(checks: List[Dict[str, Any]]) -> Dict[str, Any]:
    try:
        import pandas as pd  # type: ignore
        import pandera as pa  # type: ignore
        from pandera.typing import Series  # type: ignore

        class CheckSchema(pa.DataFrameModel):
            check: Series[str]
            formula: Series[str]
            status: Series[str] = pa.Field(isin=["tie", "not_tie", "insufficient"])

        df = pd.DataFrame(checks)
        CheckSchema.validate(df)
        return {"pandera_enabled": True, "pandera_valid": True}
    except Exception as e:
        return {"pandera_enabled": False, "pandera_valid": False, "pandera_error": str(e)}


def main() -> None:
    payload = _load_payload()
    query = str(payload.get("query", "")).strip()
    docs = payload.get("documents") or []
    docs = docs if isinstance(docs, list) else []

    text_chunks: List[str] = []
    evidence: List[Dict[str, Any]] = []
    pdf_paths: List[str] = []
    for d in docs:
        if not isinstance(d, dict):
            continue
        txt = str(d.get("text", "") or "")
        name = str(d.get("name", "") or "")
        source = str(d.get("source", "") or "")
        pdf_path = str(d.get("pdf_path", "") or "")
        if not txt.strip() and not pdf_path:
            continue
        if txt.strip():
            text_chunks.append(txt)
        if pdf_path:
            pdf_paths.append(pdf_path)
        evidence.append({
            "name": name,
            "source": source,
            "excerpt": txt[:300],
        })

    merged = "\n\n".join(text_chunks)

    # ── Docling extraction: try structured table parsing first ──
    docling_fields: Dict[str, Optional[float]] = {}
    docling_used = False
    if _DOCLING_AVAILABLE and pdf_paths:
        for pp in pdf_paths:
            df = extract_with_docling(pp)
            if df:
                # Merge: docling fields take priority (structured > regex)
                for k, v in df.items():
                    if v is not None and docling_fields.get(k) is None:
                        docling_fields[k] = v
                docling_used = True

    # ── Regex extraction from merged text ──
    regex_fields = _extract_fields(merged)

    # ── Merge: docling results override regex where available ──
    fields: Dict[str, Optional[float]] = {}
    for key in regex_fields:
        fields[key] = docling_fields.get(key) if docling_fields.get(key) is not None else regex_fields[key]
    # Include any docling-only keys
    for key in docling_fields:
        if key not in fields:
            fields[key] = docling_fields[key]

    checks = [
        _check(
            "inventory_tie",
            "inventory_bs = inventory_raw + inventory_finished",
            {"inventory_bs": fields["inventory_bs"], "inventory_raw": fields["inventory_raw"], "inventory_finished": fields["inventory_finished"]},
            fields["inventory_bs"],
            (fields["inventory_raw"] or 0) + (fields["inventory_finished"] or 0) if fields["inventory_raw"] is not None and fields["inventory_finished"] is not None else None,
        ),
        _check(
            "ar_tie",
            "ar_bs = ar_0_30 + ar_31_60 + ar_60_plus",
            {"ar_bs": fields["ar_bs"], "ar_0_30": fields["ar_0_30"], "ar_31_60": fields["ar_31_60"], "ar_60_plus": fields["ar_60_plus"]},
            fields["ar_bs"],
            (fields["ar_0_30"] or 0) + (fields["ar_31_60"] or 0) + (fields["ar_60_plus"] or 0) if None not in (fields["ar_0_30"], fields["ar_31_60"], fields["ar_60_plus"]) else None,
        ),
        _check(
            "loan_tie",
            "loan_current + loan_non_current = loan_lt_1y + loan_1_2y + loan_gt_2y",
            {
                "loan_current": fields["loan_current"],
                "loan_non_current": fields["loan_non_current"],
                "loan_lt_1y": fields["loan_lt_1y"],
                "loan_1_2y": fields["loan_1_2y"],
                "loan_gt_2y": fields["loan_gt_2y"],
            },
            (fields["loan_current"] or 0) + (fields["loan_non_current"] or 0) if None not in (fields["loan_current"], fields["loan_non_current"]) else None,
            (fields["loan_lt_1y"] or 0) + (fields["loan_1_2y"] or 0) + (fields["loan_gt_2y"] or 0) if None not in (fields["loan_lt_1y"], fields["loan_1_2y"], fields["loan_gt_2y"]) else None,
        ),
        _check(
            "ppe_rollforward",
            "ppe_close = ppe_open + ppe_add - ppe_disp - ppe_dep",
            {"ppe_open": fields["ppe_open"], "ppe_add": fields["ppe_add"], "ppe_disp": fields["ppe_disp"], "ppe_dep": fields["ppe_dep"], "ppe_close": fields["ppe_close"]},
            fields["ppe_close"],
            (fields["ppe_open"] or 0) + (fields["ppe_add"] or 0) - (fields["ppe_disp"] or 0) - (fields["ppe_dep"] or 0) if None not in (fields["ppe_open"], fields["ppe_add"], fields["ppe_disp"], fields["ppe_dep"]) else None,
        ),
        _check(
            "gross_profit_bridge",
            "gross_profit = revenue - cogs",
            {"revenue": fields["revenue"], "cogs": fields["cogs"], "gross_profit": fields["gross_profit"]},
            fields["gross_profit"],
            (fields["revenue"] or 0) - (fields["cogs"] or 0) if None not in (fields["revenue"], fields["cogs"]) else None,
        ),
        _check(
            "cash_bridge",
            "cash_close = cash_open + cfo + cfi + cff",
            {"cash_open": fields["cash_open"], "cfo": fields["cfo"], "cfi": fields["cfi"], "cff": fields["cff"], "cash_close": fields["cash_close"]},
            fields["cash_close"],
            (fields["cash_open"] or 0) + (fields["cfo"] or 0) + (fields["cfi"] or 0) + (fields["cff"] or 0) if None not in (fields["cash_open"], fields["cfo"], fields["cfi"], fields["cff"]) else None,
        ),
        _check(
            "retained_earnings_bridge",
            "re_close = re_open + re_profit - re_div",
            {"re_open": fields["re_open"], "re_profit": fields["re_profit"], "re_div": fields["re_div"], "re_close": fields["re_close"]},
            fields["re_close"],
            (fields["re_open"] or 0) + (fields["re_profit"] or 0) - (fields["re_div"] or 0) if None not in (fields["re_open"], fields["re_profit"], fields["re_div"]) else None,
        ),
        _check(
            "balance_sheet_equation",
            "total_assets = total_liabilities + total_equity",
            {
                "total_assets": fields["total_assets"],
                "total_liabilities": fields["total_liabilities"],
                "total_equity": fields["total_equity"],
            },
            fields["total_assets"],
            (fields["total_liabilities"] or 0) + (fields["total_equity"] or 0) if None not in (fields["total_liabilities"], fields["total_equity"]) else None,
        ),
    ]

    missing_fields = sorted({m for c in checks for m in c.get("missing_fields", [])})
    pass_count = len([c for c in checks if c.get("status") == "tie"])
    fail_count = len([c for c in checks if c.get("status") == "not_tie"])
    insufficient_count = len([c for c in checks if c.get("status") == "insufficient"])

    meta = {
        "query": query,
        "documents_count": len(text_chunks),
        "pass_count": pass_count,
        "fail_count": fail_count,
        "insufficient_count": insufficient_count,
        "docling_available": _DOCLING_AVAILABLE,
        "docling_used": docling_used,
    }
    meta.update(_validate_with_pandera(checks))

    if not text_chunks and not pdf_paths:
        summary = "No attachment text available for financial checks."
    else:
        summary = f"Financial checks completed: tie={pass_count}, not_tie={fail_count}, insufficient={insufficient_count}."
        if docling_used:
            summary += " (docling structured extraction used)"

    out = {
        "ok": True,
        "summary": summary,
        "checks": checks,
        "missing_fields": missing_fields,
        "evidence": evidence[:20],
        "meta": meta,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
