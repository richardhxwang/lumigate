/**
 * doc-gen/server.js — Document generation microservice for LumiGate.
 *
 * Full-featured document generation with formulas, formatting, charts, and conversion.
 *
 * POST /generate/docx       — Word document (rich formatting, tables, headers/footers)
 * POST /generate/pptx       — PowerPoint (layouts, charts, speaker notes)
 * POST /generate/xlsx       — Excel (formulas, conditional formatting, merged cells, charts)
 * POST /convert/xlsx-to-pptx — Convert Excel data into a presentation
 * POST /convert/xlsx-to-docx — Convert Excel data into a Word report
 * GET  /health              — Health check
 * GET  /tools               — Tool schemas for LumiGate registry
 */

const http = require("http");

// ── Excel Generation (full-featured) ────────────────────────────────────────

async function generateXlsx(spec) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = spec.author || "LumiGate";
  wb.created = new Date();

  for (const ss of spec.sheets || [{ name: "Sheet1", headers: spec.headers, data: spec.data }]) {
    const ws = wb.addWorksheet(ss.name || "Sheet1", {
      properties: { defaultColWidth: 15 },
      pageSetup: ss.landscape ? { orientation: "landscape" } : undefined,
    });

    // Freeze panes
    if (ss.freezeRow || ss.freezeCol) {
      ws.views = [{ state: "frozen", xSplit: ss.freezeCol || 0, ySplit: ss.freezeRow || 0 }];
    }

    // Merged cells
    for (const merge of ss.merges || []) {
      ws.mergeCells(merge); // e.g. "A1:C1"
    }

    // Headers
    if (ss.headers) {
      const hr = ws.addRow(ss.headers);
      hr.font = { bold: true, size: 11 };
      hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ss.headerColor || "FF4472C4" } };
      hr.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      hr.alignment = { vertical: "middle", horizontal: "center" };
      hr.height = 25;
      hr.eachCell((cell) => {
        cell.border = {
          top: { style: "thin" }, bottom: { style: "medium" },
          left: { style: "thin" }, right: { style: "thin" },
        };
      });
      if (!ss.freezeRow) ws.views = [{ state: "frozen", ySplit: 1 }];
    }

    // Data rows — support formulas, formatting per cell
    // Accept both "data" and "rows" field names (AI models may use either)
    const dataRows = ss.data || ss.rows || [];
    for (let ri = 0; ri < dataRows.length; ri++) {
      const rowData = dataRows[ri];
      const cells = Array.isArray(rowData) ? rowData : Object.values(rowData);
      const row = ws.addRow([]);

      for (let ci = 0; ci < cells.length; ci++) {
        const cell = row.getCell(ci + 1);
        const val = cells[ci];

        if (val && typeof val === "object" && !Array.isArray(val)) {
          // Rich cell: { value: 100, formula: "=A1+B1", format: "currency", bold: true, color: "FF0000", bg: "FFFF00" }
          if (val.formula) {
            cell.value = { formula: val.formula, result: val.result };
          } else {
            cell.value = val.value ?? val.v ?? "";
          }
          if (val.format) cell.numFmt = resolveNumFmt(val.format);
          if (val.bold) cell.font = { ...cell.font, bold: true };
          if (val.italic) cell.font = { ...cell.font, italic: true };
          if (val.color) cell.font = { ...cell.font, color: { argb: "FF" + val.color.replace("#", "") } };
          if (val.bg) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + val.bg.replace("#", "") } };
          if (val.align) cell.alignment = { horizontal: val.align };
          if (val.wrap) cell.alignment = { ...cell.alignment, wrapText: true };
        } else if (typeof val === "string" && val.startsWith("=")) {
          // String starting with = is a formula
          cell.value = { formula: val.slice(1) };
        } else {
          // Auto-convert numeric strings to numbers for proper Excel handling
          if (typeof val === "string" && val !== "" && !isNaN(Number(val))) {
            cell.value = Number(val);
          } else {
            cell.value = val;
          }
        }

        // Alternating row colors
        if (ss.striped && ri % 2 === 1) {
          cell.fill = cell.fill || { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
        }

        // Light borders
        cell.border = {
          top: { style: "thin", color: { argb: "FFD9D9D9" } },
          bottom: { style: "thin", color: { argb: "FFD9D9D9" } },
          left: { style: "thin", color: { argb: "FFD9D9D9" } },
          right: { style: "thin", color: { argb: "FFD9D9D9" } },
        };
      }
    }

    // Summary / total row
    if (ss.totalRow) {
      const tr = ws.addRow([]);
      for (let ci = 0; ci < ss.totalRow.length; ci++) {
        const cell = tr.getCell(ci + 1);
        const val = ss.totalRow[ci];
        if (val && typeof val === "object") {
          if (val.formula) cell.value = { formula: val.formula, result: val.result };
          else cell.value = val.value || val.v || "";
          if (val.format) cell.numFmt = resolveNumFmt(val.format);
        } else {
          cell.value = val;
        }
        cell.font = { bold: true, size: 11 };
        cell.border = { top: { style: "double" }, bottom: { style: "double" } };
      }
    }

    // Column formats
    if (ss.columnFormats) {
      for (const [idx, fmt] of Object.entries(ss.columnFormats)) {
        const col = ws.getColumn(parseInt(idx) + 1);
        col.numFmt = resolveNumFmt(fmt);
      }
    }

    // Column widths
    if (ss.columnWidths) {
      for (const [idx, w] of Object.entries(ss.columnWidths)) {
        ws.getColumn(parseInt(idx) + 1).width = w;
      }
    } else {
      // Auto-width
      ws.columns.forEach((col) => {
        let max = 10;
        col.eachCell({ includeEmpty: false }, (c) => {
          const len = String(c.value?.formula || c.value || "").length;
          if (len > max) max = Math.min(len + 2, 40);
        });
        col.width = max + 2;
      });
    }

    // Conditional formatting
    for (const cf of ss.conditionalFormats || []) {
      ws.addConditionalFormatting({
        ref: cf.range, // e.g. "C2:C100"
        rules: [{
          type: "cellIs",
          operator: cf.operator || "greaterThan", // greaterThan, lessThan, between, equal
          formulae: cf.values || [cf.value || 0],
          style: {
            font: cf.fontColor ? { color: { argb: "FF" + cf.fontColor.replace("#", "") } } : undefined,
            fill: cf.bgColor ? { type: "pattern", pattern: "solid", bgColor: { argb: "FF" + cf.bgColor.replace("#", "") } } : undefined,
          },
          priority: 1,
        }],
      });
    }

    // Data validation (dropdowns)
    for (const dv of ss.validations || []) {
      ws.dataValidations.add(dv.range, {
        type: "list",
        allowBlank: true,
        formulae: ['"' + dv.options.join(",") + '"'],
      });
    }
  }

  return await wb.xlsx.writeBuffer();
}

