#!/usr/bin/env python3
import json
import os
import re
import sys
import tempfile
from difflib import SequenceMatcher
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
    s = str(token).strip().replace(",", "").replace("\uff0c", "")
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


def _find_all_numbers(text: str, patterns: List[str]) -> List[Tuple[str, float]]:
    """Find ALL matches for patterns, returning (matched_text, value) pairs."""
    results: List[Tuple[str, float]] = []
    for p in patterns:
        for m in re.finditer(p, text, flags=re.IGNORECASE | re.MULTILINE):
            matched_text = m.group(0).strip()
            for g in m.groups()[::-1]:
                v = _to_float(g)
                if v is not None:
                    results.append((matched_text, v))
                    break
    return results


# ── 2A: Docling PDF -> structured table extraction ──

def extract_with_docling(pdf_path: str) -> Dict[str, Optional[float]]:
    """Use docling's DocumentConverter to parse a PDF and extract financial fields
    from structured tables. Returns a dict of field_name -> float | None."""
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
    # ── Number patterns for pdftotext -layout output ──
    #
    # pdftotext -layout produces lines like:
    #   營業額                 Turnover                               6           37,985
    #   銷售成本                Cost of sales                                    (21,625)
    #   存貨                           Stocks                                   23            9,240
    #
    # Key challenges:
    #   1. 20-50+ spaces between label and number
    #   2. English translations mixed with Chinese labels
    #   3. Note reference numbers (small integers like 6, 16, 23) before the real value
    #   4. Parenthesized negatives: (21,625) = -21,625
    #   5. Multiple numbers on same line (current year, prior year)
    #
    # Strategy: match "financial numbers" = numbers with commas, or parenthesized,
    # or with decimal points. This skips bare small integers (note refs like 6, 16, 23).
    # For amounts < 1000 without commas, we use a fallback pattern.

    # ── Financial number patterns for pdftotext -layout ──
    #
    # In pdftotext -layout, column values are separated by 2+ spaces.
    # Note refs (6, 16, 23) appear in the "Notes" column, also space-separated.
    # We use two tiers of number patterns:
    #
    # fnum: "obviously financial" — has comma separators, parentheses, or decimals.
    #   These reliably skip over note refs since note refs are plain integers.
    #
    # fnum_col: "column-aligned number" — any number preceded by 2+ spaces.
    #   This handles small amounts (90, 55) that appear in value columns.
    #   The 2+ space prefix + non-greedy gap means we still get the first
    #   column value, not random inline numbers.

    # Tier 1: obviously financial (comma-formatted, parenthesized, or decimal)
    fnum = (
        r"("
        r"\(?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?"    # comma-formatted: 1,234 or (1,234)
        r"|\(\d+(?:\.\d+)?\)"                       # parenthesized negative: (123)
        r"|\d+\.\d+"                                 # decimal: 1.04
        r"|(?<!\d)(?!(?:19|20)\d{2}(?:\D|$))\d{3,}" # 3+ digits, not year-like, not partial
        r")"
    )
    # Tier 2: column-aligned number (preceded by 2+ spaces, any digit count)
    # The (?<=\s{2}) lookbehind ensures we're in a column gap, not inline text.
    # Note: variable-length lookbehinds not supported in re, use \s\s instead.
    fnum_col = r"\s\s+" + r"(\(?\d[\d,]*(?:\.\d+)?\)?)"
    # Fallback: any number (for small amounts or ratios), at least 1 digit
    snum = r"([\-]?\(?\d[\d,]*(?:\.\d+)?\)?)"

    # Helper: build patterns that match label then first financial number on same/next line
    def lbl(alts: str) -> List[str]:
        """Given a pipe-separated string of label alternatives, return patterns that
        match the label followed by a number (same line or next line).
        Uses generous gap to handle pdftotext -layout format with wide spacing,
        English translations, and note reference numbers between label and value.

        Priority order:
        1. Same line, obviously-financial number (comma/paren/decimal/3+digits)
        2. Same line, column-aligned number (2+ spaces then any number) - catches small amounts
        3. Next line, obviously-financial number
        4. Next line, column-aligned number
        5/6. Fallback: any number after substantial gap"""
        return [
            # Priority 1: same line, obviously financial number (comma/paren/decimal/3+digits)
            rf"(?:{alts})[^\n]*?" + fnum,
            # Priority 2: same line, column-aligned number (2+ spaces then any number)
            # Catches small amounts like 90 that don't have commas or 3+ digits
            rf"(?:{alts})[^\n]*?" + fnum_col,
            # Priority 3: next line, obviously financial number
            rf"(?:{alts})[^\n]*\n[^\n]*?" + fnum,
            # Priority 4: next line, column-aligned number
            rf"(?:{alts})[^\n]*\n[^\n]*?" + fnum_col,
            # Priority 5: same line, any number after substantial gap (>=3 spaces)
            rf"(?:{alts})\s{{3,}}" + snum,
            # Priority 6: next line, any number
            rf"(?:{alts})\s*\n\s+" + snum,
        ]

    fields: Dict[str, List[str]] = {
        # ── Inventory ──
        "inventory_bs": [
            rf"balance\s*sheet[^\n]*inventory[^\n]*?" + fnum,
            rf"inventory[^\n]*(?:balance\s*sheet|statement\s*of\s*financial\s*position)[^\n]*?" + fnum,
            *lbl(r"inventories|inventory|存货|存貨|库存|庫存|stocks"),
        ],
        "inventory_raw": [
            *lbl(r"raw\s*materials?|原材料"),
        ],
        "inventory_wip": [
            *lbl(r"work[\s\-]*in[\s\-]*progress|work[\s\-]*in[\s\-]*process|在产品|在產品|在制品|在製品"),
        ],
        "inventory_finished": [
            *lbl(r"finished\s*goods|产成品|產成品|成品|库存商品|庫存商品"),
        ],
        "inventory_consumables": [
            *lbl(r"consumables?\s*(?:and\s*)?(?:packing\s*)?(?:materials?)?|supplies|low[\s\-]*value\s*consumables?|周转材料|週轉材料|低值易耗品|消耗品|易耗品及包裝材料"),
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
            rf"(?:0[\-\u2013]30|0\s*to\s*30)\s*days?[^\n]*?" + fnum,
            rf"(?:0[\-\u2013]30|0\s*to\s*30)\s*days?\s*\n[^\n]*?" + fnum,
        ],
        "ar_31_60": [
            rf"(?:31[\-\u2013]60|31\s*to\s*60)\s*days?[^\n]*?" + fnum,
            rf"(?:31[\-\u2013]60|31\s*to\s*60)\s*days?\s*\n[^\n]*?" + fnum,
        ],
        "ar_61_90": [
            rf"(?:61[\-\u2013]90|61\s*to\s*90)\s*days?[^\n]*?" + fnum,
            rf"(?:61[\-\u2013]90|61\s*to\s*90)\s*days?\s*\n[^\n]*?" + fnum,
        ],
        "ar_91_180": [
            rf"(?:91[\-\u2013]180|91\s*to\s*180)\s*days?[^\n]*?" + fnum,
            rf"(?:91[\-\u2013]180|91\s*to\s*180)\s*days?\s*\n[^\n]*?" + fnum,
        ],
        "ar_over_180": [
            rf"(?:over\s*180|180\+|>180|181[\-\u2013]365)\s*days?[^\n]*?" + fnum,
            rf"(?:over\s*180|180\+|>180|181[\-\u2013]365)\s*days?\s*\n[^\n]*?" + fnum,
        ],
        "ar_60_plus": [
            rf"(?:over\s*60|60\+|61[\-\u2013]90|>60)\s*days?[^\n]*?" + fnum,
            rf"(?:over\s*60|60\+|61[\-\u2013]90|>60)\s*days?\s*\n[^\n]*?" + fnum,
        ],

        # ── Loans / Borrowings ──
        "loan_current": [
            *lbl(
                r"current\s*(?:portion\s*of\s*)?(?:bank\s*)?(?:loans?|borrowings?)"
                r"|short[\-\s]*term\s*(?:bank\s*)?loans?"
                r"|短期借款|短期貸款|短期銀行貸款|流动负债.*借款|流動負債.*借款"
            ),
        ],
        "loan_non_current": [
            *lbl(
                r"non[\-\s]*current\s*(?:bank\s*)?(?:loans?|borrowings?)"
                r"|long[\-\s]*term\s*(?:bank\s*)?loans?"
                r"|长期借款|長期借款|長期銀行貸款|非流动.*借款|非流動.*借款"
            ),
        ],
        "loan_lt_1y": [
            *lbl(r"within\s*(?:one|1)\s*year|<\s*1y|less\s*than\s*(?:one|1)\s*year|一年以内|一年以內"),
        ],
        "loan_1_2y": [
            *lbl(r"(?:1[\-\u2013]2|one\s*to\s*two)\s*years?|一至二年|1至2年"
                 r"|after\s*1\s*years?,?\s*(?:but\s*)?within\s*2\s*years?"
                 r"|一年以上至兩年內|一年以上至两年内"),
        ],
        "loan_2_3y": [
            *lbl(r"(?:2[\-\u2013]3|two\s*to\s*three)\s*years?|二至三年|2至3年"),
        ],
        "loan_gt_3y": [
            *lbl(r"(?:over\s*(?:three|3)|>\s*3y|more\s*than\s*(?:three|3))\s*years?|三年以上"),
        ],
        "loan_gt_2y": [
            *lbl(r"(?:over\s*(?:two|2)|>\s*2y|more\s*than\s*(?:two|2))\s*years?|二年以上|两年以上|兩年以上"
                 r"|after\s*2\s*years?,?\s*(?:but\s*)?within\s*5\s*years?"
                 r"|兩年以上至五年內|两年以上至五年内"),
        ],

        # ── Property, Plant and Equipment ──
        "ppe_bs": [
            *lbl(
                r"(?:ppe|property,?\s*plant\s*(?:and|&)\s*equipment|固定资产|固定資產"
                r"|物業、?廠房及設備|物业、?厂房及设备|fixed\s*assets)"
            ),
        ],
        "ppe_open": [
            rf"(?:ppe|property,?\s*plant\s*(?:and|&)\s*equipment|固定资产|固定資產|物業、?廠房及設備|物业、?厂房及设备|fixed\s*assets)[^\n]*(?:opening|期初|年初)[^\n]*?" + fnum,
            rf"(?:opening|期初|年初)[^\n]*(?:ppe|property,?\s*plant|固定资产|固定資產|fixed\s*assets)[^\n]*?" + fnum,
        ],
        "ppe_add": [
            *lbl(r"additions?|增加|本期增加|添置"),
        ],
        "ppe_disp": [
            *lbl(r"disposals?|处置|處置|报废|報廢|出售撥回|出售拨回"),
        ],
        "ppe_dep": [
            *lbl(r"depreciation|折旧|折舊|累计折旧|累計折舊"),
        ],
        "ppe_close": [
            rf"(?:closing|期末|年末)[^\n]*(?:ppe|property,?\s*plant|固定资产|固定資產|fixed\s*assets)[^\n]*?" + fnum,
            rf"(?:ppe|property,?\s*plant\s*(?:and|&)\s*equipment|固定资产|固定資產|物業、?廠房及設備|物业、?厂房及设备|fixed\s*assets)[^\n]*(?:closing|期末|年末)[^\n]*?" + fnum,
        ],
        "ppe_transfer": [
            *lbl(r"transfers?|reclassifications?|转入转出|轉入轉出|重新分类|重新分類|调拨|調撥"),
        ],
        "ppe_impairment": [
            *lbl(r"impairment|减值|減值|资产减值|資產減值"),
        ],

        # ── PPE by Category (cost / gross carrying amount) ──
        "ppe_buildings_cost": [
            *lbl(r"buildings?|房屋|房屋建筑物|房屋建築物|楼宇|樓宇|房屋及建筑物|房屋及建築物"),
        ],
        "ppe_buildings_open": [
            rf"(?:buildings?|房屋|楼宇|樓宇|房屋建筑物|房屋建築物)[^\n]*(?:opening|期初|年初|at\s*1\s*January)[^\n]*?" + fnum,
            rf"(?:opening|期初|年初|at\s*1\s*January)[^\n]*(?:buildings?|房屋|楼宇|樓宇)[^\n]*?" + fnum,
        ],
        "ppe_buildings_add": [
            rf"(?:buildings?|房屋|楼宇|樓宇)[^\n]*(?:additions?|增加|添置)[^\n]*?" + fnum,
        ],
        "ppe_buildings_disp": [
            rf"(?:buildings?|房屋|楼宇|樓宇)[^\n]*(?:disposals?|处置|處置|减少|減少)[^\n]*?" + fnum,
        ],
        "ppe_buildings_dep": [
            rf"(?:buildings?|房屋|楼宇|樓宇)[^\n]*(?:depreciation|折旧|折舊|charge)[^\n]*?" + fnum,
        ],
        "ppe_buildings_close": [
            rf"(?:buildings?|房屋|楼宇|樓宇)[^\n]*(?:closing|期末|年末|at\s*31\s*December)[^\n]*?" + fnum,
        ],

        "ppe_plant_cost": [
            *lbl(r"plant\s*(?:and|&)\s*machinery|机器设备|機器設備|机械设备|機械設備|厂房及机器|廠房及機器"),
        ],
        "ppe_plant_open": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^\n]*(?:opening|期初|年初|at\s*1\s*January)[^\n]*?" + fnum,
        ],
        "ppe_plant_add": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^\n]*(?:additions?|增加|添置)[^\n]*?" + fnum,
        ],
        "ppe_plant_disp": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^\n]*(?:disposals?|处置|處置|减少|減少)[^\n]*?" + fnum,
        ],
        "ppe_plant_dep": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^\n]*(?:depreciation|折旧|折舊|charge)[^\n]*?" + fnum,
        ],
        "ppe_plant_close": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^\n]*(?:closing|期末|年末|at\s*31\s*December)[^\n]*?" + fnum,
        ],

        "ppe_vehicles_cost": [
            *lbl(r"(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車|运输设备|運輸設備"),
        ],
        "ppe_vehicles_open": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^\n]*(?:opening|期初|年初|at\s*1\s*January)[^\n]*?" + fnum,
        ],
        "ppe_vehicles_add": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^\n]*(?:additions?|增加|添置)[^\n]*?" + fnum,
        ],
        "ppe_vehicles_disp": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^\n]*(?:disposals?|处置|處置|减少|減少)[^\n]*?" + fnum,
        ],
        "ppe_vehicles_dep": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^\n]*(?:depreciation|折旧|折舊|charge)[^\n]*?" + fnum,
        ],
        "ppe_vehicles_close": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^\n]*(?:closing|期末|年末|at\s*31\s*December)[^\n]*?" + fnum,
        ],

        "ppe_office_cost": [
            *lbl(r"(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|办公家具|辦公家具|电子设备|電子設備|家具及装置|傢具及裝置"),
        ],
        "ppe_office_open": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^\n]*(?:opening|期初|年初|at\s*1\s*January)[^\n]*?" + fnum,
        ],
        "ppe_office_add": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^\n]*(?:additions?|增加|添置)[^\n]*?" + fnum,
        ],
        "ppe_office_disp": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^\n]*(?:disposals?|处置|處置|减少|減少)[^\n]*?" + fnum,
        ],
        "ppe_office_dep": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^\n]*(?:depreciation|折旧|折舊|charge)[^\n]*?" + fnum,
        ],
        "ppe_office_close": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^\n]*(?:closing|期末|年末|at\s*31\s*December)[^\n]*?" + fnum,
        ],

        "ppe_land_cost": [
            *lbl(r"land|土地|土地使用权|土地使用權"),
        ],
        "ppe_land_open": [
            rf"(?:land|土地|土地使用权|土地使用權)[^\n]*(?:opening|期初|年初|at\s*1\s*January)[^\n]*?" + fnum,
        ],
        "ppe_land_close": [
            rf"(?:land|土地|土地使用权|土地使用權)[^\n]*(?:closing|期末|年末|at\s*31\s*December)[^\n]*?" + fnum,
        ],

        "ppe_leasehold_cost": [
            *lbl(r"leasehold\s*improvements?|租赁改良|租賃改良|装修|裝修|leasehold"),
        ],
        "ppe_leasehold_dep": [
            rf"(?:leasehold\s*improvements?|租赁改良|租賃改良|装修|裝修)[^\n]*(?:depreciation|折旧|折舊|charge)[^\n]*?" + fnum,
        ],

        # ── PPE Disposal Gain/Loss ──
        "ppe_disposal_proceeds": [
            *lbl(r"(?:disposal|sale)\s*proceeds|处置收入|處置收入|出售所得|出售收益"),
        ],
        "ppe_disposal_nbv": [
            *lbl(r"(?:net\s*book\s*value|nbv|carrying\s*(?:amount|value))\s*(?:of\s*)?(?:disposed|disposals?)|处置资产账面|處置資產賬面"),
        ],
        "ppe_disposal_gain_loss": [
            *lbl(r"(?:gain|loss)\s*on\s*disposal|处置(?:收益|损失)|處置(?:收益|損失)|出售固定资产(?:收益|损失)|出售固定資產(?:收益|損失)"),
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
        "net_income": [
            # Priority: profit attributable to shareholders first (for RE reconciliation)
            # In pdftotext layout, the line may have Chinese + English + wide spaces + number
            rf"(?:profit\s*attributable\s*to\s*(?:shareholders|owners|equity\s*holders)|本公司股東應佔溢利|本公司股东应占溢利)[^\n]*?" + fnum,
            rf"(?:profit\s*attributable\s*to\s*(?:shareholders|owners|equity\s*holders)|本公司股東應佔溢利|本公司股东应占溢利)\s*\n[^\n]*?" + fnum,
            *lbl(
                r"net\s*(?:income|profit|loss)\s*(?:for\s*the\s*(?:year|period))?"
                r"|(?:total\s*)?profit\s*for\s*the\s*(?:year|period)"
                r"|净利润|淨利潤|纯利|純利|本年度溢利|(?:税后|稅後)(?:净|淨)?(?:利润|利潤)"
                r"|shareholders\s*of\s*the\s*company"
            ),
        ],
        "depreciation_is": [
            *lbl(
                r"depreciation\s*(?:and\s*amortisation|&\s*amort)"
                r"|折旧及摊销|折舊及攤銷|折旧摊销|折舊攤銷"
                r"|depreciation\s*(?:expense|charge)"
            ),
        ],

        # ── Revenue Segments (by business line) ──
        "rev_seg_1": [
            *lbl(
                r"segment\s*(?:1|[Aa]|one)[^0-9\-()]*revenue"
                r"|分部(?:一|1)[^0-9\-()]*收入"
                r"|(?:主营业务|主營業務)[^0-9\-()]*收入"
            ),
        ],
        "rev_seg_2": [
            *lbl(
                r"segment\s*(?:2|[Bb]|two)[^0-9\-()]*revenue"
                r"|分部(?:二|2)[^0-9\-()]*收入"
            ),
        ],
        "rev_seg_3": [
            *lbl(
                r"segment\s*(?:3|[Cc]|three)[^0-9\-()]*revenue"
                r"|分部(?:三|3)[^0-9\-()]*收入"
            ),
        ],

        # ── COGS Components ──
        "cogs_materials": [
            *lbl(
                r"(?:raw\s*)?materials?\s*(?:consumed|used|cost)"
                r"|原材料消耗|原材料成本|直接材料"
            ),
        ],
        "cogs_labor": [
            *lbl(
                r"(?:direct\s*)?labo[u]?r\s*cost"
                r"|直接人工|人工成本"
            ),
        ],
        "cogs_depreciation": [
            *lbl(
                r"depreciation\s*(?:included\s*in\s*(?:cost|cogs))"
                r"|(?:cost|cogs)[^.\n]*depreciation"
                r"|制造费用.*折旧|製造費用.*折舊"
            ),
        ],
        "cogs_overhead": [
            *lbl(
                r"(?:manufacturing|production)\s*overhead"
                r"|制造费用|製造費用"
            ),
        ],

        # ── Cash Flow Statement ──
        "cfo": [
            *lbl(
                r"\bcfo\b|(?:net\s*)?cash\s*(?:flows?\s*)?(?:from|used\s*in)\s*operat(?:ing|ions)\s*(?:activities)?"
                r"|经营活动现金流|經營活動現金流|经营活动产生的现金|經營活動產生的現金"
                r"|經營活動之現金流入淨額|经营活动之现金流入净额"
            ),
        ],
        "cfi": [
            *lbl(
                r"\bcfi\b|(?:net\s*)?cash\s*(?:flows?\s*)?(?:from|used\s*in)\s*invest(?:ing|ment)\s*(?:activities)?"
                r"|投资活动现金流|投資活動現金流|投资活动产生的现金|投資活動產生的現金"
                r"|投資活動使用之淨現金|投资活动使用之净现金"
            ),
        ],
        "cff": [
            # Multi-line: "融資活動使用之\n 淨現金 ... (1,715)"
            rf"(?:融資活動使用之|融资活动使用之|Net\s*cash\s*(?:used\s*in|from)\s*financing)\s*\n[^\n]*?" + fnum,
            *lbl(
                r"\bcff\b|(?:net\s*)?cash\s*(?:flows?\s*)?(?:from|used\s*in)\s*financ(?:ing|e)\s*(?:activities)?"
                r"|筹资活动现金流|籌資活動現金流|融资活动|融資活動"
                r"|融資活動使用之淨現金|融资活动使用之净现金"
            ),
        ],
        "fx_effect": [
            *lbl(
                r"(?:effect\s*of\s*)?(?:exchange\s*rate|foreign\s*exchange|fx)\s*(?:changes?|effect|difference)"
                r"|effect\s*of\s*foreign\s*exchange\s*rate\s*changes?"
                r"|汇率变动|匯率變動|汇率影响|匯率影響|匯率調整之影響|汇率调整之影响"
                r"|(?:exchange\s*rate\s*)?(?:effect|changes?)\s*on\s*cash"
            ),
        ],
        "cash_open": [
            # Multi-line: "Cash and cash equivalents as at\n ... 1 January ... 3,816"
            rf"(?:cash\s*and\s*cash\s*equivalents\s*as\s*at)\s*\n[^\n]*1\s*January[^\n]*?" + fnum,
            rf"於一月一日之現金[^\n]*\n[^\n]*?" + fnum,
            rf"于一月一日之现金[^\n]*\n[^\n]*?" + fnum,
            *lbl(
                r"(?:opening|beginning)\s*(?:balance\s*of\s*)?cash"
                r"|cash[^\n]*(?:at\s*)?(?:beginning|opening)"
                r"|cash[^\n]*(?:as\s*at\s*)?(?:1\s*January|January\s*1)"
                r"|期初现金|期初現金|年初现金|年初現金"
                r"|於一月一日之現金|于一月一日之现金"
                r"|1\s*January[^\n]*cash"
            ),
        ],
        "cash_close": [
            # Multi-line: "Cash and cash equivalents as at\n ... 31 December ... 6,918"
            rf"(?:cash\s*and\s*cash\s*equivalents\s*as\s*at)\s*\n[^\n]*31\s*December[^\n]*?" + fnum,
            rf"於十二月三十一日之現金[^\n]*\n[^\n]*?" + fnum,
            rf"于十二月三十一日之现金[^\n]*\n[^\n]*?" + fnum,
            *lbl(
                r"(?:closing|ending)\s*(?:balance\s*of\s*)?cash"
                r"|cash[^\n]*(?:at\s*)?(?:end|closing)"
                r"|cash[^\n]*(?:as\s*at\s*)?(?:31\s*December|December\s*31)"
                r"|期末现金|期末現金|年末现金|年末現金"
                r"|於十二月三十一日之現金|于十二月三十一日之现金"
                r"|31\s*December[^\n]*cash"
            ),
        ],
        "depreciation_cf": [
            *lbl(
                r"(?:add\s*back\s*)?depreciation\s*(?:and\s*amortisation|&\s*amort)"
                r"|加回.*折旧|加回.*折舊"
                r"|depreciation\s*(?:of|charge|adjustment)"
            ),
        ],

        # ── Retained Earnings ──
        "re_open": [
            rf"(?:retained\s*(?:earnings?|profits?)|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^\n]*(?:opening|期初|年初)[^\n]*?" + fnum,
            rf"(?:retained\s*(?:earnings?|profits?))[^\n]*(?:as\s*at\s*)?1\s*January[^\n]*?" + fnum,
        ],
        "re_profit": [
            rf"(?:retained\s*(?:earnings?|profits?)|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^\n]*(?:profit|net\s*income|净利润|淨利潤|溢利)[^\n]*?" + fnum,
        ],
        "re_div": [
            rf"(?:retained\s*(?:earnings?|profits?)|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^\n]*(?:dividends?|股息|股利|分红|分紅)[^\n]*?" + fnum,
            *lbl(r"dividends?\s*(?:declared|paid|proposed)|已宣派股息|已派发股息|已派發股息|分红|分紅|股利分配|dividends?\s*paid"),
        ],
        "re_close": [
            rf"(?:retained\s*(?:earnings?|profits?)|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^\n]*(?:closing|期末|年末)[^\n]*?" + fnum,
            rf"(?:retained\s*(?:earnings?|profits?))[^\n]*(?:as\s*at\s*)?31\s*December[^\n]*?" + fnum,
        ],
        "dividends_declared": [
            *lbl(
                r"dividends?\s*(?:declared|paid|proposed)"
                r"|已宣派股息|已派发股息|已派發股息|分红|分紅|股利分配"
            ),
        ],

        # ── Balance Sheet Totals ──
        "total_assets": [
            # "Consolidated total assets" (segment note) — priority
            rf"(?:consolidated\s*)?total\s*assets(?!\s*(?:less|and))[^\n]*?" + fnum,
            rf"(?:綜合)?資產總值[^\n]*?" + fnum,
            rf"(?:综合)?资产总值[^\n]*?" + fnum,
            *lbl(
                r"资产总计|資產總計|资产总额|資產總額"
            ),
        ],
        "total_liabilities": [
            rf"(?:consolidated\s*)?total\s*liabilities[^\n]*?" + fnum,
            rf"(?:綜合)?負債總值[^\n]*?" + fnum,
            rf"(?:综合)?负债总值[^\n]*?" + fnum,
            *lbl(
                r"total\s*liabilities|负债总计|負債總計|负债合计|負債合計|总负债|總負債"
                r"|负债总额|負債總額"
            ),
        ],
        "total_equity": [
            *lbl(
                r"total\s*(?:shareholders?['\u2019']?\s*)?equity|equity\s*attributable"
                r"|权益总额|權益總額|权益合计|權益合計|股东权益合计|股東權益合計"
                r"|所有者权益|所有者權益|總權益|总权益"
            ),
        ],

        # ── Statement of Changes in Equity ──
        "eq_share_capital_open": [
            rf"(?:share\s*capital|issued\s*capital|股本)[^\n]*(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*?" + fnum,
            rf"(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*(?:share\s*capital|issued\s*capital|股本)[^\n]*?" + fnum,
        ],
        "eq_share_capital_close": [
            rf"(?:share\s*capital|issued\s*capital|股本)[^\n]*(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*?" + fnum,
            rf"(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*(?:share\s*capital|issued\s*capital|股本)[^\n]*?" + fnum,
        ],
        "eq_capital_reserve_open": [
            rf"(?:capital\s*reserve|share\s*premium|資本公積|资本公积|股本溢价|股本溢價)[^\n]*(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*?" + fnum,
            rf"(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*(?:capital\s*reserve|share\s*premium|資本公積|资本公积)[^\n]*?" + fnum,
        ],
        "eq_capital_reserve_close": [
            rf"(?:capital\s*reserve|share\s*premium|資本公積|资本公积|股本溢价|股本溢價)[^\n]*(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*?" + fnum,
            rf"(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*(?:capital\s*reserve|share\s*premium|資本公積|资本公积)[^\n]*?" + fnum,
        ],
        "eq_retained_open": [
            rf"(?:retained\s*(?:earnings?|profits?)|保留盈餘|保留盈利|保留溢利|未分配利潤|未分配利润|留存收益)[^\n]*(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*?" + fnum,
            rf"(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*(?:retained\s*(?:earnings?|profits?)|保留盈餘|保留盈利|未分配利潤)[^\n]*?" + fnum,
        ],
        "eq_retained_close": [
            rf"(?:retained\s*(?:earnings?|profits?)|保留盈餘|保留盈利|保留溢利|未分配利潤|未分配利润|留存收益)[^\n]*(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*?" + fnum,
            rf"(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*(?:retained\s*(?:earnings?|profits?)|保留盈餘|保留盈利|未分配利潤)[^\n]*?" + fnum,
        ],
        "eq_nci_open": [
            rf"(?:non[\-\s]*controlling\s*interests?|minority\s*interests?|非控制性權益|非控制性权益|少数股东权益|少數股東權益)[^\n]*(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*?" + fnum,
            rf"(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*(?:non[\-\s]*controlling|minority|非控制性權益|非控制性权益)[^\n]*?" + fnum,
        ],
        "eq_nci_close": [
            rf"(?:non[\-\s]*controlling\s*interests?|minority\s*interests?|非控制性權益|非控制性权益|少数股东权益|少數股東權益)[^\n]*(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*?" + fnum,
            rf"(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*(?:non[\-\s]*controlling|minority|非控制性權益|非控制性权益)[^\n]*?" + fnum,
        ],
        "eq_total_open": [
            rf"(?:total\s*equity|總權益|总权益|權益總額|权益总额)[^\n]*(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*?" + fnum,
            rf"(?:opening|期初|年初|at\s*1\s*January|at\s*beginning)[^\n]*(?:total\s*equity|總權益|总权益)[^\n]*?" + fnum,
        ],
        "eq_total_close": [
            rf"(?:total\s*equity|總權益|总权益|權益總額|权益总额)[^\n]*(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*?" + fnum,
            rf"(?:closing|期末|年末|at\s*31\s*December|at\s*end)[^\n]*(?:total\s*equity|總權益|总权益)[^\n]*?" + fnum,
        ],
        "eq_net_profit": [
            rf"(?:profit\s*for\s*the\s*year|net\s*(?:profit|income)|本年度溢利|本年度净利润|本年度淨利潤|年度溢利)[^\n]*?" + fnum,
        ],
        "eq_oci": [
            rf"(?:other\s*comprehensive\s*income|其他全面收益|其他綜合收益|其他综合收益)[^\n]*?" + fnum,
        ],
        "eq_dividends": [
            rf"(?:dividends?\s*(?:declared|paid)|已宣派股息|已派发股息|已派發股息|dividends?\s*paid)[^\n]*?" + fnum,
        ],
        "eq_share_based_payment": [
            rf"(?:share[\-\s]*based\s*(?:payment|compensation)|股份支付|以股份為基礎之付款)[^\n]*?" + fnum,
        ],
        "cf_dividends_paid": [
            rf"(?:dividends?\s*paid|已付股息|已派股息|已支付股利|支付股息)[^\n]*?" + fnum,
        ],
    }
    out: Dict[str, Optional[float]] = {}
    for key, patterns in fields.items():
        out[key] = _find_number(text, patterns)
    return out


