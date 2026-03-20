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
            rf"(?:0[\-\u2013]30|0\s*to\s*30)\s*days?{sep}{num}",
            rf"(?:0[\-\u2013]30|0\s*to\s*30)\s*days?\s*\n\s*{num}",
        ],
        "ar_31_60": [
            rf"(?:31[\-\u2013]60|31\s*to\s*60)\s*days?{sep}{num}",
            rf"(?:31[\-\u2013]60|31\s*to\s*60)\s*days?\s*\n\s*{num}",
        ],
        "ar_61_90": [
            rf"(?:61[\-\u2013]90|61\s*to\s*90)\s*days?{sep}{num}",
            rf"(?:61[\-\u2013]90|61\s*to\s*90)\s*days?\s*\n\s*{num}",
        ],
        "ar_91_180": [
            rf"(?:91[\-\u2013]180|91\s*to\s*180)\s*days?{sep}{num}",
            rf"(?:91[\-\u2013]180|91\s*to\s*180)\s*days?\s*\n\s*{num}",
        ],
        "ar_over_180": [
            rf"(?:over\s*180|180\+|>180|181[\-\u2013]365)\s*days?{sep}{num}",
            rf"(?:over\s*180|180\+|>180|181[\-\u2013]365)\s*days?\s*\n\s*{num}",
        ],
        "ar_60_plus": [
            rf"(?:over\s*60|60\+|61[\-\u2013]90|>60)\s*days?{sep}{num}",
            rf"(?:over\s*60|60\+|61[\-\u2013]90|>60)\s*days?\s*\n\s*{num}",
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
                r"|物業、?廠房及設備|物业、?厂房及设备)"
            ),
        ],
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
            rf"(?:buildings?|房屋|楼宇|樓宇|房屋建筑物|房屋建築物)[^.\n]*(?:opening|期初|年初|at\s*1\s*January)[^0-9\-()]*{num}",
            rf"(?:opening|期初|年初|at\s*1\s*January)[^.\n]*(?:buildings?|房屋|楼宇|樓宇)[^0-9\-()]*{num}",
        ],
        "ppe_buildings_add": [
            rf"(?:buildings?|房屋|楼宇|樓宇)[^.\n]*(?:additions?|增加|添置)[^0-9\-()]*{num}",
        ],
        "ppe_buildings_disp": [
            rf"(?:buildings?|房屋|楼宇|樓宇)[^.\n]*(?:disposals?|处置|處置|减少|減少)[^0-9\-()]*{num}",
        ],
        "ppe_buildings_dep": [
            rf"(?:buildings?|房屋|楼宇|樓宇)[^.\n]*(?:depreciation|折旧|折舊|charge)[^0-9\-()]*{num}",
        ],
        "ppe_buildings_close": [
            rf"(?:buildings?|房屋|楼宇|樓宇)[^.\n]*(?:closing|期末|年末|at\s*31\s*December)[^0-9\-()]*{num}",
        ],

        "ppe_plant_cost": [
            *lbl(r"plant\s*(?:and|&)\s*machinery|机器设备|機器設備|机械设备|機械設備|厂房及机器|廠房及機器"),
        ],
        "ppe_plant_open": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^.\n]*(?:opening|期初|年初|at\s*1\s*January)[^0-9\-()]*{num}",
        ],
        "ppe_plant_add": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^.\n]*(?:additions?|增加|添置)[^0-9\-()]*{num}",
        ],
        "ppe_plant_disp": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^.\n]*(?:disposals?|处置|處置|减少|減少)[^0-9\-()]*{num}",
        ],
        "ppe_plant_dep": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^.\n]*(?:depreciation|折旧|折舊|charge)[^0-9\-()]*{num}",
        ],
        "ppe_plant_close": [
            rf"(?:plant\s*(?:and|&)\s*machinery|机器设备|機器設備|厂房及机器|廠房及機器)[^.\n]*(?:closing|期末|年末|at\s*31\s*December)[^0-9\-()]*{num}",
        ],

        "ppe_vehicles_cost": [
            *lbl(r"(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車|运输设备|運輸設備"),
        ],
        "ppe_vehicles_open": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^.\n]*(?:opening|期初|年初|at\s*1\s*January)[^0-9\-()]*{num}",
        ],
        "ppe_vehicles_add": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^.\n]*(?:additions?|增加|添置)[^0-9\-()]*{num}",
        ],
        "ppe_vehicles_disp": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^.\n]*(?:disposals?|处置|處置|减少|減少)[^0-9\-()]*{num}",
        ],
        "ppe_vehicles_dep": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^.\n]*(?:depreciation|折旧|折舊|charge)[^0-9\-()]*{num}",
        ],
        "ppe_vehicles_close": [
            rf"(?:(?:motor\s*)?vehicles?|运输工具|運輸工具|汽车|汽車)[^.\n]*(?:closing|期末|年末|at\s*31\s*December)[^0-9\-()]*{num}",
        ],

        "ppe_office_cost": [
            *lbl(r"(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|办公家具|辦公家具|电子设备|電子設備|家具及装置|傢具及裝置"),
        ],
        "ppe_office_open": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^.\n]*(?:opening|期初|年初|at\s*1\s*January)[^0-9\-()]*{num}",
        ],
        "ppe_office_add": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^.\n]*(?:additions?|增加|添置)[^0-9\-()]*{num}",
        ],
        "ppe_office_disp": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^.\n]*(?:disposals?|处置|處置|减少|減少)[^0-9\-()]*{num}",
        ],
        "ppe_office_dep": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^.\n]*(?:depreciation|折旧|折舊|charge)[^0-9\-()]*{num}",
        ],
        "ppe_office_close": [
            rf"(?:(?:office\s*)?(?:equipment|furniture)|办公设备|辦公設備|家具及装置|傢具及裝置)[^.\n]*(?:closing|期末|年末|at\s*31\s*December)[^0-9\-()]*{num}",
        ],

        "ppe_land_cost": [
            *lbl(r"land|土地|土地使用权|土地使用權"),
        ],
        "ppe_land_open": [
            rf"(?:land|土地|土地使用权|土地使用權)[^.\n]*(?:opening|期初|年初|at\s*1\s*January)[^0-9\-()]*{num}",
        ],
        "ppe_land_close": [
            rf"(?:land|土地|土地使用权|土地使用權)[^.\n]*(?:closing|期末|年末|at\s*31\s*December)[^0-9\-()]*{num}",
        ],

        "ppe_leasehold_cost": [
            *lbl(r"leasehold\s*improvements?|租赁改良|租賃改良|装修|裝修|leasehold"),
        ],
        "ppe_leasehold_dep": [
            rf"(?:leasehold\s*improvements?|租赁改良|租賃改良|装修|裝修)[^.\n]*(?:depreciation|折旧|折舊|charge)[^0-9\-()]*{num}",
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
            rf"(?:profit\s*attributable\s*to\s*(?:shareholders|owners|equity\s*holders)|本公司股東應佔溢利|本公司股东应占溢利)[^0-9\n]*{sep}{num}",
            rf"(?:profit\s*attributable\s*to\s*(?:shareholders|owners|equity\s*holders)|本公司股東應佔溢利|本公司股东应占溢利)[^0-9\n]*\s*\n\s*{num}",
            *lbl(
                r"net\s*(?:income|profit|loss)\s*(?:for\s*the\s*(?:year|period))?"
                r"|(?:total\s*)?profit\s*for\s*the\s*(?:year|period)"
                r"|净利润|淨利潤|纯利|純利|本年度溢利|(?:税后|稅後)(?:净|淨)?(?:利润|利潤)"
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
            *lbl(
                r"(?:opening|beginning)\s*(?:balance\s*of\s*)?cash"
                r"|cash[^.\n]*(?:at\s*)?(?:beginning|opening)"
                r"|cash[^.\n]*(?:as\s*at\s*)?(?:1\s*January|January\s*1)"
                r"|期初现金|期初現金|年初现金|年初現金"
                r"|於一月一日之現金|于一月一日之现金"
            ),
        ],
        "cash_close": [
            *lbl(
                r"(?:closing|ending)\s*(?:balance\s*of\s*)?cash"
                r"|cash[^.\n]*(?:at\s*)?(?:end|closing)"
                r"|cash[^.\n]*(?:as\s*at\s*)?(?:31\s*December|December\s*31)"
                r"|期末现金|期末現金|年末现金|年末現金"
                r"|於十二月三十一日之現金|于十二月三十一日之现金"
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
            rf"(?:retained\s*(?:earnings?|profits?)|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)\s*(?:opening|期初|年初)(?:\s*\([^)]*\))?\s*{num}",
            rf"(?:retained\s*(?:earnings?|profits?))\s*(?:as\s*at\s*)?1\s*January(?:\s*\d{{4}})?\s*{num}",
        ],
        "re_profit": [
            rf"(?:retained\s*(?:earnings?|profits?)|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^.\n]*(?:profit|net\s*income|净利润|淨利潤|溢利)[^0-9\-()]*{num}",
        ],
        "re_div": [
            rf"(?:retained\s*(?:earnings?|profits?)|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)[^.\n]*(?:dividends?|股息|股利|分红|分紅)[^0-9\-()]*{num}",
            *lbl(r"dividends?\s*(?:declared|paid|proposed)|已宣派股息|已派发股息|已派發股息|分红|分紅|股利分配"),
        ],
        "re_close": [
            rf"(?:retained\s*(?:earnings?|profits?)|留存收益|保留盈利|保留溢利|未分配利润|未分配利潤)\s*(?:closing|期末|年末)(?:\s*\([^)]*\))?\s*{num}",
            rf"(?:retained\s*(?:earnings?|profits?))\s*(?:as\s*at\s*)?31\s*December(?:\s*\d{{4}})?\s*{num}",
        ],
        "dividends_declared": [
            *lbl(
                r"dividends?\s*(?:declared|paid|proposed)"
                r"|已宣派股息|已派发股息|已派發股息|分红|分紅|股利分配"
            ),
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
                r"total\s*(?:shareholders?['\u2019']?\s*)?equity|equity\s*attributable"
                r"|权益总额|權益總額|权益合计|權益合計|股东权益合计|股東權益合計"
                r"|所有者权益|所有者權益"
            ),
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

    missing_fields = sorted({m for c in checks for m in c.get("missing_fields", [])})
    pass_count = len([c for c in checks if c.get("status") == "tie"])
    fail_count = len([c for c in checks if c.get("status") == "not_tie"])
    insufficient_count = len([c for c in checks if c.get("status") == "insufficient"])

    # Cross-check stats
    xc_pass = len([c for c in cross_checks if c.get("status") == "pass"])
    xc_fail = len([c for c in cross_checks if c.get("status") == "fail"])
    xc_insufficient = len([c for c in cross_checks if c.get("status") == "insufficient"])

    meta = {
        "query": query,
        "documents_count": len(text_chunks),
        "pass_count": pass_count,
        "fail_count": fail_count,
        "insufficient_count": insufficient_count,
        "cross_check_pass": xc_pass,
        "cross_check_fail": xc_fail,
        "cross_check_insufficient": xc_insufficient,
        "docling_available": _DOCLING_AVAILABLE,
        "docling_used": docling_used,
    }
    meta.update(_validate_with_pandera(checks))

    if not text_chunks and not pdf_paths:
        summary = "No attachment text available for financial checks."
    else:
        summary = f"Financial checks completed: tie={pass_count}, not_tie={fail_count}, insufficient={insufficient_count}."
        summary += f" Cross-checks: pass={xc_pass}, fail={xc_fail}, insufficient={xc_insufficient}."
        if docling_used:
            summary += " (docling structured extraction used)"

    out = {
        "ok": True,
        "summary": summary,
        "checks": checks,
        "cross_checks": cross_checks,
        "extracted_fields": {k: v for k, v in fields.items() if v is not None},
        "missing_fields": missing_fields,
        "evidence": evidence[:20],
        "meta": meta,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