function resolveNumFmt(fmt) {
  const map = {
    currency: "$#,##0.00", "currency-cny": "¥#,##0.00", "currency-hkd": "HK$#,##0.00",
    percentage: "0.00%", percent: "0.0%",
    number: "#,##0", decimal: "#,##0.00",
    date: "YYYY-MM-DD", datetime: "YYYY-MM-DD HH:MM",
    text: "@",
  };
  return map[fmt] || fmt; // Pass through custom formats like "0.000"
}

// ── Word Generation (rich formatting) ───────────────────────────────────────

async function generateDocx(spec) {
  const docx = require("docx");

  const children = [];

  // Title
  if (spec.title) {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: spec.title, bold: true, size: 52, font: "Calibri" })],
      spacing: { after: 100 },
    }));
  }

  if (spec.subtitle) {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: spec.subtitle, size: 28, color: "666666", font: "Calibri" })],
      spacing: { after: 200 },
    }));
  }

  if (spec.date || spec.author) {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: [spec.author, spec.date].filter(Boolean).join(" | "), size: 22, color: "999999" })],
      spacing: { after: 400 },
    }));
    children.push(new docx.Paragraph({ children: [new docx.TextRun("")], spacing: { after: 200 },
      border: { bottom: { style: docx.BorderStyle.SINGLE, size: 1, color: "CCCCCC" } },
    }));
  }

  // Table of Contents placeholder
  if (spec.toc) {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: "目录", bold: true, size: 32 })],
      spacing: { after: 200 },
    }));
    children.push(new docx.TableOfContents("TOC", { hyperlink: true, headingStyleRange: "1-3" }));
    children.push(new docx.Paragraph({ children: [], pageBreakBefore: true }));
  }

  // Sections
  for (const section of spec.sections || []) {
    if (section.heading) {
      children.push(new docx.Paragraph({
        text: section.heading,
        heading: docx.HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 120 },
      }));
    }

    if (section.subheading) {
      children.push(new docx.Paragraph({
        text: section.subheading,
        heading: docx.HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 80 },
      }));
    }

    const items = Array.isArray(section.content) ? section.content : section.content ? [section.content] : [];

    for (const item of items) {
      if (typeof item === "string") {
        children.push(new docx.Paragraph({ text: item, spacing: { after: 120 }, style: "Normal" }));
      } else if (item.type === "bullet") {
        for (const b of item.items || []) {
          children.push(new docx.Paragraph({ text: b, bullet: { level: item.level || 0 } }));
        }
      } else if (item.type === "numbered") {
        for (let i = 0; i < (item.items || []).length; i++) {
          children.push(new docx.Paragraph({
            children: [new docx.TextRun({ text: `${i + 1}. ${item.items[i]}` })],
            spacing: { after: 60 },
          }));
        }
      } else if (item.type === "table" && item.rows) {
        children.push(buildDocxTable(item, docx));
        children.push(new docx.Paragraph({ text: "" }));
      } else if (item.type === "code") {
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: item.text || item.code, font: "Courier New", size: 20 })],
          shading: { type: docx.ShadingType.SOLID, color: "F5F5F5" },
          spacing: { before: 100, after: 100 },
        }));
      } else if (item.type === "quote") {
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: item.text, italics: true, color: "555555" })],
          indent: { left: 720 },
          border: { left: { style: docx.BorderStyle.SINGLE, size: 6, color: "4472C4" } },
          spacing: { before: 100, after: 100 },
        }));
      } else if (item.type === "pagebreak") {
        children.push(new docx.Paragraph({ children: [], pageBreakBefore: true }));
      }
    }
  }

  const doc = new docx.Document({
    sections: [{
      children,
      headers: spec.headerText ? {
        default: new docx.Header({
          children: [new docx.Paragraph({
            children: [new docx.TextRun({ text: spec.headerText, color: "999999", size: 18 })],
            alignment: docx.AlignmentType.RIGHT,
          })],
        }),
      } : undefined,
      footers: spec.pageNumbers !== false ? {
        default: new docx.Footer({
          children: [new docx.Paragraph({
            children: [
              new docx.TextRun({ children: [docx.PageNumber.CURRENT], size: 18, color: "999999" }),
              new docx.TextRun({ text: " / ", size: 18, color: "999999" }),
              new docx.TextRun({ children: [docx.PageNumber.TOTAL_PAGES], size: 18, color: "999999" }),
            ],
            alignment: docx.AlignmentType.CENTER,
          })],
        }),
      } : undefined,
    }],
    creator: spec.author || "LumiGate",
    title: spec.title || "Document",
  });

  return await docx.Packer.toBuffer(doc);
}