# ── Cross-check result builder ──

def _cross_check(
    check_id: str,
    main_label: str,
    main_value: Optional[float],
    main_source: str,
    detail_values: List[Dict[str, Any]],
    tolerance: float = 0.5,
) -> Dict[str, Any]:
    """Build a rich cross-check result with detail breakdown."""
    non_none_details = [d for d in detail_values if d.get("value") is not None]
    all_none = all(d.get("value") is None for d in detail_values)

    if main_value is None or all_none or not non_none_details:
        missing = []
        if main_value is None:
            missing.append(main_source)
        missing.extend(d["label"] for d in detail_values if d.get("value") is None)
        return {
            "check": check_id,
            "status": "insufficient",
            "main_value": main_value,
            "main_source": main_source,
            "detail_values": detail_values,
            "detail_sum": None,
            "difference": None,
            "formula": f"insufficient data (missing: {', '.join(missing)})",
        }

    detail_sum = sum(d["value"] for d in non_none_details)
    diff = main_value - detail_sum
    status = "pass" if abs(diff) <= tolerance else "fail"

    # Build readable formula
    parts = " + ".join(f"{d['value']:,.2f}" for d in non_none_details)
    symbol = "==" if status == "pass" else "!="
    formula = f"{parts} = {detail_sum:,.2f} {symbol} {main_value:,.2f}"
    if status == "pass":
        formula += " [ok]"
    else:
        formula += f" [diff: {diff:,.2f}]"

    return {
        "check": check_id,
        "status": status,
        "main_value": main_value,
        "main_source": main_source,
        "detail_values": detail_values,
        "detail_sum": detail_sum,
        "difference": diff,
        "formula": formula,
    }


# ── PPE Category Analysis ──

# Industry-standard depreciation rate ranges (annual rate as decimal)
PPE_STANDARD_RATES: Dict[str, Tuple[float, float]] = {
    "buildings": (0.02, 0.05),        # 2-5% → 20-50 years
    "plant_machinery": (0.10, 0.20),  # 10-20% → 5-10 years
    "vehicles": (0.20, 0.25),         # 20-25% → 4-5 years
    "office_equipment": (0.20, 0.33), # 20-33% → 3-5 years
    "leasehold": (0.02, 0.10),        # varies by lease term
}

PPE_CATEGORIES = [
    ("buildings", "Buildings", "buildings"),
    ("plant", "Plant & Machinery", "plant_machinery"),
    ("vehicles", "Vehicles", "vehicles"),
    ("office", "Office Equipment", "office_equipment"),
    ("leasehold", "Leasehold Improvements", "leasehold"),
    ("land", "Land", None),  # Land typically not depreciated
]


def _build_ppe_category_rollforward(fields: Dict[str, Optional[float]]) -> List[Dict[str, Any]]:
    """Build per-category PPE rollforward verification.

    For each category, check: Opening + Additions - Disposals - Depreciation = Closing.
    Also considers transfers and impairment if available.
    """
    categories: List[Dict[str, Any]] = []

    for prefix, display_name, _rate_key in PPE_CATEGORIES:
        opening = fields.get(f"ppe_{prefix}_open")
        additions = fields.get(f"ppe_{prefix}_add")
        disposals = fields.get(f"ppe_{prefix}_disp")
        depreciation = fields.get(f"ppe_{prefix}_dep")
        closing = fields.get(f"ppe_{prefix}_close")
        transfer = fields.get("ppe_transfer")  # usually total, not per-category
        impairment = fields.get("ppe_impairment")

        cat: Dict[str, Any] = {
            "name": display_name,
            "opening": opening,
            "additions": additions,
            "disposals": disposals,
            "depreciation": depreciation,
            "closing": closing,
        }

        # Can we verify the rollforward?
        if opening is not None and closing is not None:
            calculated = opening
            if additions is not None:
                calculated += additions
            if disposals is not None:
                calculated -= abs(disposals)
            if depreciation is not None:
                calculated -= abs(depreciation)
            # Include transfers/impairment if available (these are total-level)
            # Only apply to first category to avoid double-counting
            cat["calculated"] = round(calculated, 2)
            cat["difference"] = round(closing - calculated, 2)
        else:
            cat["calculated"] = None
            cat["difference"] = None

        # Only include categories where we found at least some data
        has_data = any(v is not None for v in [opening, additions, disposals, depreciation, closing])
        if has_data:
            categories.append(cat)

    return categories