function buildDocxTable(item, docx) {
  const rows = item.rows.map((row, ri) =>
    new docx.TableRow({
      children: row.map((cell) =>
        new docx.TableCell({
          children: [new docx.Paragraph({
            children: [new docx.TextRun({ text: String(cell), bold: ri === 0, size: 20 })],
          })],
          shading: ri === 0 ? { type: docx.ShadingType.SOLID, color: "4472C4" } : ri % 2 === 0 ? { type: docx.ShadingType.SOLID, color: "F2F2F2" } : undefined,
          verticalAlign: docx.VerticalAlign.CENTER,
          margins: { top: 40, bottom: 40, left: 80, right: 80 },
        })
      ),
      tableHeader: ri === 0,
    })
  );

  // Header row text white
  if (rows.length > 0) {
    rows[0].cells?.forEach((c) => {
      c.children?.forEach((p) => p.children?.forEach((r) => { if (r.font) r.font.color = { argb: "FFFFFFFF" }; }));
    });
  }

  return new docx.Table({
    rows,
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
  });
}

// ── PowerPoint Generation (professional) ────────────────────────────────────

async function generatePptx(spec) {
  const PptxGenJS = require("pptxgenjs");
  const pptx = new PptxGenJS();

  pptx.title = spec.title || "Presentation";
  pptx.author = spec.author || "LumiGate";
  pptx.layout = spec.layout || "LAYOUT_16x9";

  const theme = spec.theme || {};
  const primaryColor = theme.primary || "4472C4";
  const accentColor = theme.accent || "ED7D31";
  const bgColor = theme.background || "FFFFFF";
  const textColor = theme.text || "333333";

  // Title slide
  if (spec.title) {
    const s = pptx.addSlide();
    s.background = { color: primaryColor };
    s.addText(spec.title, {
      x: 0.8, y: 1.2, w: 8.4, h: 1.8,
      fontSize: 36, bold: true, color: "FFFFFF", align: "center", fontFace: "Calibri",
    });
    if (spec.subtitle) {
      s.addText(spec.subtitle, {
        x: 0.8, y: 3.2, w: 8.4, h: 0.8,
        fontSize: 18, color: "DDDDDD", align: "center", fontFace: "Calibri",
      });
    }
    if (spec.author || spec.date) {
      s.addText([spec.author, spec.date].filter(Boolean).join("  |  "), {
        x: 0.8, y: 4.5, w: 8.4, h: 0.5,
        fontSize: 12, color: "BBBBBB", align: "center",
      });
    }
  }

  // Content slides
  for (const slide of spec.slides || []) {
    const s = pptx.addSlide();
    s.background = { color: bgColor };

    // Colored bar at top
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: primaryColor } });

    // Slide number
    s.slideNumber = { x: 9.2, y: 6.9, fontSize: 9, color: "999999" };

    // Title
    if (slide.title) {
      s.addText(slide.title, {
        x: 0.5, y: 0.2, w: 9, h: 0.8,
        fontSize: 24, bold: true, color: textColor, fontFace: "Calibri",
      });
    }

    // Layout types
    if (slide.layout === "two-column" && slide.left && slide.right) {
      addSlideContent(s, slide.left, { x: 0.5, y: 1.3, w: 4.3, h: 4.5 }, primaryColor, textColor);
      addSlideContent(s, slide.right, { x: 5.2, y: 1.3, w: 4.3, h: 4.5 }, primaryColor, textColor);
    } else if (slide.layout === "title-only") {
      // Just title, already added
    } else {
      // Default: full-width content
      if (slide.bullets) {
        const items = slide.bullets.map((b) => {
          if (typeof b === "string") return { text: b, options: { fontSize: 16, bullet: { code: "2022" }, color: textColor, paraSpaceAfter: 6 } };
          return { text: b.text, options: { fontSize: b.size || 16, bold: b.bold, color: b.color || textColor, bullet: { code: "2022" }, indentLevel: b.indent || 0, paraSpaceAfter: 6 } };
        });
        s.addText(items, { x: 0.8, y: 1.3, w: 8.4, h: 4.5, valign: "top" });
      }

      if (slide.text) {
        s.addText(slide.text, {
          x: 0.5, y: 1.3, w: 9, h: 4.5,
          fontSize: 16, color: textColor, valign: "top",
        });
      }

      if (slide.table && slide.table.length > 0) {
        const rows = slide.table.map((row, i) =>
          row.map((cell) => ({
            text: String(cell),
            options: {
              fontSize: 11, bold: i === 0,
              color: i === 0 ? "FFFFFF" : textColor,
              fill: i === 0 ? primaryColor : i % 2 === 0 ? "F2F2F2" : "FFFFFF",
              border: [{ pt: 0.5, color: "D9D9D9" }],
              margin: [4, 6, 4, 6],
            },
          }))
        );
        s.addTable(rows, { x: 0.5, y: 1.3, w: 9, autoPage: true });
      }

      // Chart
      if (slide.chart) {
        addChart(s, pptx, slide.chart, primaryColor, accentColor);
      }

      // Key metric / big number
      if (slide.metric) {
        s.addText(slide.metric.value, {
          x: 2, y: 1.5, w: 6, h: 1.5,
          fontSize: 60, bold: true, color: primaryColor, align: "center",
        });
        if (slide.metric.label) {
          s.addText(slide.metric.label, {
            x: 2, y: 3.2, w: 6, h: 0.6,
            fontSize: 18, color: "888888", align: "center",
          });
        }
        if (slide.metric.change) {
          const isPositive = slide.metric.change.startsWith("+");
          s.addText(slide.metric.change, {
            x: 2, y: 3.9, w: 6, h: 0.5,
            fontSize: 16, color: isPositive ? "00B050" : "FF0000", align: "center",
          });
        }
      }
    }

    if (slide.notes) s.addNotes(slide.notes);
  }

  return Buffer.from(await pptx.write({ outputType: "arraybuffer" }));
}

function addSlideContent(s, content, pos, primaryColor, textColor) {
  if (content.bullets) {
    const items = content.bullets.map((b) => ({
      text: b, options: { fontSize: 14, bullet: { code: "2022" }, color: textColor, paraSpaceAfter: 4 },
    }));
    s.addText(items, { ...pos, valign: "top" });
  } else if (content.text) {
    s.addText(content.text, { ...pos, fontSize: 14, color: textColor, valign: "top" });
  }
}

function addChart(s, pptx, chartSpec, primaryColor, accentColor) {
  const chartColors = [primaryColor, accentColor, "A5A5A5", "FFC000", "5B9BD5", "70AD47"];
  const chartType = {
    bar: pptx.ChartType.bar, column: pptx.ChartType.bar,
    line: pptx.ChartType.line, pie: pptx.ChartType.pie,
    doughnut: pptx.ChartType.doughnut, area: pptx.ChartType.area,
  }[chartSpec.type || "bar"] || pptx.ChartType.bar;

  const data = (chartSpec.series || []).map((series, i) => ({
    name: series.name || `Series ${i + 1}`,
    labels: chartSpec.labels || series.labels || [],
    values: series.values || series.data || [],
  }));

  if (data.length > 0) {
    s.addChart(chartType, data, {
      x: 0.5, y: 1.3, w: 9, h: 4.5,
      showTitle: !!chartSpec.title,
      title: chartSpec.title,
      chartColors: chartColors.slice(0, data.length),
      showValue: chartSpec.showValues ?? false,
      showLegend: data.length > 1,
      legendPos: "b",
    });
  }
}