def _build_depreciation_rate_analysis(fields: Dict[str, Optional[float]]) -> List[Dict[str, Any]]:
    """Analyze depreciation rates by category against industry standards.

    Rate = annual_depreciation / ((opening_gross + closing_gross) / 2)
    Implied useful life = 1 / rate
    """
    results: List[Dict[str, Any]] = []

    for prefix, display_name, rate_key in PPE_CATEGORIES:
        if rate_key is None:
            continue  # Skip land (no depreciation)

        depreciation = fields.get(f"ppe_{prefix}_dep")
        opening_cost = fields.get(f"ppe_{prefix}_cost") or fields.get(f"ppe_{prefix}_open")
        closing_cost = fields.get(f"ppe_{prefix}_close")

        if depreciation is None or depreciation == 0:
            continue

        dep_abs = abs(depreciation)

        # Calculate average gross value
        if opening_cost is not None and closing_cost is not None:
            avg_gross = (opening_cost + closing_cost) / 2
        elif opening_cost is not None:
            avg_gross = opening_cost
        elif closing_cost is not None:
            avg_gross = closing_cost
        else:
            continue

        if avg_gross <= 0:
            continue

        rate = dep_abs / avg_gross
        implied_life = 1.0 / rate if rate > 0 else None
        expected_range = PPE_STANDARD_RATES.get(rate_key, (0.0, 1.0))
        reasonable = expected_range[0] <= rate <= expected_range[1]

        results.append({
            "name": display_name,
            "annual_depreciation": dep_abs,
            "average_gross": round(avg_gross, 2),
            "rate": round(rate, 4),
            "range": list(expected_range),
            "reasonable": reasonable,
            "implied_life": round(implied_life, 1) if implied_life else None,
            "flag": None if reasonable else (
                f"Rate {rate:.1%} is {'below' if rate < expected_range[0] else 'above'} "
                f"expected range {expected_range[0]:.0%}-{expected_range[1]:.0%} "
                f"for {display_name}"
            ),
        })

    return results


def _build_ppe_additional_checks(fields: Dict[str, Optional[float]]) -> List[Dict[str, Any]]:
    """Additional PPE checks: fully depreciated assets, small capitalizations, disposal analysis."""
    checks: List[Dict[str, Any]] = []

    # ── Fully depreciated assets still in use ──
    # If a category has cost > 0 but NBV (close) = 0, flag it
    for prefix, display_name, _ in PPE_CATEGORIES:
        cost = fields.get(f"ppe_{prefix}_cost")
        close = fields.get(f"ppe_{prefix}_close")
        if cost is not None and close is not None and cost > 0:
            if close == 0:
                checks.append({
                    "check": "fully_depreciated_in_use",
                    "category": display_name,
                    "cost": cost,
                    "nbv": 0,
                    "percentage_fully_depreciated": 100.0,
                    "flag": f"{display_name}: 100% fully depreciated (cost={cost:,.2f}, NBV=0) — assets may still be in use",
                })
            elif close < cost * 0.05:
                pct = round((1 - close / cost) * 100, 1)
                checks.append({
                    "check": "nearly_fully_depreciated",
                    "category": display_name,
                    "cost": cost,
                    "nbv": close,
                    "percentage_depreciated": pct,
                    "flag": f"{display_name}: {pct}% depreciated (cost={cost:,.2f}, NBV={close:,.2f})",
                })

    # ── Capitalization threshold check ──
    # Additions that are suspiciously small (< 5000) might should be expensed
    for prefix, display_name, _ in PPE_CATEGORIES:
        additions = fields.get(f"ppe_{prefix}_add")
        if additions is not None and 0 < additions < 5000:
            checks.append({
                "check": "small_capitalization",
                "category": display_name,
                "additions": additions,
                "threshold": 5000,
                "flag": f"{display_name}: additions of {additions:,.2f} below typical capitalization threshold of 5,000 — consider whether these should be expensed",
            })

    # ── Disposal gain/loss analysis ──
    proceeds = fields.get("ppe_disposal_proceeds")
    nbv_disposed = fields.get("ppe_disposal_nbv")
    reported_gain_loss = fields.get("ppe_disposal_gain_loss")

    if proceeds is not None and nbv_disposed is not None:
        computed_gain_loss = proceeds - abs(nbv_disposed)
        if reported_gain_loss is not None:
            diff = reported_gain_loss - computed_gain_loss
            status = "pass" if abs(diff) <= 0.5 else "fail"
        else:
            diff = None
            status = "computed_only"
        checks.append({
            "check": "disposal_gain_loss",
            "proceeds": proceeds,
            "nbv_disposed": abs(nbv_disposed),
            "computed_gain_loss": round(computed_gain_loss, 2),
            "reported_gain_loss": reported_gain_loss,
            "difference": round(diff, 2) if diff is not None else None,
            "status": status,
            "flag": None if status == "pass" else (
                f"Disposal: proceeds={proceeds:,.2f}, NBV={abs(nbv_disposed):,.2f}, "
                f"computed {'gain' if computed_gain_loss >= 0 else 'loss'}={abs(computed_gain_loss):,.2f}"
                + (f", reported={reported_gain_loss:,.2f}, diff={diff:,.2f}" if diff is not None else "")
            ),
        })
    elif reported_gain_loss is not None:
        checks.append({
            "check": "disposal_gain_loss",
            "proceeds": proceeds,
            "nbv_disposed": nbv_disposed,
            "computed_gain_loss": None,
            "reported_gain_loss": reported_gain_loss,
            "difference": None,
            "status": "partial",
            "flag": f"Disposal gain/loss reported as {reported_gain_loss:,.2f} but proceeds or NBV not found for verification",
        })

    return checks


def _build_cross_checks(fields: Dict[str, Optional[float]]) -> List[Dict[str, Any]]:
    """Build all programmatic cross-check results."""
    cross_checks: List[Dict[str, Any]] = []

    # ── 1. Balance Sheet vs Footnotes ──

    # 1a. Inventory reconciliation: BS inventory == sum of footnote breakdown
    inv_details = [
        {"label": "Raw materials", "value": fields.get("inventory_raw")},
        {"label": "Work in progress", "value": fields.get("inventory_wip")},
        {"label": "Finished goods", "value": fields.get("inventory_finished")},
        {"label": "Consumables", "value": fields.get("inventory_consumables")},
    ]
    # Filter out all-None entries but keep if at least some have values
    inv_details_present = [d for d in inv_details if d["value"] is not None]
    cross_checks.append(_cross_check(
        "inventory_reconciliation",
        "Inventories",
        fields.get("inventory_bs"),
        "Balance Sheet - Inventories",
        inv_details_present if inv_details_present else inv_details[:3],
    ))

    # 1b. Bank loans: BS short-term + long-term == footnote by maturity
    loan_bs_total = None
    if fields.get("loan_current") is not None and fields.get("loan_non_current") is not None:
        loan_bs_total = fields["loan_current"] + fields["loan_non_current"]
    elif fields.get("loan_current") is not None:
        loan_bs_total = fields["loan_current"]
    elif fields.get("loan_non_current") is not None:
        loan_bs_total = fields["loan_non_current"]

    # Try 4-bucket maturity first (<=1yr, 1-2yr, 2-3yr, 3yr+)
    has_4_bucket = fields.get("loan_2_3y") is not None or fields.get("loan_gt_3y") is not None
    if has_4_bucket:
        loan_details = [
            {"label": "Within 1 year", "value": fields.get("loan_lt_1y")},
            {"label": "1-2 years", "value": fields.get("loan_1_2y")},
            {"label": "2-3 years", "value": fields.get("loan_2_3y")},
            {"label": "Over 3 years", "value": fields.get("loan_gt_3y")},
        ]
    else:
        loan_details = [
            {"label": "Within 1 year", "value": fields.get("loan_lt_1y")},
            {"label": "1-2 years", "value": fields.get("loan_1_2y")},
            {"label": "Over 2 years", "value": fields.get("loan_gt_2y")},
        ]
    cross_checks.append(_cross_check(
        "loan_reconciliation",
        "Total bank loans (current + non-current)",
        loan_bs_total,
        "Balance Sheet - Short-term + Long-term borrowings",
        loan_details,
    ))

    # 1c. AR aging: BS AR == sum of AR aging buckets
    ar_details = [
        {"label": "0-30 days", "value": fields.get("ar_0_30")},
        {"label": "31-60 days", "value": fields.get("ar_31_60")},
        {"label": "61-90 days", "value": fields.get("ar_61_90")},
        {"label": "91-180 days", "value": fields.get("ar_91_180")},
        {"label": "Over 180 days", "value": fields.get("ar_over_180")},
    ]
    ar_details_present = [d for d in ar_details if d["value"] is not None]
    if not ar_details_present:
        # Fall back to simpler 3-bucket aging
        ar_details = [
            {"label": "0-30 days", "value": fields.get("ar_0_30")},
            {"label": "31-60 days", "value": fields.get("ar_31_60")},
            {"label": "Over 60 days", "value": fields.get("ar_60_plus")},
        ]
        ar_details_present = [d for d in ar_details if d["value"] is not None]
    cross_checks.append(_cross_check(
        "ar_aging_reconciliation",
        "Trade receivables",
        fields.get("ar_bs"),
        "Balance Sheet - Trade receivables",
        ar_details_present if ar_details_present else ar_details[:3],
    ))

    # 1d. PPE: BS PPE == footnote PPE schedule closing balance
    if fields.get("ppe_bs") is not None and fields.get("ppe_close") is not None:
        diff = (fields["ppe_bs"] or 0) - (fields["ppe_close"] or 0)
        status = "pass" if abs(diff) <= 0.5 else "fail"
        cross_checks.append({
            "check": "ppe_bs_vs_schedule",
            "status": status,
            "main_value": fields["ppe_bs"],
            "main_source": "Balance Sheet - PPE",
            "detail_values": [{"label": "PPE schedule closing balance", "value": fields["ppe_close"]}],
            "detail_sum": fields["ppe_close"],
            "difference": diff,
            "formula": f"BS PPE {fields['ppe_bs']:,.2f} {'==' if status == 'pass' else '!='} Schedule closing {fields['ppe_close']:,.2f}" + (" [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"),
        })
    else:
        cross_checks.append({
            "check": "ppe_bs_vs_schedule",
            "status": "insufficient",
            "main_value": fields.get("ppe_bs"),
            "main_source": "Balance Sheet - PPE",
            "detail_values": [{"label": "PPE schedule closing balance", "value": fields.get("ppe_close")}],
            "detail_sum": None,
            "difference": None,
            "formula": "insufficient data",
        })

    # ── 2. Income Statement vs Footnotes ──

    # 2a. Revenue: total revenue == sum of segment revenue
    rev_seg_details = [
        {"label": "Segment 1", "value": fields.get("rev_seg_1")},
        {"label": "Segment 2", "value": fields.get("rev_seg_2")},
        {"label": "Segment 3", "value": fields.get("rev_seg_3")},
    ]
    rev_seg_present = [d for d in rev_seg_details if d["value"] is not None]
    cross_checks.append(_cross_check(
        "revenue_segment_reconciliation",
        "Total revenue",
        fields.get("revenue"),
        "Income Statement - Revenue",
        rev_seg_present if rev_seg_present else rev_seg_details[:2],
    ))

    # 2b. COGS: total COGS == sum of COGS components
    cogs_details = [
        {"label": "Materials", "value": fields.get("cogs_materials")},
        {"label": "Direct labor", "value": fields.get("cogs_labor")},
        {"label": "Depreciation in COGS", "value": fields.get("cogs_depreciation")},
        {"label": "Manufacturing overhead", "value": fields.get("cogs_overhead")},
    ]
    cogs_present = [d for d in cogs_details if d["value"] is not None]
    cross_checks.append(_cross_check(
        "cogs_component_reconciliation",
        "Total COGS",
        fields.get("cogs"),
        "Income Statement - Cost of goods sold",
        cogs_present if cogs_present else cogs_details[:2],
    ))

    # ── 3. Cash Flow Verification ──

    # Opening cash + CFO + CFI + CFF + FX effect == Closing cash
    cf_details = [
        {"label": "Opening cash", "value": fields.get("cash_open")},
        {"label": "Operating CF", "value": fields.get("cfo")},
        {"label": "Investing CF", "value": fields.get("cfi")},
        {"label": "Financing CF", "value": fields.get("cff")},
    ]
    if fields.get("fx_effect") is not None:
        cf_details.append({"label": "FX effect", "value": fields.get("fx_effect")})

    cf_present = [d for d in cf_details if d["value"] is not None]
    cross_checks.append(_cross_check(
        "cash_flow_reconciliation",
        "Closing cash",
        fields.get("cash_close"),
        "Cash Flow Statement - Closing cash",
        cf_present if cf_present else cf_details,
    ))

    # ── 4. Cross-Statement Checks ──

    # 4a. Balance sheet equation: Total assets == Total liabilities + Total equity
    bs_details = [
        {"label": "Total liabilities", "value": fields.get("total_liabilities")},
        {"label": "Total equity", "value": fields.get("total_equity")},
    ]
    cross_checks.append(_cross_check(
        "balance_sheet_equation",
        "Total assets",
        fields.get("total_assets"),
        "Balance Sheet - Total assets",
        bs_details,
    ))

    # 4b. Gross profit bridge: Revenue - COGS == Gross profit
    # Note: COGS may be negative (parenthesized in financial statements), use absolute value
    if fields.get("revenue") is not None and fields.get("cogs") is not None:
        computed_gp = fields["revenue"] - abs(fields["cogs"])
        gp_reported = fields.get("gross_profit")
        if gp_reported is not None:
            diff = gp_reported - computed_gp
            status = "pass" if abs(diff) <= 0.5 else "fail"
            cross_checks.append({
                "check": "gross_profit_bridge",
                "status": status,
                "main_value": gp_reported,
                "main_source": "Income Statement - Gross profit",
                "detail_values": [
                    {"label": "Revenue", "value": fields["revenue"]},
                    {"label": "COGS (subtracted)", "value": fields["cogs"]},
                ],
                "detail_sum": computed_gp,
                "difference": diff,
                "formula": f"{fields['revenue']:,.2f} - {abs(fields['cogs']):,.2f} = {computed_gp:,.2f} {'==' if status == 'pass' else '!='} {gp_reported:,.2f}" + (" [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"),
            })
        else:
            cross_checks.append({
                "check": "gross_profit_bridge",
                "status": "insufficient",
                "main_value": None,
                "main_source": "Income Statement - Gross profit",
                "detail_values": [
                    {"label": "Revenue", "value": fields["revenue"]},
                    {"label": "COGS (subtracted)", "value": fields["cogs"]},
                ],
                "detail_sum": computed_gp,
                "difference": None,
                "formula": f"Revenue {fields['revenue']:,.2f} - COGS {abs(fields['cogs']):,.2f} = {computed_gp:,.2f} (gross profit not found for comparison)",
            })
    else:
        cross_checks.append({
            "check": "gross_profit_bridge",
            "status": "insufficient",
            "main_value": fields.get("gross_profit"),
            "main_source": "Income Statement - Gross profit",
            "detail_values": [
                {"label": "Revenue", "value": fields.get("revenue")},
                {"label": "COGS", "value": fields.get("cogs")},
            ],
            "detail_sum": None,
            "difference": None,
            "formula": "insufficient data (need revenue and COGS)",
        })

    # 4c. Net income == Closing RE - Opening RE + Dividends
    # Note: dividends may be negative (parenthesized in statements), use absolute value
    if fields.get("re_open") is not None and fields.get("re_close") is not None:
        dividends = abs(fields.get("dividends_declared") or fields.get("re_div") or 0)
        computed_ni = fields["re_close"] - fields["re_open"] + dividends
        ni_reported = fields.get("net_income")
        if ni_reported is not None:
            diff = ni_reported - computed_ni
            status = "pass" if abs(diff) <= 0.5 else "fail"
            cross_checks.append({
                "check": "net_income_vs_retained_earnings",
                "status": status,
                "main_value": ni_reported,
                "main_source": "Income Statement - Net income",
                "detail_values": [
                    {"label": "Closing retained earnings", "value": fields["re_close"]},
                    {"label": "Opening retained earnings (subtracted)", "value": fields["re_open"]},
                    {"label": "Dividends declared (added back)", "value": dividends},
                ],
                "detail_sum": computed_ni,
                "difference": diff,
                "formula": f"({fields['re_close']:,.2f} - {fields['re_open']:,.2f} + {dividends:,.2f}) = {computed_ni:,.2f} {'==' if status == 'pass' else '!='} {ni_reported:,.2f}" + (" [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"),
            })
        else:
            cross_checks.append({
                "check": "net_income_vs_retained_earnings",
                "status": "insufficient",
                "main_value": None,
                "main_source": "Income Statement - Net income",
                "detail_values": [
                    {"label": "Closing RE", "value": fields["re_close"]},
                    {"label": "Opening RE", "value": fields["re_open"]},
                ],
                "detail_sum": computed_ni,
                "difference": None,
                "formula": "net income not extracted for comparison",
            })
    else:
        cross_checks.append({
            "check": "net_income_vs_retained_earnings",
            "status": "insufficient",
            "main_value": fields.get("net_income"),
            "main_source": "Income Statement - Net income",
            "detail_values": [
                {"label": "Closing RE", "value": fields.get("re_close")},
                {"label": "Opening RE", "value": fields.get("re_open")},
            ],
            "detail_sum": None,
            "difference": None,
            "formula": "insufficient data (need opening and closing retained earnings)",
        })

    # 4d. Depreciation: CF depreciation add-back == IS depreciation expense
    dep_cf = fields.get("depreciation_cf")
    dep_is = fields.get("depreciation_is")
    if dep_cf is not None and dep_is is not None:
        diff = dep_cf - dep_is
        status = "pass" if abs(diff) <= 0.5 else "fail"
        cross_checks.append({
            "check": "depreciation_cross_statement",
            "status": status,
            "main_value": dep_is,
            "main_source": "Income Statement - Depreciation",
            "detail_values": [{"label": "CF depreciation add-back", "value": dep_cf}],
            "detail_sum": dep_cf,
            "difference": diff,
            "formula": f"IS depreciation {dep_is:,.2f} {'==' if status == 'pass' else '!='} CF add-back {dep_cf:,.2f}" + (" [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"),
        })
    else:
        cross_checks.append({
            "check": "depreciation_cross_statement",
            "status": "insufficient",
            "main_value": dep_is,
            "main_source": "Income Statement - Depreciation",
            "detail_values": [{"label": "CF depreciation add-back", "value": dep_cf}],
            "detail_sum": None,
            "difference": None,
            "formula": "insufficient data (need both IS depreciation and CF add-back)",
        })

    # 4e. PPE rollforward: ppe_close = ppe_open + ppe_add - ppe_disp - ppe_dep
    ppe_parts = [fields.get("ppe_open"), fields.get("ppe_add"), fields.get("ppe_disp"), fields.get("ppe_dep")]
    if all(v is not None for v in ppe_parts):
        computed_close = fields["ppe_open"] + fields["ppe_add"] - fields["ppe_disp"] - fields["ppe_dep"]
        ppe_close = fields.get("ppe_close")
        if ppe_close is not None:
            diff = ppe_close - computed_close
            status = "pass" if abs(diff) <= 0.5 else "fail"
            cross_checks.append({
                "check": "ppe_rollforward",
                "status": status,
                "main_value": ppe_close,
                "main_source": "PPE Schedule - Closing balance",
                "detail_values": [
                    {"label": "Opening", "value": fields["ppe_open"]},
                    {"label": "Additions", "value": fields["ppe_add"]},
                    {"label": "Disposals (subtracted)", "value": fields["ppe_disp"]},
                    {"label": "Depreciation (subtracted)", "value": fields["ppe_dep"]},
                ],
                "detail_sum": computed_close,
                "difference": diff,
                "formula": f"{fields['ppe_open']:,.2f} + {fields['ppe_add']:,.2f} - {fields['ppe_disp']:,.2f} - {fields['ppe_dep']:,.2f} = {computed_close:,.2f} {'==' if status == 'pass' else '!='} {ppe_close:,.2f}" + (" [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"),
            })
        else:
            cross_checks.append({
                "check": "ppe_rollforward",
                "status": "insufficient",
                "main_value": None,
                "main_source": "PPE Schedule - Closing balance",
                "detail_values": [
                    {"label": "Opening", "value": fields["ppe_open"]},
                    {"label": "Additions", "value": fields["ppe_add"]},
                    {"label": "Disposals", "value": fields["ppe_disp"]},
                    {"label": "Depreciation", "value": fields["ppe_dep"]},
                ],
                "detail_sum": computed_close,
                "difference": None,
                "formula": f"Computed closing = {computed_close:,.2f} (closing balance not found for comparison)",
            })
    else:
        cross_checks.append({
            "check": "ppe_rollforward",
            "status": "insufficient",
            "main_value": fields.get("ppe_close"),
            "main_source": "PPE Schedule - Closing balance",
            "detail_values": [
                {"label": "Opening", "value": fields.get("ppe_open")},
                {"label": "Additions", "value": fields.get("ppe_add")},
                {"label": "Disposals", "value": fields.get("ppe_disp")},
                {"label": "Depreciation", "value": fields.get("ppe_dep")},
            ],
            "detail_sum": None,
            "difference": None,
            "formula": "insufficient data for PPE rollforward",
        })

    # 4f. Retained earnings bridge: re_close = re_open + re_profit - re_div
    re_parts = [fields.get("re_open"), fields.get("re_profit")]
    if all(v is not None for v in re_parts):
        re_div = fields.get("re_div") or 0
        computed_re_close = fields["re_open"] + fields["re_profit"] - re_div
        re_close = fields.get("re_close")
        if re_close is not None:
            diff = re_close - computed_re_close
            status = "pass" if abs(diff) <= 0.5 else "fail"
            cross_checks.append({
                "check": "retained_earnings_bridge",
                "status": status,
                "main_value": re_close,
                "main_source": "Retained Earnings - Closing",
                "detail_values": [
                    {"label": "Opening RE", "value": fields["re_open"]},
                    {"label": "Profit for year", "value": fields["re_profit"]},
                    {"label": "Dividends (subtracted)", "value": re_div},
                ],
                "detail_sum": computed_re_close,
                "difference": diff,
                "formula": f"{fields['re_open']:,.2f} + {fields['re_profit']:,.2f} - {re_div:,.2f} = {computed_re_close:,.2f} {'==' if status == 'pass' else '!='} {re_close:,.2f}" + (" [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"),
            })
        else:
            cross_checks.append({
                "check": "retained_earnings_bridge",
                "status": "insufficient",
                "main_value": None,
                "main_source": "Retained Earnings - Closing",
                "detail_values": [
                    {"label": "Opening RE", "value": fields["re_open"]},
                    {"label": "Profit for year", "value": fields["re_profit"]},
                ],
                "detail_sum": computed_re_close,
                "difference": None,
                "formula": f"Computed closing RE = {computed_re_close:,.2f} (closing RE not found)",
            })
    else:
        cross_checks.append({
            "check": "retained_earnings_bridge",
            "status": "insufficient",
            "main_value": fields.get("re_close"),
            "main_source": "Retained Earnings - Closing",
            "detail_values": [
                {"label": "Opening RE", "value": fields.get("re_open")},
                {"label": "Profit for year", "value": fields.get("re_profit")},
                {"label": "Dividends", "value": fields.get("re_div")},
            ],
            "detail_sum": None,
            "difference": None,
            "formula": "insufficient data for retained earnings bridge",
        })

    # ── 5. Comprehensive PPE Analysis ──

    # 5a. PPE rollforward by category
    ppe_cat_rollforward = _build_ppe_category_rollforward(fields)
    if ppe_cat_rollforward:
        # Determine overall status: pass if all differences are within tolerance
        all_verified = [c for c in ppe_cat_rollforward if c.get("difference") is not None]
        if all_verified:
            max_diff = max(abs(c["difference"]) for c in all_verified)
            overall_status = "pass" if max_diff <= 0.5 else "fail"
        else:
            overall_status = "insufficient"
        cross_checks.append({
            "check": "ppe_rollforward_by_category",
            "status": overall_status,
            "categories": ppe_cat_rollforward,
            "formula": "Opening + Additions - Disposals - Depreciation = Closing (per category)",
        })
    else:
        cross_checks.append({
            "check": "ppe_rollforward_by_category",
            "status": "insufficient",
            "categories": [],
            "formula": "No per-category PPE data found",
        })

    # 5b. Depreciation rate reasonableness
    dep_rate_analysis = _build_depreciation_rate_analysis(fields)
    if dep_rate_analysis:
        all_reasonable = all(c.get("reasonable", True) for c in dep_rate_analysis)
        cross_checks.append({
            "check": "depreciation_rate_reasonableness",
            "status": "pass" if all_reasonable else "fail",
            "categories": dep_rate_analysis,
            "formula": "rate = annual_depreciation / avg(opening_gross, closing_gross); check vs industry range",
        })
    else:
        cross_checks.append({
            "check": "depreciation_rate_reasonableness",
            "status": "insufficient",
            "categories": [],
            "formula": "No category-level depreciation data found for rate analysis",
        })

    # 5c. Additional PPE checks (fully depreciated, capitalization, disposal)
    ppe_additional = _build_ppe_additional_checks(fields)
    if ppe_additional:
        has_flags = any(c.get("flag") for c in ppe_additional)
        cross_checks.append({
            "check": "ppe_additional_checks",
            "status": "fail" if has_flags else "pass",
            "items": ppe_additional,
            "formula": "Fully depreciated assets, capitalization threshold, disposal gain/loss",
        })

    # ── 6. Statement of Changes in Equity ──

    # Helper: equity column rollforward check
    def _equity_column_check(col_name: str, open_key: str, close_key: str) -> None:
        """Check: Opening + all changes = Closing for a single equity column."""
        opening = fields.get(open_key)
        closing = fields.get(close_key)

        # Gather change items relevant to this column
        change_items: List[Dict[str, Any]] = []
        col_lower = col_name.lower()
        if "retained" in col_lower:
            change_items = [
                {"label": "Net profit", "value": fields.get("eq_net_profit")},
                {"label": "Dividends (subtracted)", "value": fields.get("eq_dividends")},
            ]
        elif "reserve" in col_lower or "premium" in col_lower:
            change_items = [
                {"label": "Other comprehensive income", "value": fields.get("eq_oci")},
                {"label": "Share-based payment", "value": fields.get("eq_share_based_payment")},
            ]
        elif "non-controlling" in col_lower or "minority" in col_lower or "nci" in col_lower:
            change_items = [
                {"label": "NCI share of profit", "value": fields.get("eq_net_profit")},
                {"label": "NCI share of OCI", "value": fields.get("eq_oci")},
                {"label": "NCI dividends (subtracted)", "value": fields.get("eq_dividends")},
            ]

        non_none = [c for c in change_items if c.get("value") is not None]
        check_id = f"equity_{col_name.lower().replace(' ', '_').replace('-', '_')}_rollforward"
        if opening is not None and closing is not None and non_none:
            changes_sum = sum(c["value"] for c in non_none)
            expected_close = opening + changes_sum
            diff = closing - expected_close
            status = "pass" if abs(diff) <= 0.5 else "fail"
            parts = f"{opening:,.2f}"
            for c in non_none:
                parts += f" + {c['value']:,.2f}"
            formula = f"{parts} = {expected_close:,.2f} {'==' if status == 'pass' else '!='} {closing:,.2f}"
            formula += " [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"
            cross_checks.append({
                "check": check_id,
                "status": status,
                "main_value": closing,
                "main_source": f"{col_name} - Closing",
                "detail_values": [{"label": "Opening", "value": opening}] + change_items,
                "detail_sum": expected_close,
                "difference": diff,
                "formula": formula,
            })
        else:
            missing = []
            if opening is None:
                missing.append(f"{col_name} opening")
            if closing is None:
                missing.append(f"{col_name} closing")
            missing.extend(c["label"] for c in change_items if c.get("value") is None)
            cross_checks.append({
                "check": check_id,
                "status": "insufficient",
                "main_value": closing,
                "main_source": f"{col_name} - Closing",
                "detail_values": [{"label": "Opening", "value": opening}] + change_items,
                "detail_sum": None,
                "difference": None,
                "formula": f"insufficient data (missing: {', '.join(missing)})" if missing else "insufficient data",
            })

    # 6a. Each column rollforward: Opening + changes = Closing
    _equity_column_check("Share Capital", "eq_share_capital_open", "eq_share_capital_close")
    _equity_column_check("Capital Reserve", "eq_capital_reserve_open", "eq_capital_reserve_close")
    _equity_column_check("Retained Earnings", "eq_retained_open", "eq_retained_close")
    _equity_column_check("Non-controlling Interests", "eq_nci_open", "eq_nci_close")

    # 6b. Total equity column = sum of all individual columns
    eq_cols_close = [
        {"label": "Share Capital", "value": fields.get("eq_share_capital_close")},
        {"label": "Capital Reserve", "value": fields.get("eq_capital_reserve_close")},
        {"label": "Retained Earnings", "value": fields.get("eq_retained_close")},
        {"label": "Non-controlling Interests", "value": fields.get("eq_nci_close")},
    ]
    eq_total_close = fields.get("eq_total_close")
    eq_cols_non_none = [c for c in eq_cols_close if c.get("value") is not None]
    if eq_total_close is not None and len(eq_cols_non_none) >= 2:
        cols_sum = sum(c["value"] for c in eq_cols_non_none)
        diff = eq_total_close - cols_sum
        status = "pass" if abs(diff) <= 0.5 else "fail"
        parts = " + ".join(f"{c['value']:,.2f}" for c in eq_cols_non_none)
        formula = f"{parts} = {cols_sum:,.2f} {'==' if status == 'pass' else '!='} {eq_total_close:,.2f}"
        formula += " [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"
        cross_checks.append({
            "check": "equity_total_vs_columns",
            "status": status,
            "main_value": eq_total_close,
            "main_source": "Total Equity - Closing",
            "detail_values": eq_cols_close,
            "detail_sum": cols_sum,
            "difference": diff,
            "formula": formula,
        })
    else:
        cross_checks.append({
            "check": "equity_total_vs_columns",
            "status": "insufficient",
            "main_value": eq_total_close,
            "main_source": "Total Equity - Closing",
            "detail_values": eq_cols_close,
            "detail_sum": None,
            "difference": None,
            "formula": "insufficient data (need total equity and at least 2 column closing balances)",
        })

    # 6c. Net profit in equity statement = Income statement net profit
    eq_np = fields.get("eq_net_profit")
    is_np = fields.get("net_income")
    if eq_np is not None and is_np is not None:
        diff = eq_np - is_np
        status = "pass" if abs(diff) <= 0.5 else "fail"
        formula = f"Equity stmt net profit {eq_np:,.2f} {'==' if status == 'pass' else '!='} IS net income {is_np:,.2f}"
        formula += " [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"
        cross_checks.append({
            "check": "equity_net_profit_vs_income_statement",
            "status": status,
            "main_value": eq_np,
            "main_source": "Equity Statement - Net profit",
            "detail_values": [{"label": "Income Statement - Net income", "value": is_np}],
            "detail_sum": is_np,
            "difference": diff,
            "formula": formula,
        })
    else:
        missing = []
        if eq_np is None:
            missing.append("Equity statement net profit")
        if is_np is None:
            missing.append("Income statement net income")
        cross_checks.append({
            "check": "equity_net_profit_vs_income_statement",
            "status": "insufficient",
            "main_value": eq_np,
            "main_source": "Equity Statement - Net profit",
            "detail_values": [{"label": "Income Statement - Net income", "value": is_np}],
            "detail_sum": None,
            "difference": None,
            "formula": f"insufficient data (missing: {', '.join(missing)})",
        })

    # 6d. Dividends in equity = Cash flow statement dividends paid
    eq_div = fields.get("eq_dividends")
    cf_div = fields.get("cf_dividends_paid")
    if eq_div is not None and cf_div is not None:
        diff = abs(eq_div) - abs(cf_div)
        status = "pass" if abs(diff) <= 0.5 else "fail"
        formula = f"Equity dividends |{eq_div:,.2f}| {'==' if status == 'pass' else '!='} CF dividends paid |{cf_div:,.2f}|"
        formula += " [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"
        cross_checks.append({
            "check": "equity_dividends_vs_cashflow",
            "status": status,
            "main_value": eq_div,
            "main_source": "Equity Statement - Dividends",
            "detail_values": [{"label": "Cash Flow - Dividends paid", "value": cf_div}],
            "detail_sum": cf_div,
            "difference": diff,
            "formula": formula,
        })
    else:
        missing = []
        if eq_div is None:
            missing.append("Equity statement dividends")
        if cf_div is None:
            missing.append("Cash flow dividends paid")
        cross_checks.append({
            "check": "equity_dividends_vs_cashflow",
            "status": "insufficient",
            "main_value": eq_div,
            "main_source": "Equity Statement - Dividends",
            "detail_values": [{"label": "Cash Flow - Dividends paid", "value": cf_div}],
            "detail_sum": None,
            "difference": None,
            "formula": f"insufficient data (missing: {', '.join(missing)})",
        })

    # 6e. Closing total equity = Balance sheet total equity
    eq_tc = fields.get("eq_total_close")
    bs_te = fields.get("total_equity")
    if eq_tc is not None and bs_te is not None:
        diff = eq_tc - bs_te
        status = "pass" if abs(diff) <= 0.5 else "fail"
        formula = f"Equity stmt closing total {eq_tc:,.2f} {'==' if status == 'pass' else '!='} BS total equity {bs_te:,.2f}"
        formula += " [ok]" if status == "pass" else f" [diff: {diff:,.2f}]"
        cross_checks.append({
            "check": "equity_closing_vs_balance_sheet",
            "status": status,
            "main_value": eq_tc,
            "main_source": "Equity Statement - Closing total equity",
            "detail_values": [{"label": "Balance Sheet - Total equity", "value": bs_te}],
            "detail_sum": bs_te,
            "difference": diff,
            "formula": formula,
        })
    else:
        missing = []
        if eq_tc is None:
            missing.append("Equity statement closing total")
        if bs_te is None:
            missing.append("Balance sheet total equity")
        cross_checks.append({
            "check": "equity_closing_vs_balance_sheet",
            "status": "insufficient",
            "main_value": eq_tc,
            "main_source": "Equity Statement - Closing total equity",
            "detail_values": [{"label": "Balance Sheet - Total equity", "value": bs_te}],
            "detail_sum": None,
            "difference": None,
            "formula": f"insufficient data (missing: {', '.join(missing)})",
        })

    return cross_checks


# ── Legacy _check (kept for backward compat with existing `checks` array) ──

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


# ══════════════════════════════════════════════════════════════════════════════
# Full Casting Engine (铸表)
#
# Instead of checking only hardcoded items, this parses ALL line items from the
# financial statement text, auto-detects parent-child relationships via
# indentation, and verifies every total against its sub-items.  It also
# cross-matches items across statements via fuzzy label matching.
# ══════════════════════════════════════════════════════════════════════════════

# ── Section identification ──

_SECTION_PATTERNS: List[Tuple[str, str]] = [
    # (section_id, regex pattern)
    # These are matched against individual lines (not whole text) to find
    # standalone section headers and avoid picking up auditor's report references.
    ("income_statement", (
        r"^(?:\s*(?:consolidated\s*)?(?:statement\s*of\s*profit\s*(?:and|or)\s*loss(?:\s*account)?"
        r"|income\s*statement|profit\s*(?:and|&)\s*loss(?:\s*account)?)"
        r"|綜合損益(?:及其他全面收益)?表|综合损益表|利润表|利潤表|損益表)\s*$"
    )),
    ("comprehensive_income", (
        r"^(?:\s*(?:consolidated\s*)?(?:statement\s*of\s*comprehensive\s*income)"
        r"|綜合全面收益表|综合全面收益表)\s*$"
    )),
    ("balance_sheet", (
        r"^(?:\s*(?:consolidated\s*)?(?:statement\s*of\s*financial\s*position|balance\s*sheet)"
        r"|綜合財務狀況表|综合财务状况表|綜合資產負債表|综合资产负债表|资产负债表|資產負債表)\s*$"
    )),
    ("cash_flow", (
        r"^(?:\s*(?:consolidated\s*)?(?:(?:statement\s*of\s*)?cash\s*flows?(?:\s*statement)?)"
        r"|綜合現金流量表|综合现金流量表|現金流量表|现金流量表)\s*$"
    )),
    ("equity_changes", (
        r"^(?:\s*(?:consolidated\s*)?(?:statement\s*of\s*changes\s*in\s*equity)"
        r"|綜合權益變動表|综合权益变动表|權益變動表|股东权益变动表|股東權益變動表)\s*$"
    )),
    # Sentinel sections: these terminate the preceding section but are not
    # themselves parsed for line items.  They act as boundary markers so that
    # equity_changes (the last real statement) does not swallow the entire
    # notes section that follows it.
    ("_notes_sentinel", (
        r"^(?:\s*(?:notes?\s*to\s*(?:the\s*)?(?:consolidated\s*)?(?:financial\s*)?(?:statements?|报表|報表))"
        r"|綜合財務報告附註|综合财务报告附注|財務報表附註|财务报表附注"
        r"|附註|附注)\s*$"
    )),
]