// ── Format Conversion ───────────────────────────────────────────────────────

async function xlsxToPptx(xlsxBuffer, options = {}) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxBuffer);

  const slides = [];

  wb.eachSheet((ws) => {
    // Extract headers and data
    const rows = [];
    ws.eachRow((row) => {
      rows.push(row.values.slice(1).map((v) => v?.result ?? v ?? ""));
    });

    if (rows.length === 0) return;

    // First row as headers, rest as data
    const table = rows;

    // Create a table slide
    slides.push({
      title: ws.name,
      table,
    });

    // Try to create a chart if data is numeric
    if (rows.length > 1 && rows[0].length >= 2) {
      const labels = rows.slice(1).map((r) => String(r[0]));
      const numericCols = [];
      for (let c = 1; c < rows[0].length; c++) {
        const vals = rows.slice(1).map((r) => parseFloat(r[c]));
        if (vals.every((v) => !isNaN(v))) {
          numericCols.push({ name: String(rows[0][c]), values: vals });
        }
      }
      if (numericCols.length > 0) {
        slides.push({
          title: `${ws.name} — 图表`,
          chart: {
            type: numericCols.length <= 3 ? "bar" : "line",
            labels,
            series: numericCols,
          },
        });
      }
    }
  });

  return generatePptx({
    title: options.title || "Data Report",
    author: options.author || "LumiGate",
    slides,
  });
}