# Section IDs that are sentinel-only (used for boundary detection, not parsed)
_SENTINEL_SECTIONS = {"_notes_sentinel"}

# Number pattern that captures financial numbers (with commas, parens, decimals)
_CAST_NUM_RE = re.compile(
    r"\(?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?"  # comma-formatted
    r"|\(\d+(?:\.\d+)?\)"                    # parenthesized
    r"|\d+\.\d+"                              # decimal
    r"|(?<!\d)(?!(?:19|20)\d{2}(?:\D|$))\d{4,}"  # 4+ digits, not year-like
, re.VERBOSE)

# Lines that are headers/noise, not real line items
_SKIP_LINE_RE = re.compile(
    r"^\s*(?:note(?:s)?|HK\$|RMB|USD|'000|million|千|百万|百萬|千元|人民幣|港幣|美元)\s*$"
    r"|^\s*[-=_]{3,}\s*$"                    # separator lines
    r"|^\s*\|[\s:*-]+\|\s*$"                 # Markdown table separator: |---|---|
    r"|^\s*\|[\s:*-]+(?:\|[\s:*-]+)+\|\s*$"  # multi-column: |---|---|---|
    r"|^\s*\d{1,2}\.\s"                      # footnote numbering (e.g. "6. Revenue")
    r"|^\s*$"                                 # blank
, re.IGNORECASE)

# Likely "total" / "subtotal" labels
_TOTAL_LABEL_RE = re.compile(
    r"\btotal\b|\bsubtotal\b|\bnet\b.*\b(?:assets?|liabilities|equity|income|profit|loss|cash)\b"
    r"|合[计計]|总[计計]|總[計计]|小[计計]|淨額|净额"
, re.IGNORECASE)

# Subtotal indicators: lines that summarize the immediately preceding item(s)
# but are NOT top-level totals.  Used to deduplicate children in addition checks.
# E.g., "Other comprehensive income for the year, net of tax" is a subtotal
# of the OCI detail lines above it.
_SUBTOTAL_INDICATOR_RE = re.compile(
    r"\bfor\s+the\s+(?:year|period),?\s*net\s+of\s+(?:income\s+)?tax\b"
    r"|除稅後|除税后"
    r"|\bnet\s+of\s+tax\b"
, re.IGNORECASE)


def _identify_sections(text: str) -> List[Dict[str, Any]]:
    """Identify financial statement sections by scanning each line as a potential
    standalone section header.  This avoids picking up references in the
    auditor's report or notes which mention statement names in prose.

    Returns list of {id, title, start, end} dicts, ordered by position.
    """
    lines = text.split('\n')
    # Build cumulative character offsets for each line
    offsets: List[int] = []
    pos = 0
    for line in lines:
        offsets.append(pos)
        pos += len(line) + 1  # +1 for the '\n'

    hits: List[Tuple[int, str, str]] = []  # (char_offset, section_id, title)
    for line_idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or len(stripped) > 120:
            # Skip blank lines and lines too long to be headers
            continue

        # Also handle Markdown headings: "## Consolidated Income Statement"
        heading_text = stripped
        if stripped.startswith('#'):
            heading_text = stripped.lstrip('#').strip()
            if not heading_text:
                continue

        for sec_id, pat in _SECTION_PATTERNS:
            # Try matching the original stripped line first (pdftotext format),
            # then the extracted heading text (Markdown format).
            # Also try without the end-of-string anchor ($) to handle combined
            # Chinese+English headings like "綜合現金流量表 Consolidated Cash Flow Statement"
            pat_no_end = pat.rstrip('$').rstrip()  # remove trailing $ anchor
            if re.match(pat, stripped, re.IGNORECASE) or \
               (heading_text != stripped and (
                   re.match(pat, heading_text, re.IGNORECASE) or
                   re.match(pat_no_end, heading_text, re.IGNORECASE)
               )):
                hits.append((offsets[line_idx], sec_id, heading_text))
                break

    if not hits:
        return []

    # Sort by position, keep first occurrence of each section type
    hits.sort(key=lambda h: h[0])
    sections: List[Dict[str, Any]] = []
    seen_ids: Dict[str, int] = {}  # sec_id -> index in sections list
    for i, (char_pos, sec_id, title) in enumerate(hits):
        next_pos = hits[i + 1][0] if i + 1 < len(hits) else len(text)
        if sec_id in seen_ids:
            # Only extend for "(continued)" / "(續)" pages that are close
            # to the original section (within 20000 chars ~ a few pages)
            existing = sections[seen_ids[sec_id]]
            gap = char_pos - existing["end"]
            is_continued = bool(re.search(r'continued|續|续', title, re.IGNORECASE))
            if is_continued or gap < 3000:
                existing["end"] = next_pos
            continue
        seen_ids[sec_id] = len(sections)
        sections.append({
            "id": sec_id,
            "title": title,
            "start": char_pos,
            "end": next_pos,
        })

    return sections


def _is_markdown_table_text(text: str) -> bool:
    """Detect whether text uses Markdown table format (pipe-separated rows)."""
    pipe_lines = 0
    total_lines = 0
    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped:
            continue
        total_lines += 1
        if stripped.startswith('|') and stripped.endswith('|'):
            pipe_lines += 1
    return total_lines > 0 and pipe_lines / total_lines > 0.3


def _extract_md_table_row(raw_line: str) -> Optional[Tuple[str, List[float]]]:
    """Parse a Markdown table row into (label, [numbers]).

    Handles Docling format:
      | 營業額 | Turnover | 37,985 | 38,635 |
      | 銷售成本 | Cost of sales | (21,625) | (22,160) | |

    Returns (label_string, list_of_floats) or None if not a data row.
    """
    stripped = raw_line.strip()
    if not stripped.startswith('|'):
        return None
    # Skip separator lines: |---|---|
    if re.match(r'^\|[\s:*-]+(?:\|[\s:*-]+)*\|\s*$', stripped):
        return None

    cells = [c.strip() for c in stripped.split('|')]
    # Remove empty strings from leading/trailing pipes
    if cells and cells[0] == '':
        cells = cells[1:]
    if cells and cells[-1] == '':
        cells = cells[:-1]

    if not cells:
        return None

    # Separate label cells from value cells.
    # Strategy: scan from the right; cells that parse as numbers are values.
    # Remaining left cells are labels. Also skip cells that are purely header
    # text (year labels, currency labels, etc.)
    label_parts: List[str] = []
    numbers: List[float] = []
    # Track which cells are numeric (scan all cells)
    cell_types: List[str] = []  # 'num', 'label', 'empty', 'header', 'note_ref'
    for cell in cells:
        if not cell or cell == '-':
            cell_types.append('empty')
        elif re.match(r'^\d{1,2}$', cell):
            # Note reference (e.g., "6", "13")
            cell_types.append('note_ref')
        elif re.match(
            r'^(?:附註|Notes?|RMB\s*million|HK\$|人民幣百萬元|'
            r'二零\S*|截至|For\s*the\s*year|As\s*at\s|'
            r'\d{4}\s*$)',
            cell, re.IGNORECASE
        ):
            cell_types.append('header')
        elif re.match(r'^【】$', cell):
            # Docling placeholder for redacted/missing data
            cell_types.append('empty')
        else:
            # Try to parse as a number — strip currency prefixes first
            num_cell = re.sub(r'^(?:RMB|HK\$|US\$|人民幣)\s*', '', cell)
            v = _to_float(num_cell)
            if v is not None:
                cell_types.append('num')
            elif re.match(r'^\(?\d[\d,.]*\)?$', num_cell):
                # Looks numeric but failed to parse — still treat as number
                cell_types.append('num')
            else:
                cell_types.append('label')

    # Now extract: labels are the leftmost 'label' cells, numbers are 'num' cells
    for i, (cell, ctype) in enumerate(zip(cells, cell_types)):
        if ctype == 'label':
            label_parts.append(cell)
        elif ctype == 'num':
            num_cell = re.sub(r'^(?:RMB|HK\$|US\$|人民幣)\s*', '', cell)
            v = _to_float(num_cell)
            if v is not None:
                numbers.append(v)

    label = ' '.join(label_parts).strip()
    return (label, numbers) if label or numbers else None


def _extract_line_items(section_text: str) -> List[Dict[str, Any]]:
    """Extract ALL line items with numbers from a section of financial text.

    Each item has: label, values (list of floats found on the line),
    indent_level (number of leading spaces), line_number.

    Handles TWO formats:
    1. pdftotext -layout: space-aligned columns, numbers at fixed positions
    2. Docling Markdown: pipe-separated table rows (| label | value | value |)

    Format is auto-detected per section.
    """
    items: List[Dict[str, Any]] = []
    lines = section_text.split('\n')
    is_markdown = _is_markdown_table_text(section_text)

    # Skip header lines (year labels, column headers, "Notes", "RMB million", etc.)
    _header_re = re.compile(
        r"^\s*(?:附註|Notes?\s*$|RMB\s*million|HK\$|人民幣百萬元|二零|截至|For\s*the\s*year|As\s*at\s)"
        r"|^\s*\d{4}\s*$"  # bare year
        r"|^\s*[-=_]{3,}\s*$"
        r"|^\s*#{1,4}\s"   # Markdown headings
    , re.IGNORECASE)

    # For Markdown tables, also skip column-header rows (contain year/currency labels)
    _md_header_re = re.compile(
        r"二零\S*\s*\d{4}|人民幣百萬元|RMB\s*million|附註\s*Notes?|增加\s*/",
        re.IGNORECASE,
    )

    for line_idx, raw_line in enumerate(lines):
        if not raw_line.strip():
            continue
        if _header_re.match(raw_line):
            continue
        if _SKIP_LINE_RE.match(raw_line):
            continue

        if is_markdown and '|' in raw_line:
            # ── Markdown table row parsing ──
            # Skip separator lines
            if re.match(r'^\s*\|[\s:*-]+(?:\|[\s:*-]+)*\|\s*$', raw_line.strip()):
                continue
            # Skip column-header rows (contain year/currency in cells)
            if _md_header_re.search(raw_line):
                continue

            result = _extract_md_table_row(raw_line)
            if result is None:
                continue
            label, numbers = result

            if not numbers:
                continue
            if not label or len(label) < 2:
                # Unlabeled subtotal row (e.g., "| | | 3,174 | 4,759 |")
                # Keep it — _build_hierarchy will handle it
                label = label or ''

            # Skip if label is just numbers or punctuation
            if label and re.match(r'^[\d,.()\s\-]+$', label):
                continue

            is_total = bool(_TOTAL_LABEL_RE.search(label)) if label else False

            # In Markdown tables, indent is approximated by leading whitespace
            # in the first cell (Docling preserves some spacing)
            cells_raw = raw_line.split('|')
            first_content = cells_raw[1] if len(cells_raw) > 1 else ''
            indent = len(first_content) - len(first_content.lstrip()) if first_content else 0

            items.append({
                "label": label,
                "values": numbers,
                "current_year": numbers[0] if len(numbers) >= 1 else None,
                "prior_year": numbers[1] if len(numbers) >= 2 else None,
                "indent": indent,
                "line": line_idx,
                "is_total": is_total,
            })
        else:
            # ── Original pdftotext space-aligned parsing ──
            # Find all financial numbers on this line.
            numbers: List[float] = []
            num_positions: List[int] = []  # character position of each number

            for m in _CAST_NUM_RE.finditer(raw_line):
                tok = m.group(0)
                v = _to_float(tok)
                if v is not None:
                    numbers.append(v)
                    num_positions.append(m.start())

            # Also pick up column-aligned bare numbers (3+ digits preceded by 2+ spaces)
            # that _CAST_NUM_RE might miss (e.g., small amounts without commas)
            for m in re.finditer(r'\s{2,}(\(?\d{3,}(?:\.\d+)?\)?)', raw_line):
                tok = m.group(1)
                v = _to_float(tok)
                if v is not None and v not in numbers:
                    # Skip if this looks like a year (1900-2099)
                    if 1900 <= abs(v) <= 2099 and ',' not in tok and '.' not in tok:
                        continue
                    numbers.append(v)
                    num_positions.append(m.start(1))

            if not numbers:
                continue

            # Determine label: text before the first number's column position.
            first_num_pos = min(num_positions) if num_positions else len(raw_line)
            label_region = raw_line[:first_num_pos]

            # Split on 3+ spaces to separate Chinese label from English translation
            segments = re.split(r'\s{3,}', label_region)
            label_parts: List[str] = []
            for seg in segments:
                seg = seg.strip()
                if not seg:
                    continue
                if re.match(r'^\d{1,2}$', seg):
                    continue
                label_parts.append(seg)
                if len(label_parts) >= 2:
                    break

            label = ' '.join(label_parts).strip() if label_parts else ''
            label = re.sub(r'\s+\d{1,2}\s*$', '', label).strip()

            if not label or len(label) < 2:
                continue
            if re.match(r'^[\d,.()\s\-]+$', label):
                continue
            if re.match(r'^\d{1,3}$', label):
                continue

            stripped = raw_line.lstrip()
            indent = len(raw_line) - len(stripped)
            is_total = bool(_TOTAL_LABEL_RE.search(label))

            items.append({
                "label": label,
                "values": numbers,
                "current_year": numbers[0] if len(numbers) >= 1 else None,
                "prior_year": numbers[1] if len(numbers) >= 2 else None,
                "indent": indent,
                "line": line_idx,
                "is_total": is_total,
            })

    return items


def _label_relates_to_total(total_label: str, child_labels: List[str]) -> bool:
    """Check if a total label has a plausible relationship with its children.

    Financial totals typically relate to their children via:
    - "Total X" where X appears in the group (e.g., "Total equity" for equity items)
    - "Gross profit" = revenue - COGS (known accounting relationship)
    - "Net X" = subtotal of X items
    - Chinese: "合计"/"小计"/"总额" patterns

    Returns True if the relationship seems plausible, False if suspicious.
    """
    tl = total_label.lower().strip()

    # Always trust generic totals (just "Total" / "合計" / "小計" etc.)
    if re.match(r'^(?:total|subtotal|sub[\-\s]*total|合[计計]|小[计計]|总[计計額额]|總[計计額额])\s*$', tl, re.IGNORECASE):
        return True

    # For "Total X" or "Net X", check if any child label contains related terms
    # Extract the subject from the total label
    subject_match = re.search(
        r'(?:total|net|subtotal|sub[\-\s]*total)\s+(.+)', tl, re.IGNORECASE
    )
    if subject_match:
        subject = subject_match.group(1).strip().lower()
        # Remove trailing punctuation
        subject = re.sub(r'[,.:;]+$', '', subject).strip()
        if len(subject) >= 3:
            # Check if any child has a related label (substring match or fuzzy)
            for cl in child_labels:
                cl_lower = cl.lower()
                # Direct keyword overlap
                subject_words = set(re.findall(r'\w{3,}', subject))
                child_words = set(re.findall(r'\w{3,}', cl_lower))
                if subject_words & child_words:
                    return True
            # No child has any relation -- suspicious
            # But allow if there are few children (2-3) which is common
            if len(child_labels) <= 3:
                return True
            return False

    # Chinese totals with subject: check for common patterns
    # e.g., "流動負債淨值" (Net current liabilities) should have liability children
    # For Chinese, we're more lenient -- trust the total detection
    if any('\u4e00' <= ch <= '\u9fff' for ch in tl):
        return True

    # Default: trust the relationship
    return True