async function xlsxToDocx(xlsxBuffer, options = {}) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxBuffer);

  const sections = [];

  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow((row) => {
      rows.push(row.values.slice(1).map((v) => String(v?.result ?? v ?? "")));
    });

    if (rows.length === 0) return;

    sections.push({
      heading: ws.name,
      content: [{ type: "table", rows }],
    });
  });

  return generateDocx({
    title: options.title || "Data Report",
    author: options.author || "LumiGate",
    date: new Date().toLocaleDateString("zh-CN"),
    sections,
    pageNumbers: true,
  });
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "doc-gen", formats: ["docx", "pptx", "xlsx"] }));
    return;
  }

  if (req.method === "GET" && req.url === "/tools") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tools: TOOL_SCHEMAS }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    let buffer, contentType, ext;
    const path = req.url;

    if (path === "/generate/docx") {
      const spec = JSON.parse(body.toString("utf-8"));
      buffer = await generateDocx(spec);
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      ext = "docx";
    } else if (path === "/generate/pptx") {
      const spec = JSON.parse(body.toString("utf-8"));
      buffer = await generatePptx(spec);
      contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      ext = "pptx";
    } else if (path === "/generate/xlsx") {
      const spec = JSON.parse(body.toString("utf-8"));
      buffer = await generateXlsx(spec);
      contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      ext = "xlsx";
    } else if (path === "/convert/xlsx-to-pptx") {
      const ct = req.headers["content-type"] || "";
      let xlsxBuf, opts = {};
      if (ct.includes("json")) {
        const spec = JSON.parse(body.toString("utf-8"));
        xlsxBuf = Buffer.from(spec.data, "base64");
        opts = { title: spec.title, author: spec.author };
      } else {
        xlsxBuf = body;
      }
      buffer = await xlsxToPptx(xlsxBuf, opts);
      contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      ext = "pptx";
    } else if (path === "/convert/xlsx-to-docx") {
      const ct = req.headers["content-type"] || "";
      let xlsxBuf, opts = {};
      if (ct.includes("json")) {
        const spec = JSON.parse(body.toString("utf-8"));
        xlsxBuf = Buffer.from(spec.data, "base64");
        opts = { title: spec.title, author: spec.author };
      } else {
        xlsxBuf = body;
      }
      buffer = await xlsxToDocx(xlsxBuf, opts);
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      ext = "docx";
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown endpoint", available: ["/generate/docx", "/generate/pptx", "/generate/xlsx", "/convert/xlsx-to-pptx", "/convert/xlsx-to-docx"] }));
      return;
    }

    const spec = path.startsWith("/generate/") ? JSON.parse(body.toString("utf-8")) : {};
    const filename = (spec.filename || spec.title || "document").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_");
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}.${ext}"`,
      "Content-Length": buffer.length,
    });
    res.end(buffer);
  } catch (err) {
    console.error("[doc-gen] Error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Failed: ${err.message || String(err)}` }));
  }
});

// ── Tool Schemas ────────────────────────────────────────────────────────────

const TOOL_SCHEMAS = [
  {
    name: "generate_document",
    description: "生成 Word 文档 (.docx)。支持标题、多级标题、段落、列表、表格、代码块、引用、页眉页脚、页码、分页。适用于报告、提案、信函。",
    endpoint: "/generate/docx",
    method: "POST",
    parameters: {
      type: "object", required: ["title", "sections"],
      properties: {
        title: { type: "string" }, subtitle: { type: "string" }, author: { type: "string" },
        date: { type: "string" }, toc: { type: "boolean", description: "Include table of contents" },
        headerText: { type: "string" }, pageNumbers: { type: "boolean", default: true },
        sections: { type: "array", items: { type: "object", properties: {
          heading: { type: "string" }, subheading: { type: "string" },
          content: { description: "String, or array of {type:'bullet'|'numbered'|'table'|'code'|'quote'|'pagebreak', ...}" },
        }}},
      },
    },
    output_type: "file", output_mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    name: "generate_presentation",
    description: "生成 PowerPoint 演示文稿 (.pptx)。支持标题页、要点列表、表格、图表(柱状/折线/饼图)、大数字展示、双栏布局、演讲备注。",
    endpoint: "/generate/pptx",
    method: "POST",
    parameters: {
      type: "object", required: ["title", "slides"],
      properties: {
        title: { type: "string" }, subtitle: { type: "string" }, author: { type: "string" },
        theme: { type: "object", properties: { primary: { type: "string" }, accent: { type: "string" } }},
        slides: { type: "array", items: { type: "object", properties: {
          title: { type: "string" },
          layout: { type: "string", enum: ["default", "two-column", "title-only"] },
          bullets: { type: "array" }, text: { type: "string" }, table: { type: "array" },
          chart: { type: "object", properties: { type: { type: "string", enum: ["bar", "line", "pie", "doughnut", "area"] }, labels: { type: "array" }, series: { type: "array" }, title: { type: "string" } }},
          metric: { type: "object", properties: { value: { type: "string" }, label: { type: "string" }, change: { type: "string" } }},
          notes: { type: "string" },
        }}},
      },
    },
    output_type: "file", output_mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  {
    name: "generate_spreadsheet",
    description: "生成 Excel 表格 (.xlsx)。支持公式、条件格式、数据验证(下拉框)、合并单元格、冻结窗格、多Sheet、自动列宽、交替行色。",
    endpoint: "/generate/xlsx",
    method: "POST",
    parameters: {
      type: "object", required: ["sheets"],
      properties: {
        sheets: { type: "array", items: { type: "object", required: ["name"], properties: {
          name: { type: "string" }, headers: { type: "array" },
          data: { type: "array", description: "Array of rows. Each cell can be value or {value, formula, format, bold, color, bg, align}" },
          totalRow: { type: "array", description: "Summary row with formulas like {formula:'=SUM(B2:B10)', format:'currency'}" },
          columnFormats: { type: "object", description: "Column index → format: currency|percentage|number|date|currency-cny" },
          conditionalFormats: { type: "array", items: { type: "object", properties: { range: { type: "string" }, operator: { type: "string" }, value: {}, fontColor: { type: "string" }, bgColor: { type: "string" } }}},
          validations: { type: "array", items: { type: "object", properties: { range: { type: "string" }, options: { type: "array" } }}},
          merges: { type: "array" }, striped: { type: "boolean", default: true },
          freezeRow: { type: "integer" }, freezeCol: { type: "integer" },
        }}},
      },
    },
    output_type: "file", output_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  {
    name: "convert_xlsx_to_pptx",
    description: "将 Excel 数据转换为 PowerPoint 演示文稿。自动生成数据表格页和图表页。",
    endpoint: "/convert/xlsx-to-pptx",
    method: "POST",
    input_type: "file_or_json",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, data: { type: "string", description: "Base64 encoded xlsx" } },
    },
    output_type: "file", output_mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  {
    name: "convert_xlsx_to_docx",
    description: "将 Excel 数据转换为 Word 报告文档。每个 Sheet 生成一个章节。",
    endpoint: "/convert/xlsx-to-docx",
    method: "POST",
    input_type: "file_or_json",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, data: { type: "string", description: "Base64 encoded xlsx" } },
    },
    output_type: "file", output_mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    name: "web_search",
    description: "搜索网页。用于查询时事、验证事实、研究资料。",
    endpoint: "http://lumigate-searxng:8080/search",
    method: "GET",
    parameters: {
      type: "object", required: ["q"],
      properties: {
        q: { type: "string" }, categories: { type: "string" },
        time_range: { type: "string", enum: ["day", "week", "month", "year"] },
        language: { type: "string", default: "auto" }, format: { type: "string", default: "json" },
      },
    },
    output_type: "json",
  },
];

const PORT = process.env.PORT || 3101;
server.listen(PORT, () => {
  console.log(`[doc-gen] Listening on :${PORT}`);
  console.log(`[doc-gen] Endpoints: /generate/docx, /generate/pptx, /generate/xlsx, /convert/xlsx-to-pptx, /convert/xlsx-to-docx`);
  console.log(`[doc-gen] Tool schemas: GET /tools`);
});