def _build_hierarchy(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Auto-detect parent-child relationships using multiple strategies:

    1. Total-detection: lines with "total"/"subtotal"/"合计" labels are parents
       of the preceding consecutive items (up to the previous total).
    2. Indent-based: items with deeper indent under shallower-indent items.
    3. Unlabeled summary lines (lines that are just numbers at a certain column
       position) are treated as subtotals of preceding items.

    For pdftotext -layout format, indent-based hierarchy is unreliable because
    Chinese + English labels create varying indentation.  The total-detection
    approach is more robust for financial statements.

    Includes validation: rejects parent-child relationships where the total
    label has no plausible connection to its children (prevents false groupings).

    Returns items annotated with 'children_indices' and 'parent_index'.
    """
    n = len(items)
    for it in items:
        it["children_indices"] = []
        it["parent_index"] = None

    if n == 0:
        return items

    # Strategy 1: total-detection (primary for financial statements)
    # For each "total" item, scan backward to find its children.
    # Children are items between the previous total/subtotal and this one.
    assigned: set = set()  # indices already assigned as children

    for i in range(n):
        if not items[i]["is_total"]:
            continue

        # Scan backward from i-1 to find children
        children: List[int] = []
        for j in range(i - 1, -1, -1):
            if j in assigned:
                break
            if items[j]["is_total"]:
                break  # Stop at previous total
            # Stop at unlabeled subtotal rows (numbers-only lines that act as
            # section separators in balance sheets and other statements)
            if not items[j]["label"].strip():
                break
            children.append(j)

        if children:
            children.reverse()
            # Validate: check that this total label relates to the children
            child_labels = [items[ci]["label"] for ci in children]
            if _label_relates_to_total(items[i]["label"], child_labels):
                items[i]["children_indices"] = children
                for ci in children:
                    items[ci]["parent_index"] = i
                    assigned.add(ci)

    # Strategy 2: indent-based fallback for items not yet assigned
    # Only apply to labeled items that weren't handled by total-detection.
    # Skip unlabeled rows (subtotal separators) -- they should not form
    # parent-child relationships.
    for i in range(1, n):
        if items[i]["parent_index"] is not None:
            continue  # Already assigned
        if i in assigned:
            continue
        if not items[i]["label"].strip():
            continue  # Skip unlabeled rows
        # Look for a labeled parent with less indent
        for j in range(i - 1, -1, -1):
            if not items[j]["label"].strip():
                continue  # Skip unlabeled potential parents
            if items[j]["indent"] < items[i]["indent"] and items[j]["parent_index"] is None:
                items[i]["parent_index"] = j
                items[j]["children_indices"].append(i)
                assigned.add(i)
                break

    return items


def _verify_item(item: Dict[str, Any], all_items: List[Dict[str, Any]],
                 tolerance: float = 1.0) -> Dict[str, Any]:
    """Verify a single line item.

    If it has children, check that children's current_year values sum to
    this item's current_year (addition check).

    Tolerance: uses adaptive rounding tolerance -- max(base_tolerance, 0.1% of expected).
    Financial statements in millions often have +/-1 rounding differences.

    Returns a casting entry dict.
    """
    cur = item.get("current_year")
    pri = item.get("prior_year")

    # Variance
    variance_amt = None
    variance_pct = None
    if cur is not None and pri is not None:
        variance_amt = round(cur - pri, 2)
        if pri != 0:
            variance_pct = round((cur - pri) / abs(pri) * 100, 2)

    entry: Dict[str, Any] = {
        "label": item["label"],
        "current_year": cur,
        "prior_year": pri,
        "variance_amount": variance_amt,
        "variance_percent": variance_pct,
        "source": item.get("_section_id", "unknown"),
        "indent": item["indent"],
    }

    # Addition check: if this item has children, sum them
    children_idx = item.get("children_indices", [])
    if children_idx and cur is not None:
        child_sum = 0.0
        child_labels: List[str] = []
        child_values: List[Optional[float]] = []
        all_have_values = True

        # Deduplicate subtotals: if a child is a subtotal of preceding
        # children (same value, labeled as subtotal), exclude the detail
        # items it summarizes to avoid double-counting.
        # Example: OCI detail (-31) + OCI subtotal (-31) should only count once.
        skip_indices: set = set()
        for k, ci in enumerate(children_idx):
            child = all_items[ci]
            if _SUBTOTAL_INDICATOR_RE.search(child["label"]):
                # This child is a subtotal -- find preceding children with
                # values that sum to this subtotal's value
                subtotal_val = child.get("current_year")
                if subtotal_val is not None:
                    running = 0.0
                    for prev_k in range(k - 1, -1, -1):
                        prev_ci = children_idx[prev_k]
                        if prev_ci in skip_indices:
                            continue
                        prev_val = all_items[prev_ci].get("current_year")
                        if prev_val is not None:
                            running += prev_val
                            if abs(running - subtotal_val) < 0.01:
                                # These detail items are summarized by the subtotal
                                for dedup_k in range(prev_k, k):
                                    skip_indices.add(children_idx[dedup_k])
                                break

        for ci in children_idx:
            child = all_items[ci]
            cv = child.get("current_year")
            child_labels.append(child["label"])
            child_values.append(cv)
            if ci in skip_indices:
                continue  # Skip detail items replaced by their subtotal
            if cv is not None:
                child_sum += cv
            else:
                all_have_values = False

        effective_count = sum(1 for ci in children_idx if ci not in skip_indices)
        if all_have_values and effective_count >= 2:
            diff = cur - child_sum
            # Adaptive tolerance: 0.1% of expected value or base tolerance,
            # whichever is larger.  Handles rounding in millions.
            adaptive_tol = max(tolerance, abs(child_sum) * 0.001)
            if abs(diff) <= adaptive_tol:
                if abs(diff) > tolerance and abs(diff) > 0:
                    entry["addition_check"] = "pass_with_rounding"
                else:
                    entry["addition_check"] = "pass"
            else:
                entry["addition_check"] = "fail"
            entry["addition_expected"] = round(child_sum, 2)
            entry["addition_diff"] = round(diff, 2)
            entry["addition_children"] = child_labels
        else:
            entry["addition_check"] = "not_applicable"
    else:
        entry["addition_check"] = "not_applicable"

    return entry


def _fuzzy_match_score(a: str, b: str) -> float:
    """Return similarity score (0-1) between two labels, case-insensitive."""
    a_lower = a.lower().strip()
    b_lower = b.lower().strip()
    if a_lower == b_lower:
        return 1.0
    return SequenceMatcher(None, a_lower, b_lower).ratio()


# Known cross-statement label equivalences (label fragment -> canonical)
# Each entry: (canonical_id, variant_list, optional_section_filter)
# Section filter: if provided, only match items from these sections.
# This prevents false matches, e.g., equity_changes "Profit for the year"
# (which is attributable-only) matching IS "Profit for the year" (group total).
_LABEL_EQUIVALENCES: List[Tuple[str, List[str]]] = [
    ("net_profit", [
        "net income", "net profit", "profit for the year", "profit for the period",
        "本年度溢利", "净利润", "淨利潤", "纯利", "純利",
        "年度溢利", "本期利润", "本期利潤",
    ]),
    ("total_equity", [
        "total equity", "total shareholders' equity", "權益總額", "权益总额",
        "總權益", "总权益", "股东权益合计", "股東權益合計",
    ]),
    ("cash_closing", [
        "closing cash", "期末现金", "期末現金",
        "年末现金", "年末現金", "cash at end", "cash at 31 december",
        "於十二月三十一日之現金", "于十二月三十一日之现金",
        "於十二月三十一日之 現金及現金等價物",
        "于十二月三十一日之 现金及现金等价物",
    ]),
    ("cash_opening", [
        "cash at beginning", "opening cash", "期初现金", "期初現金",
        "cash at 1 january", "於一月一日之現金", "于一月一日之现金",
    ]),
    ("revenue", [
        "revenue", "turnover", "营业收入", "營業收入", "营业额", "營業額",
        "销售收入", "銷售收入", "total revenue",
    ]),
    ("dividends", [
        "dividends declared", "dividends paid", "已宣派股息", "已派发股息",
        "已派發股息",
    ]),
    ("depreciation", [
        "depreciation", "depreciation and amortisation", "depreciation and amortization",
        "折旧", "折舊", "折旧及摊销", "折舊及攤銷",
    ]),
]

# Labels that should NOT be canonicalized (too ambiguous or represent
# different things in different statements)
_CROSS_STMT_EXCLUDE_LABELS = re.compile(
    r"profit\s*attributable"           # IS attributable != group profit
    r"|net\s*(?:decrease|increase)\s*in\s*cash"  # CF net change != BS cash balance
    r"|cash\s*and\s*cash\s*equivalents"  # Ambiguous: BS balance vs CF line
    r"|股息|股利|分红|分紅"              # dividends -- too many variants
, re.IGNORECASE)


def _canonicalize_label(label: str) -> Optional[str]:
    """Map a line item label to its canonical cross-statement id, or None.

    Uses strict matching to avoid false positives: the variant must match
    as a whole word/phrase, not as a substring of a longer unrelated label.
    """
    label_lower = label.lower().strip()
    # Skip very short labels (too ambiguous) and very long labels (notes text)
    if len(label_lower) < 3 or len(label_lower) > 80:
        return None

    # Exclude labels known to be ambiguous across statements
    if _CROSS_STMT_EXCLUDE_LABELS.search(label_lower):
        return None

    for canon_id, variants in _LABEL_EQUIVALENCES:
        for v in variants:
            v_lower = v.lower()
            # Exact match or label starts with the variant
            if label_lower == v_lower:
                return canon_id
            # The variant is the primary part of the label (appears at start or after Chinese)
            # Use word-boundary check for English, direct containment for Chinese
            if len(v_lower) >= 4:
                # For Chinese characters (len >= 2 chars but short byte-wise is fine)
                if any('\u4e00' <= ch <= '\u9fff' for ch in v_lower):
                    # Chinese: exact containment with label being short
                    if v_lower in label_lower and len(label_lower) < len(v_lower) * 3:
                        return canon_id
                else:
                    # English: word boundary match
                    if re.search(r'\b' + re.escape(v_lower) + r'\b', label_lower):
                        return canon_id
            # Fuzzy match only for very similar labels
            if _fuzzy_match_score(label_lower, v_lower) > 0.88:
                return canon_id
    return None


def _cross_statement_checks(
    section_items: Dict[str, List[Dict[str, Any]]],
    tolerance: float = 1.0,
) -> List[Dict[str, Any]]:
    """Auto-discover cross-statement matches by label similarity.

    For items that appear in multiple statements, verify their values match.
    """
    # Primary statement sections (prefer matching across these, not equity sub-tables)
    _primary_sections = {"income_statement", "comprehensive_income", "balance_sheet",
                         "cash_flow"}

    # Build a map: canonical_id -> list of (section_id, label, current_year)
    # Exclude equity_changes for certain canonical IDs where the equity matrix
    # shows different amounts (e.g., "profit for the year" in equity = attributable
    # only, vs IS = group total including NCI).
    _equity_exclude_canonicals = {"net_profit", "total_equity", "revenue"}
    canonical_map: Dict[str, List[Tuple[str, str, Optional[float]]]] = {}
    for sec_id, items in section_items.items():
        for item in items:
            canon = _canonicalize_label(item["label"])
            if canon is None:
                continue
            # Skip equity_changes for items known to differ structurally
            if sec_id == "equity_changes" and canon in _equity_exclude_canonicals:
                continue
            canonical_map.setdefault(canon, []).append(
                (sec_id, item["label"], item.get("current_year"))
            )

    results: List[Dict[str, Any]] = []
    for canon_id, entries in canonical_map.items():
        # Only check if item appears in 2+ different sections
        sections_seen = set(e[0] for e in entries)
        if len(sections_seen) < 2:
            continue

        # Compare values across sections -- prefer primary statement sections.
        # Use first occurrence per section.
        by_section: Dict[str, Tuple[str, str, Optional[float]]] = {}
        # Process primary sections first, then others
        sorted_entries = sorted(entries, key=lambda e: (0 if e[0] in _primary_sections else 1))
        for s, l, v in sorted_entries:
            if s not in by_section and v is not None:
                by_section[s] = (s, l, v)

        valued = list(by_section.values())
        if len(valued) < 2:
            continue

        # Use first occurrence (preferably from primary section) as reference
        ref_sec, ref_label, ref_val = valued[0]
        for other_sec, other_label, other_val in valued[1:]:
            if other_sec == ref_sec:
                continue
            diff = abs(ref_val - other_val) if ref_val is not None and other_val is not None else None
            status = "not_applicable"
            if diff is not None:
                # Adaptive tolerance for cross-statement: 0.1% or base
                adaptive_tol = max(tolerance, abs(ref_val) * 0.001)
                if diff <= adaptive_tol:
                    status = "pass" if diff <= tolerance else "pass_with_rounding"
                else:
                    status = "fail"

            results.append({
                "canonical_id": canon_id,
                "label_a": ref_label,
                "section_a": ref_sec,
                "value_a": ref_val,
                "label_b": other_label,
                "section_b": other_sec,
                "value_b": other_val,
                "difference": round(diff, 2) if diff is not None else None,
                "status": status,
            })

    return results


def cast_financial_statements(text: str, tolerance: float = 1.0) -> Dict[str, Any]:
    """Full casting (铸表): parse all line items, verify every total, cross-match
    across statements.

    Returns {
        casting_sheet: [...],         # every line item with verification
        cross_statement_matches: [...], # auto-discovered cross-statement checks
        section_summaries: {...},     # per-section stats
        stats: {...},                 # overall pass/fail/na counts
    }
    """
    sections = _identify_sections(text)

    # If no sections identified, treat entire text as a single section
    if not sections:
        sections = [{"id": "unidentified", "title": "Full Document", "start": 0, "end": len(text)}]

    casting_sheet: List[Dict[str, Any]] = []
    section_items_map: Dict[str, List[Dict[str, Any]]] = {}
    section_summaries: Dict[str, Dict[str, Any]] = {}

    for sec in sections:
        # Skip sentinel sections (boundaries only, not parsed)
        if sec["id"] in _SENTINEL_SECTIONS:
            continue

        sec_text = text[sec["start"]:sec["end"]]
        items = _extract_line_items(sec_text)

        # Tag each item with section info
        for item in items:
            item["_section_id"] = sec["id"]

        # For equity changes: detect matrix format (multiple numeric columns
        # per row representing different equity components).  These are NOT
        # parent-child relationships -- they are columns.  Skip hierarchy
        # building entirely and only do flat extraction.
        is_equity_matrix = sec["id"] == "equity_changes"

        # Build hierarchy (skip for equity matrix)
        if not is_equity_matrix:
            items = _build_hierarchy(items)

        # Store for cross-statement checks
        section_items_map[sec["id"]] = items

        # Verify each item
        sec_entries: List[Dict[str, Any]] = []
        for item in items:
            entry = _verify_item(item, items, tolerance=tolerance)
            entry["source"] = sec["id"]
            entry["source_title"] = sec["title"]
            sec_entries.append(entry)

        casting_sheet.extend(sec_entries)

        # Section summary
        pass_c = sum(1 for e in sec_entries if e.get("addition_check") in ("pass", "pass_with_rounding"))
        fail_c = sum(1 for e in sec_entries if e.get("addition_check") == "fail")
        na_c = sum(1 for e in sec_entries if e.get("addition_check") == "not_applicable")
        section_summaries[sec["id"]] = {
            "title": sec["title"],
            "line_items": len(sec_entries),
            "addition_pass": pass_c,
            "addition_fail": fail_c,
            "addition_na": na_c,
        }

    # Cross-statement checks
    cross_matches = _cross_statement_checks(section_items_map, tolerance=tolerance)

    # Overall stats
    total_pass = sum(1 for e in casting_sheet if e.get("addition_check") in ("pass", "pass_with_rounding"))
    total_fail = sum(1 for e in casting_sheet if e.get("addition_check") == "fail")
    total_na = sum(1 for e in casting_sheet if e.get("addition_check") == "not_applicable")
    xstmt_pass = sum(1 for m in cross_matches if m.get("status") in ("pass", "pass_with_rounding"))
    xstmt_fail = sum(1 for m in cross_matches if m.get("status") == "fail")

    return {
        "casting_sheet": casting_sheet,
        "cross_statement_matches": cross_matches,
        "section_summaries": section_summaries,
        "stats": {
            "total_line_items": len(casting_sheet),
            "sections_found": len(sections),
            "addition_pass": total_pass,
            "addition_fail": total_fail,
            "addition_na": total_na,
            "cross_statement_pass": xstmt_pass,
            "cross_statement_fail": xstmt_fail,
            "cross_statement_total": len(cross_matches),
        },
    }


# ══════════════════════════════════════════════════════════════════════════════
# Notes Verification Engine (附注验证)
#
# Parses all numbered footnotes from the notes section, verifies:
# 1. Internal addition: sub-items add up to note totals
# 2. Statement tie-out: note totals match main statement line items
# 3. Cross-note references: numbers cited across notes are consistent
# 4. Prior year consistency: current "opening" == prior "closing"
# ══════════════════════════════════════════════════════════════════════════════

# Pattern to detect note section headings like "## 18. Goodwill" or
# "## 二十三 . 存貨   23  Stocks" or inline table rows with note numbers
_NOTE_HEADING_RE = re.compile(
    r'^\s*(?:#{1,4}\s+)?'                          # optional Markdown heading
    r'(?:'
    r'(?:(?:十九|十八|十七|十六|十五|十四|十三|十二|十一|'
    r'二十[一二三四五六七八九]?|三十[一二三四五六七八九]?|'
    r'[一二三四五六七八九十])\s*[\.\．]?\s*)?'           # Chinese numeral prefix
    r'(?:[^\n]{0,30}?)?'                            # optional Chinese title
    r'(\d{1,2})\s*[\.\．]\s*'                        # captured Arabic note number
    r'([A-Za-z][^\n]{2,60}?)'                       # captured English title
    r')',
    re.IGNORECASE
)

# Chinese-only note heading: "## 二十五 . 貿易及其他應付款項" (no Arabic number or English title)
_NOTE_CN_HEADING_RE = re.compile(
    r'^\s*(?:#{1,4}\s+)?'
    r'(十[一二三四五六七八九]|二十[一二三四五六七八九]?|三十[一二三四五六七八九]?|'
    r'[一二三四五六七八九十])\s*[\.\．]\s*'
    r'([\u4e00-\u9fff][^\n]{1,40}?)\s*$'
)

# Pattern for note headings in table rows: | 二十三 . | 存貨 | 23 | Stocks |
_NOTE_TABLE_HEADING_RE = re.compile(
    r'\|\s*(?:十[一二三四五六七八九]?|二十[一二三四五六七八九]?|'
    r'三十[一二三四五六七八九]?|[一二三四五六七八九])\s*[\.\．]?\s*\|'
    r'[^|]*\|\s*(\d{1,2})\s*\|\s*([A-Za-z][^|]{2,60}?)\s*\|',
    re.IGNORECASE
)

# Main statement note reference: "| Fixed assets | 16 | 17,963 |"
# or "附註 Notes" column with number
_BS_NOTE_REF_RE = re.compile(
    r'(?:Note|附註)\s*(\d{1,2})|'
    r'\|\s*(\d{1,2})\s*\|',
    re.IGNORECASE
)

# Chinese-to-Arabic note number mapping for cross-references in text
_CN_NUM_MAP = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15,
    '十六': 16, '十七': 17, '十八': 18, '十九': 19,
    '二十': 20, '二十一': 21, '二十二': 22, '二十三': 23,
    '二十四': 24, '二十五': 25, '二十六': 26, '二十七': 27,
    '二十八': 28, '二十九': 29, '三十': 30, '三十一': 31,
    '三十二': 32, '三十三': 33, '三十四': 34, '三十五': 35,
}

# Pattern to find "(Note XX)" or "(附註XX)" references in note text
_CROSS_NOTE_REF_RE = re.compile(
    r'(?:Note|附註)\s*(\d{1,2})|'
    r'附註(十[一二三四五六七八九]?|二十[一二三四五六七八九]?|'
    r'三十[一二三四五六七八九]?|[一二三四五六七八九])',
    re.IGNORECASE
)


def _extract_notes(text: str) -> Dict[int, Dict[str, Any]]:
    """Parse all numbered notes from the notes section of the annual report.

    Returns: { note_number: {
        title: str,
        text: str,          # raw text of this note section
        tables: [ { items: [{label, current, prior}], total_current, total_prior } ],
    }}
    """
    lines = text.split('\n')

    # Find where the notes section actually starts — look for the first
    # "Notes to the Consolidated Financial Statements" / "綜合財務報告附註"
    # heading that appears AFTER the main statements.
    notes_start_line = 0
    for i, line in enumerate(lines):
        stripped = line.strip().lstrip('#').strip()
        if re.match(
            r'(?:Notes?\s+to\s+(?:the\s+)?(?:Consolidated\s+)?Financial\s+Statements?'
            r'|綜合財務報告附註|财务报表附注)\s*$',
            stripped, re.IGNORECASE
        ):
            notes_start_line = i
            break

    # First pass: find all note heading positions (only in notes section)
    note_positions: List[Tuple[int, int, str]] = []  # (line_idx, note_num, title)

    for i, line in enumerate(lines):
        if i < notes_start_line:
            continue
        stripped = line.strip()
        if not stripped:
            continue

        # Try heading pattern (English or bilingual)
        m = _NOTE_HEADING_RE.match(stripped)
        if m:
            num = int(m.group(1))
            title = m.group(2).strip()
            title_clean = re.sub(r'\s*\(continued\).*', '', title, flags=re.IGNORECASE).strip()
            is_continued = bool(re.search(r'continued|續|续', stripped, re.IGNORECASE))
            existing = [idx for idx, (_, n, _) in enumerate(note_positions) if n == num]
            if not existing:
                note_positions.append((i, num, title_clean))
            elif is_continued:
                note_positions.append((i, num, title_clean))
            continue

        # Try Chinese-only heading (e.g., "## 二十五 . 貿易及其他應付款項")
        m = _NOTE_CN_HEADING_RE.match(stripped)
        if m:
            cn_num_str = m.group(1)
            cn_title = m.group(2).strip()
            num = _CN_NUM_MAP.get(cn_num_str)
            if num is not None:
                is_continued = bool(re.search(r'續|续', cn_title))
                existing = [idx for idx, (_, n, _) in enumerate(note_positions) if n == num]
                if not existing:
                    # Use Chinese title as placeholder until English heading is found
                    note_positions.append((i, num, cn_title))
                elif is_continued:
                    note_positions.append((i, num, cn_title))
                continue

        # Try table-row heading pattern
        m = _NOTE_TABLE_HEADING_RE.search(stripped)
        if m:
            num = int(m.group(1))
            title = m.group(2).strip()
            if not any(n == num for _, n, _ in note_positions):
                note_positions.append((i, num, title))

    if not note_positions:
        return {}

    # Sort by line position
    note_positions.sort(key=lambda x: x[0])

    # Second pass: deduplicate positions — keep only the first occurrence per
    # (note_num, line_idx) to avoid processing the same heading twice.
    seen_positions: set = set()
    deduped_positions: List[Tuple[int, int, str]] = []
    for pos in note_positions:
        key = (pos[0], pos[1])  # (line_idx, note_num)
        if key not in seen_positions:
            seen_positions.add(key)
            deduped_positions.append(pos)
    note_positions = deduped_positions

    # Third pass: for each note number, find the range of lines it spans.
    # Collect all line positions per note number, then compute
    # [earliest_start, start_of_next_different_note) for the merged range.
    note_ranges: Dict[int, Tuple[int, int, str]] = {}  # num -> (start_line, end_line, title)
    # First, determine the position ordering of unique note numbers by first appearance
    note_first_pos: Dict[int, int] = {}  # num -> first line_idx
    for (line_idx, note_num, title) in note_positions:
        if note_num not in note_first_pos:
            note_first_pos[note_num] = line_idx

    # Sort note numbers by first appearance
    ordered_nums = sorted(note_first_pos.keys(), key=lambda n: note_first_pos[n])

    for i, num in enumerate(ordered_nums):
        start_line = note_first_pos[num]
        # End = start of the next different note number, or end of text
        if i + 1 < len(ordered_nums):
            next_num = ordered_nums[i + 1]
            end_line = note_first_pos[next_num]
        else:
            end_line = len(lines)

        # Pick best title: prefer English over Chinese
        best_title = ""
        for (_, n, t) in note_positions:
            if n == num:
                if not best_title or (re.match(r'^[A-Za-z]', t) and re.match(r'^[\u4e00-\u9fff]', best_title)):
                    best_title = t
        note_ranges[num] = (start_line, end_line, best_title)

    # Build notes dict
    notes: Dict[int, Dict[str, Any]] = {}
    for num, (start_line, end_line, title) in note_ranges.items():
        note_text = '\n'.join(lines[start_line:end_line])
        notes[num] = {
            "title": title,
            "text": note_text,
            "tables": [],
        }

    # Third pass: parse tables within each note
    for note_num, note_data in notes.items():
        note_data["tables"] = _parse_note_tables(note_data["text"])

    return notes


def _parse_note_tables(note_text: str) -> List[Dict[str, Any]]:
    """Extract Markdown tables from a note's text, identifying sub-items and totals.

    Returns list of tables, each: {
        items: [{label, current, prior}],
        total_current: float or None,
        total_prior: float or None,
        has_total: bool,
    }
    """
    lines = note_text.split('\n')
    tables: List[Dict[str, Any]] = []
    current_table_rows: List[Tuple[str, List[float]]] = []

    # Header detection to skip
    _md_hdr_re = re.compile(
        r'二零\S*\s*\d{4}|人民幣百萬元|RMB\s*million|附註\s*Notes?|'
        r'^\s*\|[\s:*-]+(?:\|[\s:*-]+)*\|\s*$',
        re.IGNORECASE,
    )

    in_table = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if in_table and current_table_rows:
                tables.append(_finalize_note_table(current_table_rows))
                current_table_rows = []
                in_table = False
            continue

        if stripped.startswith('|'):
            # Skip separator and header rows
            if re.match(r'^\|[\s:*-]+(?:\|[\s:*-]+)*\|\s*$', stripped):
                in_table = True
                continue
            if _md_hdr_re.search(stripped):
                in_table = True
                continue

            result = _extract_md_table_row(stripped)
            if result is not None:
                label, numbers = result
                if numbers:
                    in_table = True
                    current_table_rows.append((label, numbers))
        else:
            # Non-table line breaks the current table
            if in_table and current_table_rows:
                tables.append(_finalize_note_table(current_table_rows))
                current_table_rows = []
                in_table = False

    # Flush last table
    if current_table_rows:
        tables.append(_finalize_note_table(current_table_rows))

    return tables


def _finalize_note_table(rows: List[Tuple[str, List[float]]]) -> Dict[str, Any]:
    """Convert raw table rows into structured note table with items and total detection.

    Identifies subtotal groups: consecutive items followed by an unlabeled or
    "Total"-labelled row.  For each such group, records the sub-items and total
    separately so internal verification can check each group independently.
    """
    if not rows:
        return {"items": [], "groups": [], "total_current": None,
                "total_prior": None, "has_total": False}

    items: List[Dict[str, Any]] = []
    # Groups: each is {sub_items: [...], total: {...}}
    groups: List[Dict[str, Any]] = []
    total_current: Optional[float] = None
    total_prior: Optional[float] = None
    total_idx: Optional[int] = None

    for i, (label, numbers) in enumerate(rows):
        current = numbers[0] if len(numbers) >= 1 else None
        prior = numbers[1] if len(numbers) >= 2 else None

        is_total = False
        if label:
            is_total = bool(_TOTAL_LABEL_RE.search(label))

        # Unlabeled row with numbers is likely a subtotal/total
        if not label.strip() and i > 0 and current is not None:
            is_total = True

        items.append({
            "label": label,
            "current": current,
            "prior": prior,
            "is_total": is_total,
        })

        if is_total:
            total_current = current
            total_prior = prior
            total_idx = i

    # If no explicit total found, check if last row looks like a summation
    if total_idx is None and len(items) >= 3:
        last = items[-1]
        if last["current"] is not None:
            preceding_sum = sum(
                it["current"] for it in items[:-1]
                if it["current"] is not None
            )
            if abs(preceding_sum - last["current"]) <= 1.0 and preceding_sum != 0:
                items[-1]["is_total"] = True
                total_current = last["current"]
                total_prior = last.get("prior")
                total_idx = len(items) - 1

    has_total = total_idx is not None

    # Build groups: scan for subtotal rows and group preceding items
    # A group ends at each "is_total" row; sub-items are the non-total items
    # between the previous total (or start) and this total.
    prev_total_idx = -1
    for i, item in enumerate(items):
        if item.get("is_total") and item["current"] is not None:
            sub_items = [
                it for it in items[prev_total_idx + 1:i]
                if it["current"] is not None and not it.get("is_total")
            ]
            if sub_items:
                groups.append({
                    "sub_items": sub_items,
                    "total": item,
                })
            prev_total_idx = i

    return {
        "items": items,
        "groups": groups,
        "total_current": total_current,
        "total_prior": total_prior,
        "has_total": has_total,
    }


def _verify_note_internal(note_num: int, note_data: Dict[str, Any],
                          tolerance: float = 1.0) -> List[Dict[str, Any]]:
    """Check if sub-items add up to the total within each group of each table.

    Uses the "groups" structure which correctly segments items by their
    subtotal/total boundaries, avoiding false failures from summing items
    across different sections of a rollforward table.

    Returns list of verification results, one per group that has sub-items + total.
    """
    results: List[Dict[str, Any]] = []

    for t_idx, table in enumerate(note_data.get("tables", [])):
        groups = table.get("groups", [])
        if not groups:
            continue

        for g_idx, group in enumerate(groups):
            sub_items = group["sub_items"]
            total_item = group["total"]
            total_current = total_item.get("current")
            total_prior = total_item.get("prior")

            if not sub_items or total_current is None:
                continue
            # Skip groups with only 1 sub-item (nothing to sum)
            if len(sub_items) < 2:
                continue

            # Sum current year
            current_sum = sum(
                it["current"] for it in sub_items
                if it["current"] is not None
            )
            prior_sum = sum(
                it["prior"] for it in sub_items
                if it["prior"] is not None
            )

            # Check current year
            current_diff = round(total_current - current_sum, 2)
            current_status = "pass" if abs(current_diff) <= tolerance else "fail"

            # Check prior year
            prior_status = "not_applicable"
            prior_diff = None
            if total_prior is not None and any(it["prior"] is not None for it in sub_items):
                prior_diff = round(total_prior - prior_sum, 2)
                prior_status = "pass" if abs(prior_diff) <= tolerance else "fail"

            results.append({
                "note": str(note_num),
                "title": note_data.get("title", ""),
                "table_index": t_idx,
                "group_index": g_idx,
                "sub_items": [
                    {"label": it["label"], "current": it["current"], "prior": it["prior"]}
                    for it in sub_items
                ],
                "computed_sum_current": round(current_sum, 2),
                "computed_sum_prior": round(prior_sum, 2),
                "reported_total_current": total_current,
                "reported_total_prior": total_prior,
                "current_diff": current_diff,
                "prior_diff": prior_diff,
                "current_status": current_status,
                "prior_status": prior_status,
            })

    return results


def _extract_stmt_note_refs(text: str) -> Dict[int, List[Dict[str, Any]]]:
    """Scan main financial statement tables for note-number column references.

    In the BS/IS, a "Notes" column contains bare numbers (e.g., "| 16 |") that
    reference footnotes.  Parse these and associate them with the line item label
    and numeric values on the same row.

    Returns: { note_number: [{label, current, prior, section}] }
    """
    # Identify statement sections first
    sections = _identify_sections(text)
    refs: Dict[int, List[Dict[str, Any]]] = {}

    for sec in sections:
        sec_id = sec["id"]
        if sec_id in _SENTINEL_SECTIONS:
            continue
        if sec_id not in ("balance_sheet", "income_statement", "comprehensive_income",
                          "cash_flow"):
            continue

        sec_text = text[sec["start"]:sec["end"]]
        for line in sec_text.split('\n'):
            stripped = line.strip()
            if not stripped.startswith('|'):
                continue
            if re.match(r'^\|[\s:*-]+(?:\|[\s:*-]+)*\|\s*$', stripped):
                continue

            cells = [c.strip() for c in stripped.split('|')]
            cells = [c for c in cells if c != '']

            # Look for a cell that is just a 1-2 digit number (note reference)
            note_num = None
            label_parts = []
            numbers = []

            for cell in cells:
                if re.match(r'^\d{1,2}$', cell):
                    candidate = int(cell)
                    if 1 <= candidate <= 40:
                        note_num = candidate
                elif cell == '-' or not cell:
                    continue
                else:
                    num_cell = re.sub(r'^(?:RMB|HK\$|US\$|人民幣)\s*', '', cell)
                    v = _to_float(num_cell)
                    if v is not None:
                        numbers.append(v)
                    elif not re.match(
                        r'^(?:附註|Notes?|RMB\s*million|HK\$|人民幣百萬元|二零\S*|'
                        r'\d{4}\s*$)',
                        cell, re.IGNORECASE
                    ):
                        label_parts.append(cell)

            if note_num is not None and numbers:
                label = ' '.join(label_parts).strip()
                refs.setdefault(note_num, []).append({
                    "label": label,
                    "current": numbers[0] if len(numbers) >= 1 else None,
                    "prior": numbers[1] if len(numbers) >= 2 else None,
                    "section": sec_id,
                })

    return refs


def _match_notes_to_statements(
    notes: Dict[int, Dict[str, Any]],
    casting_sheet: List[Dict[str, Any]],
    tolerance: float = 1.0,
    text: str = "",
) -> List[Dict[str, Any]]:
    """Match note totals to corresponding main statement line items.

    Uses three strategies (in priority order):
    1. Note-number column: BS/IS rows with a note-reference column (e.g., "| 16 |")
    2. Explicit "(Note XX)" in labels
    3. Label similarity: fuzzy match note title to statement line labels
    """
    results: List[Dict[str, Any]] = []

    # Strategy 1: Parse note-number columns from raw text
    stmt_note_refs = _extract_stmt_note_refs(text) if text else {}

    # Strategy 2: Build map from casting_sheet labels containing "Note XX"
    stmt_items_by_note: Dict[int, List[Dict[str, Any]]] = {}
    stmt_items_by_label: List[Dict[str, Any]] = []

    for item in casting_sheet:
        section = item.get("source", "")
        if section not in ("balance_sheet", "income_statement", "comprehensive_income",
                           "cash_flow"):
            continue
        stmt_items_by_label.append(item)

        label = item.get("label", "")
        for m in re.finditer(r'Note\s*(\d{1,2})', label, re.IGNORECASE):
            ref_num = int(m.group(1))
            stmt_items_by_note.setdefault(ref_num, []).append(item)

    for note_num, note_data in notes.items():
        # Skip policy notes (1-5) that typically have no numeric tables
        if note_num <= 5:
            continue

        # Get the best total from the note's tables.
        # Prefer the table with the largest absolute total (likely the main summary).
        best_total_current = None
        best_total_prior = None
        best_abs = -1
        for table in note_data.get("tables", []):
            if table.get("has_total") and table["total_current"] is not None:
                abs_val = abs(table["total_current"])
                if abs_val > best_abs:
                    best_abs = abs_val
                    best_total_current = table["total_current"]
                    best_total_prior = table["total_prior"]

        if best_total_current is None:
            continue

        # Strategy 1: Note-number column reference from raw text
        matched = False
        if note_num in stmt_note_refs:
            ref_items = stmt_note_refs[note_num]

            # Try individual match first (single line)
            single_match = None
            for ref_item in ref_items:
                stmt_val = ref_item.get("current")
                if stmt_val is None:
                    continue
                diff_abs = abs(abs(best_total_current) - abs(stmt_val))
                if diff_abs <= tolerance:
                    single_match = ref_item
                    break

            if single_match is not None:
                stmt_val = single_match["current"]
                diff_abs = abs(abs(best_total_current) - abs(stmt_val))
                results.append({
                    "note": str(note_num),
                    "title": note_data["title"],
                    "note_total_current": best_total_current,
                    "note_total_prior": best_total_prior,
                    "statement": single_match.get("section", ""),
                    "statement_line": single_match.get("label", ""),
                    "statement_value": stmt_val,
                    "difference": round(diff_abs, 2),
                    "status": "pass",
                    "match_method": "note_column",
                })
                matched = True
            elif len(ref_items) >= 2:
                # Multiple lines reference same note (e.g., current + non-current
                # portions of same item, or short-term + long-term loans)
                # Sum absolute values of all referenced lines
                stmt_sum = sum(abs(r.get("current", 0) or 0) for r in ref_items)
                labels = [r.get("label", "") for r in ref_items]
                diff_abs = abs(abs(best_total_current) - stmt_sum)
                status = "pass" if diff_abs <= tolerance else "fail"
                results.append({
                    "note": str(note_num),
                    "title": note_data["title"],
                    "note_total_current": best_total_current,
                    "note_total_prior": best_total_prior,
                    "statement": ref_items[0].get("section", ""),
                    "statement_line": " + ".join(labels),
                    "statement_value": stmt_sum,
                    "difference": round(diff_abs, 2),
                    "status": status,
                    "match_method": "note_column_sum",
                })
                matched = True
            else:
                # Single line but doesn't match — still report
                ref_item = ref_items[0]
                stmt_val = ref_item.get("current")
                if stmt_val is not None:
                    diff_abs = abs(abs(best_total_current) - abs(stmt_val))
                    # Also try: note has multiple tables, pick the one that matches
                    best_match_total = best_total_current
                    for table in note_data.get("tables", []):
                        if table.get("has_total") and table["total_current"] is not None:
                            alt_diff = abs(abs(table["total_current"]) - abs(stmt_val))
                            if alt_diff < diff_abs:
                                diff_abs = alt_diff
                                best_match_total = table["total_current"]
                    status = "pass" if diff_abs <= tolerance else "fail"
                    results.append({
                        "note": str(note_num),
                        "title": note_data["title"],
                        "note_total_current": best_match_total,
                        "note_total_prior": best_total_prior,
                        "statement": ref_item.get("section", ""),
                        "statement_line": ref_item.get("label", ""),
                        "statement_value": stmt_val,
                        "difference": round(diff_abs, 2),
                        "status": status,
                        "match_method": "note_column",
                    })
                    matched = True

        if matched:
            continue

        # Strategy 2: Explicit "(Note XX)" in casting_sheet labels
        if note_num in stmt_items_by_note:
            for stmt_item in stmt_items_by_note[note_num]:
                stmt_val = stmt_item.get("current_year")
                if stmt_val is None:
                    continue
                diff_abs = abs(abs(best_total_current) - abs(stmt_val))
                status = "pass" if diff_abs <= tolerance else "fail"
                results.append({
                    "note": str(note_num),
                    "title": note_data["title"],
                    "note_total_current": best_total_current,
                    "note_total_prior": best_total_prior,
                    "statement": stmt_item.get("source", ""),
                    "statement_line": stmt_item.get("label", ""),
                    "statement_value": stmt_val,
                    "difference": round(diff_abs, 2),
                    "status": status,
                    "match_method": "note_reference",
                })
                matched = True
                break

        if matched:
            continue

        # Strategy 3: Label similarity matching (higher threshold to avoid false matches)
        note_title_lower = note_data["title"].lower().strip()
        note_title_clean = re.sub(r'\s*\(continued\).*', '', note_title_lower).strip()

        best_match = None
        best_score = 0.0
        for stmt_item in stmt_items_by_label:
            stmt_label = stmt_item.get("label", "").lower()
            score = SequenceMatcher(None, note_title_clean, stmt_label).ratio()
            if note_title_clean in stmt_label or stmt_label in note_title_clean:
                score = max(score, 0.85)
            if score > best_score and score >= 0.65:  # raised threshold
                best_score = score
                best_match = stmt_item

        if best_match is not None:
            stmt_val = best_match.get("current_year")
            if stmt_val is not None:
                diff_abs = abs(abs(best_total_current) - abs(stmt_val))
                status = "pass" if diff_abs <= tolerance else "fail"
                results.append({
                    "note": str(note_num),
                    "title": note_data["title"],
                    "note_total_current": best_total_current,
                    "note_total_prior": best_total_prior,
                    "statement": best_match.get("source", ""),
                    "statement_line": best_match.get("label", ""),
                    "statement_value": stmt_val,
                    "difference": round(diff_abs, 2),
                    "status": status,
                    "match_method": "label_similarity",
                    "match_score": round(best_score, 3),
                })

    return results


def _verify_cross_note_references(
    notes: Dict[int, Dict[str, Any]],
    tolerance: float = 1.0,
) -> List[Dict[str, Any]]:
    """Check cross-note references: when Note X mentions a number from Note Y,
    verify they are consistent."""
    results: List[Dict[str, Any]] = []

    # Build a map of note_num -> primary totals for quick lookup
    note_totals: Dict[int, Tuple[Optional[float], Optional[float]]] = {}
    for num, data in notes.items():
        for table in data.get("tables", []):
            if table.get("has_total"):
                note_totals[num] = (table["total_current"], table["total_prior"])
                break

    for note_num, note_data in notes.items():
        note_text = note_data.get("text", "")
        # Find references to other notes
        for m in _CROSS_NOTE_REF_RE.finditer(note_text):
            ref_num = None
            if m.group(1):
                ref_num = int(m.group(1))
            elif m.group(2):
                ref_num = _CN_NUM_MAP.get(m.group(2))

            if ref_num is None or ref_num == note_num:
                continue
            if ref_num not in note_totals:
                continue

            # Check if there's a specific number near this reference that
            # should match the referenced note's total
            # Look for numbers within ~80 chars of the reference
            context_start = max(0, m.start() - 80)
            context_end = min(len(note_text), m.end() + 80)
            context = note_text[context_start:context_end]

            # Extract numbers from context
            context_nums = []
            for nm in re.finditer(r'[\(（]?\d{1,3}(?:,\d{3})+[\)）]?|\d{4,}', context):
                v = _to_float(nm.group())
                if v is not None and abs(v) > 1:  # skip small reference numbers
                    context_nums.append(v)

            ref_current, ref_prior = note_totals[ref_num]
            if ref_current is None:
                continue

            # Check if any number in context matches the referenced note total
            for cv in context_nums:
                if abs(abs(cv) - abs(ref_current)) <= tolerance:
                    results.append({
                        "source_note": str(note_num),
                        "referenced_note": str(ref_num),
                        "referenced_title": notes[ref_num]["title"],
                        "value_in_source": cv,
                        "value_in_target": ref_current,
                        "status": "pass",
                    })
                    break

    return results


def _verify_prior_year_consistency(
    notes: Dict[int, Dict[str, Any]],
    tolerance: float = 1.0,
) -> List[Dict[str, Any]]:
    """For rollforward tables, check current year opening == prior year closing."""
    results: List[Dict[str, Any]] = []

    # Patterns for opening/closing balance labels
    _opening_re = re.compile(
        r'At\s*1\s*January\s*2025|於二零二五年一月一日|'
        r'As\s*at\s*1\s*January\s*2025',
        re.IGNORECASE
    )
    _closing_prior_re = re.compile(
        r'At\s*31\s*December\s*2024|於二零二四年十二月三十一日|'
        r'As\s*at\s*31\s*December\s*2024',
        re.IGNORECASE
    )

    for note_num, note_data in notes.items():
        for t_idx, table in enumerate(note_data.get("tables", [])):
            opening_vals: List[Tuple[str, float]] = []
            closing_prior_vals: List[Tuple[str, float]] = []

            for item in table.get("items", []):
                label = item.get("label", "")
                current = item.get("current")
                if current is None:
                    continue

                if _opening_re.search(label):
                    opening_vals.append((label, current))
                if _closing_prior_re.search(label):
                    closing_prior_vals.append((label, current))

            # If we found both opening 2025 and closing 2024 in the same table,
            # they should match
            for (o_label, o_val), (c_label, c_val) in zip(opening_vals, closing_prior_vals):
                diff = abs(o_val - c_val)
                status = "pass" if diff <= tolerance else "fail"
                results.append({
                    "note": str(note_num),
                    "title": note_data["title"],
                    "table_index": t_idx,
                    "opening_label": o_label,
                    "opening_value": o_val,
                    "closing_prior_label": c_label,
                    "closing_prior_value": c_val,
                    "difference": round(diff, 2),
                    "status": status,
                })

    return results


def verify_notes(
    text: str,
    casting_sheet: List[Dict[str, Any]],
    tolerance: float = 1.0,
) -> Dict[str, Any]:
    """Run comprehensive notes verification.

    Returns {
        notes_verification: [...],      # internal addition checks
        notes_statement_matches: [...], # note <-> main statement tie-outs
        notes_cross_references: [...],  # cross-note reference checks
        notes_prior_year: [...],        # opening == prior closing checks
        notes_stats: {...},             # summary statistics
    }
    """
    notes = _extract_notes(text)

    if not notes:
        return {
            "notes_verification": [],
            "notes_statement_matches": [],
            "notes_cross_references": [],
            "notes_prior_year": [],
            "notes_stats": {
                "total_notes_found": 0,
                "notes_with_tables": 0,
                "internal_checks": 0,
                "internal_pass": 0,
                "internal_fail": 0,
                "statement_match_total": 0,
                "statement_match_pass": 0,
                "statement_match_fail": 0,
                "cross_ref_total": 0,
                "cross_ref_pass": 0,
                "prior_year_total": 0,
                "prior_year_pass": 0,
                "prior_year_fail": 0,
            },
        }

    # 1. Internal addition checks
    all_internal: List[Dict[str, Any]] = []
    for note_num, note_data in sorted(notes.items()):
        checks = _verify_note_internal(note_num, note_data, tolerance)
        all_internal.extend(checks)

    # 2. Statement tie-out
    stmt_matches = _match_notes_to_statements(notes, casting_sheet, tolerance, text=text)

    # 3. Cross-note references
    cross_refs = _verify_cross_note_references(notes, tolerance)

    # 4. Prior year consistency
    prior_year = _verify_prior_year_consistency(notes, tolerance)

    # Stats
    notes_with_tables = sum(1 for n in notes.values() if n.get("tables"))
    int_pass = sum(1 for c in all_internal if c["current_status"] == "pass")
    int_fail = sum(1 for c in all_internal if c["current_status"] == "fail")
    stmt_pass = sum(1 for m in stmt_matches if m["status"] == "pass")
    stmt_fail = sum(1 for m in stmt_matches if m["status"] == "fail")
    cr_pass = sum(1 for r in cross_refs if r["status"] == "pass")
    py_pass = sum(1 for r in prior_year if r["status"] == "pass")
    py_fail = sum(1 for r in prior_year if r["status"] == "fail")

    return {
        "notes_verification": all_internal,
        "notes_statement_matches": stmt_matches,
        "notes_cross_references": cross_refs,
        "notes_prior_year": prior_year,
        "notes_stats": {
            "total_notes_found": len(notes),
            "notes_with_tables": notes_with_tables,
            "internal_checks": len(all_internal),
            "internal_pass": int_pass,
            "internal_fail": int_fail,
            "statement_match_total": len(stmt_matches),
            "statement_match_pass": stmt_pass,
            "statement_match_fail": stmt_fail,
            "cross_ref_total": len(cross_refs),
            "cross_ref_pass": cr_pass,
            "prior_year_total": len(prior_year),
            "prior_year_pass": py_pass,
            "prior_year_fail": py_fail,
        },
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

    # ── Legacy checks array (backward compatible) ──
    checks = [
        _check(
            "inventory_tie",
            "inventory_bs = inventory_raw + inventory_finished",
            {"inventory_bs": fields.get("inventory_bs"), "inventory_raw": fields.get("inventory_raw"), "inventory_finished": fields.get("inventory_finished")},
            fields.get("inventory_bs"),
            (fields.get("inventory_raw") or 0) + (fields.get("inventory_finished") or 0) if fields.get("inventory_raw") is not None and fields.get("inventory_finished") is not None else None,
        ),
        _check(
            "ar_tie",
            "ar_bs = ar_0_30 + ar_31_60 + ar_60_plus",
            {"ar_bs": fields.get("ar_bs"), "ar_0_30": fields.get("ar_0_30"), "ar_31_60": fields.get("ar_31_60"), "ar_60_plus": fields.get("ar_60_plus")},
            fields.get("ar_bs"),
            (fields.get("ar_0_30") or 0) + (fields.get("ar_31_60") or 0) + (fields.get("ar_60_plus") or 0) if None not in (fields.get("ar_0_30"), fields.get("ar_31_60"), fields.get("ar_60_plus")) else None,
        ),
        _check(
            "loan_tie",
            "loan_current + loan_non_current = loan_lt_1y + loan_1_2y + loan_gt_2y",
            {
                "loan_current": fields.get("loan_current"),
                "loan_non_current": fields.get("loan_non_current"),
                "loan_lt_1y": fields.get("loan_lt_1y"),
                "loan_1_2y": fields.get("loan_1_2y"),
                "loan_gt_2y": fields.get("loan_gt_2y"),
            },
            (fields.get("loan_current") or 0) + (fields.get("loan_non_current") or 0) if None not in (fields.get("loan_current"), fields.get("loan_non_current")) else None,
            (fields.get("loan_lt_1y") or 0) + (fields.get("loan_1_2y") or 0) + (fields.get("loan_gt_2y") or 0) if None not in (fields.get("loan_lt_1y"), fields.get("loan_1_2y"), fields.get("loan_gt_2y")) else None,
        ),
        _check(
            "ppe_rollforward",
            "ppe_close = ppe_open + ppe_add - ppe_disp - ppe_dep",
            {"ppe_open": fields.get("ppe_open"), "ppe_add": fields.get("ppe_add"), "ppe_disp": fields.get("ppe_disp"), "ppe_dep": fields.get("ppe_dep"), "ppe_close": fields.get("ppe_close")},
            fields.get("ppe_close"),
            (fields.get("ppe_open") or 0) + (fields.get("ppe_add") or 0) - (fields.get("ppe_disp") or 0) - (fields.get("ppe_dep") or 0) if None not in (fields.get("ppe_open"), fields.get("ppe_add"), fields.get("ppe_disp"), fields.get("ppe_dep")) else None,
        ),
        _check(
            "gross_profit_bridge",
            "gross_profit = revenue - cogs",
            {"revenue": fields.get("revenue"), "cogs": fields.get("cogs"), "gross_profit": fields.get("gross_profit")},
            fields.get("gross_profit"),
            (fields.get("revenue") or 0) - abs(fields.get("cogs") or 0) if None not in (fields.get("revenue"), fields.get("cogs")) else None,
        ),
        _check(
            "cash_bridge",
            "cash_close = cash_open + cfo + cfi + cff + fx_effect",
            {"cash_open": fields.get("cash_open"), "cfo": fields.get("cfo"), "cfi": fields.get("cfi"), "cff": fields.get("cff"), "cash_close": fields.get("cash_close")},
            fields.get("cash_close"),
            (fields.get("cash_open") or 0) + (fields.get("cfo") or 0) + (fields.get("cfi") or 0) + (fields.get("cff") or 0) + (fields.get("fx_effect") or 0) if None not in (fields.get("cash_open"), fields.get("cfo"), fields.get("cfi"), fields.get("cff")) else None,
        ),
        _check(
            "retained_earnings_bridge",
            "re_close = re_open + re_profit - re_div",
            {"re_open": fields.get("re_open"), "re_profit": fields.get("re_profit"), "re_div": fields.get("re_div"), "re_close": fields.get("re_close")},
            fields.get("re_close"),
            (fields.get("re_open") or 0) + (fields.get("re_profit") or 0) - (fields.get("re_div") or 0) if None not in (fields.get("re_open"), fields.get("re_profit"), fields.get("re_div")) else None,
        ),
        _check(
            "balance_sheet_equation",
            "total_assets = total_liabilities + total_equity",
            {
                "total_assets": fields.get("total_assets"),
                "total_liabilities": fields.get("total_liabilities"),
                "total_equity": fields.get("total_equity"),
            },
            fields.get("total_assets"),
            (fields.get("total_liabilities") or 0) + (fields.get("total_equity") or 0) if None not in (fields.get("total_liabilities"), fields.get("total_equity")) else None,
        ),
    ]

    # ── New: Programmatic cross-checks with detail breakdown ──
    cross_checks = _build_cross_checks(fields)

    # ── Full Casting (铸表): parse ALL line items, verify every total ──
    casting_result = cast_financial_statements(merged)

    # ── Notes Verification (附注验证): parse all footnotes, verify sums ──
    notes_result = verify_notes(merged, casting_result.get("casting_sheet", []))

    missing_fields = sorted({m for c in checks for m in c.get("missing_fields", [])})
    pass_count = len([c for c in checks if c.get("status") == "tie"])
    fail_count = len([c for c in checks if c.get("status") == "not_tie"])
    insufficient_count = len([c for c in checks if c.get("status") == "insufficient"])

    # Cross-check stats
    xc_pass = len([c for c in cross_checks if c.get("status") == "pass"])
    xc_fail = len([c for c in cross_checks if c.get("status") == "fail"])
    xc_insufficient = len([c for c in cross_checks if c.get("status") == "insufficient"])

    cast_stats = casting_result.get("stats", {})
    meta = {
        "query": query,
        "documents_count": len(text_chunks),
        "pass_count": pass_count,
        "fail_count": fail_count,
        "insufficient_count": insufficient_count,
        "cross_check_pass": xc_pass,
        "cross_check_fail": xc_fail,
        "cross_check_insufficient": xc_insufficient,
        "casting_line_items": cast_stats.get("total_line_items", 0),
        "casting_sections": cast_stats.get("sections_found", 0),
        "casting_addition_pass": cast_stats.get("addition_pass", 0),
        "casting_addition_fail": cast_stats.get("addition_fail", 0),
        "casting_cross_stmt_pass": cast_stats.get("cross_statement_pass", 0),
        "casting_cross_stmt_fail": cast_stats.get("cross_statement_fail", 0),
        "docling_available": _DOCLING_AVAILABLE,
        "docling_used": docling_used,
        "notes_found": notes_result.get("notes_stats", {}).get("total_notes_found", 0),
        "notes_internal_pass": notes_result.get("notes_stats", {}).get("internal_pass", 0),
        "notes_internal_fail": notes_result.get("notes_stats", {}).get("internal_fail", 0),
        "notes_stmt_match_pass": notes_result.get("notes_stats", {}).get("statement_match_pass", 0),
        "notes_stmt_match_fail": notes_result.get("notes_stats", {}).get("statement_match_fail", 0),
    }
    meta.update(_validate_with_pandera(checks))

    if not text_chunks and not pdf_paths:
        summary = "No attachment text available for financial checks."
    else:
        summary = f"Financial checks completed: tie={pass_count}, not_tie={fail_count}, insufficient={insufficient_count}."
        summary += f" Cross-checks: pass={xc_pass}, fail={xc_fail}, insufficient={xc_insufficient}."
        summary += f" Full casting: {cast_stats.get('total_line_items', 0)} line items across {cast_stats.get('sections_found', 0)} sections,"
        summary += f" addition checks pass={cast_stats.get('addition_pass', 0)} fail={cast_stats.get('addition_fail', 0)},"
        summary += f" cross-statement matches={cast_stats.get('cross_statement_total', 0)} (pass={cast_stats.get('cross_statement_pass', 0)}, fail={cast_stats.get('cross_statement_fail', 0)})."
        ns = notes_result.get("notes_stats", {})
        if ns.get("total_notes_found", 0) > 0:
            summary += f" Notes verification: {ns.get('total_notes_found', 0)} notes found,"
            summary += f" internal checks pass={ns.get('internal_pass', 0)} fail={ns.get('internal_fail', 0)},"
            summary += f" statement matches pass={ns.get('statement_match_pass', 0)} fail={ns.get('statement_match_fail', 0)},"
            summary += f" cross-refs={ns.get('cross_ref_total', 0)}, prior-year checks pass={ns.get('prior_year_pass', 0)} fail={ns.get('prior_year_fail', 0)}."
        if docling_used:
            summary += " (docling structured extraction used)"

    out = {
        "ok": True,
        "summary": summary,
        "checks": checks,
        "cross_checks": cross_checks,
        "casting_sheet": casting_result.get("casting_sheet", []),
        "casting_cross_statement": casting_result.get("cross_statement_matches", []),
        "casting_section_summaries": casting_result.get("section_summaries", {}),
        "casting_stats": cast_stats,
        "notes_verification": notes_result.get("notes_verification", []),
        "notes_statement_matches": notes_result.get("notes_statement_matches", []),
        "notes_cross_references": notes_result.get("notes_cross_references", []),
        "notes_prior_year": notes_result.get("notes_prior_year", []),
        "notes_stats": notes_result.get("notes_stats", {}),
        "extracted_fields": {k: v for k, v in fields.items() if v is not None},
        "missing_fields": missing_fields,
        "evidence": evidence[:20],
        "meta": meta,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
