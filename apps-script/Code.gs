/**
 * Google Apps Script (doGet/doPost API)
 * - 支援 action=query / admin_list / admin_update / debug
 * - 以表頭驗證訂單分頁，不依賴分頁名稱規則
 * - 預留 LINE ID 查詢機制（line_user_id）
 */

const CONFIG = {
  // ✅ 請改成正確的試算表 ID（網址中的 /d/<ID>/）
  spreadsheetId: "PUT_YOUR_SPREADSHEET_ID_HERE",
  // ✅ 付款明細分頁（若沒有可留空）
  paymentsSheetName: "payments",
  // ✅ 使用者查詢用密碼
  userQueryKey: "HXH2026",
  // ✅ 管理者密碼
  adminKey: "a-2001626",
  // ✅ 別名表 sheet 名稱（可留空）
  aliasesSheetName: "aliases"
};

const SKIP_SHEET_PATTERNS = [
  /設定/i,
  /說明/i,
  /template/i,
  /匯總/i,
  /總表/i,
  /付款明細/i,
  /對帳/i,
  /log/i,
  /備註/i
];

const ORDER_FIELD_ALIASES = {
  nickname: ["暱稱", "名稱", "name", "nickname", "LINE名稱", "FB名稱"],
  item: ["品項", "商品", "item", "product"],
  qty: ["數量", "qty", "quantity"],
  amount: ["金額", "小計", "應收", "amount", "subtotal"],
  pay_status: ["付款狀態", "狀態", "pay_status", "付款", "已付", "未付", "已付款", "未付款"],
  arrived_qty: ["到貨", "到貨數量", "arrived_qty", "arrived"],
  pack_status: ["包貨", "包貨狀態", "pack_status"],
  packed_at: ["包貨時間", "packed_at", "packed_time"],
  ship_status: ["出貨", "出貨狀態", "ship_status"],
  shipped_at: ["出貨時間", "shipped_at", "shipped_time"],
  package_id: ["包裹編號", "package_id", "package"],
  tracking_no: ["物流單號", "tracking_no", "tracking"],
  order_link: ["賣貨便連結", "order_link", "link"],
  note: ["備註", "note", "memo"],
  ship_pref: ["出貨偏好", "ship_pref", "ship preference"]
};

const PAYMENT_FIELD_ALIASES = {
  nickname: ["暱稱", "名稱", "name", "nickname", "LINE名稱", "FB名稱"],
  paid_at: ["時間", "付款時間", "paid_at", "date"],
  amount: ["金額", "amount", "price", "total"],
  note: ["備註", "note", "memo"]
};

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = (params.action || "query").trim();

  try {
    if (action === "query") {
      return jsonResponse(queryByName(params));
    }
    if (action === "admin_list") {
      return jsonResponse(adminList(params));
    }
    if (action === "debug") {
      return jsonResponse(debugSheets());
    }
    return jsonResponse({ ok: false, message: "未知 action" });
  } catch (err) {
    return jsonResponse({
      ok: false,
      message: err && err.message ? err.message : "伺服器錯誤"
    });
  }
}

function doPost(e) {
  try {
    const payload = parsePayload(e);
    const action = (payload.action || "").trim();
    if (action === "admin_update") {
      return jsonResponse(adminUpdate(payload));
    }
    return jsonResponse({ ok: false, message: "未知 action" });
  } catch (err) {
    return jsonResponse({
      ok: false,
      message: err && err.message ? err.message : "伺服器錯誤"
    });
  }
}

/**
 * action=query
 */
function queryByName(params) {
  const queryKey = params.key || "";
  const lineUserId = params.line_user_id || "";

  if (lineUserId) {
    // line_user_id 模式不需要 key
  } else if (CONFIG.userQueryKey && queryKey !== CONFIG.userQueryKey) {
    return { ok: false, message: "查詢密碼錯誤" };
  }

  const qInput = params.q || "";
  const aliasData = loadAliases();
  const resolved = resolveNickname(qInput, lineUserId, aliasData);

  if (!resolved.canonical || !resolved.canonicalNormalized) {
    return {
      ok: false,
      message: "找不到對應暱稱，請確認別名設定",
      debug: buildQueryDebug("key", qInput, resolved, [])
    };
  }

  const ordersSheets = findOrdersSheets();
  if (!ordersSheets.length) {
    return {
      ok: false,
      message: "沒有找到訂單分頁",
      debug: buildQueryDebug(resolveMode(lineUserId), qInput, resolved, [])
    };
  }

  const matchedRows = [];
  const scanned = [];
  ordersSheets.forEach(sheetInfo => {
    const sheetName = sheetInfo.sheet.getName();
    const sheetRows = readRows(sheetInfo.sheet, ORDER_FIELD_ALIASES, sheetInfo.headerIndex, sheetInfo.requiredMissing);
    const filtered = sheetRows.filter(row => {
      const normalized = normalizeName(row.nickname);
      return normalized && normalized.includes(resolved.canonicalNormalized);
    });
    filtered.forEach(row => {
      row.group = sheetName;
      row.row_id = `${sheetName}|${row.row_index}`;
    });
    matchedRows.push.apply(matchedRows, filtered);
    scanned.push({
      name: sheetName,
      isOrdersSheet: true,
      rows: sheetRows.length,
      matched: filtered.length,
      missing: sheetInfo.requiredMissing
    });
  });

  const payments = loadPayments(resolved.canonicalNormalized);

  if (!matchedRows.length) {
    return {
      ok: false,
      message: "沒有符合的訂單資料",
      debug: buildQueryDebug(resolveMode(lineUserId), qInput, resolved, scanned, matchedRows.length)
    };
  }

  const totalAll = sumAmount(matchedRows.map(row => row.amount));
  const totalPaid = sumAmount(payments.map(row => row.amount));
  const totalUnpaid = Math.max(0, totalAll - totalPaid);

  return {
    ok: true,
    nickname: resolved.canonical,
    details: matchedRows,
    payments: payments,
    total_paid: totalPaid,
    total_unpaid: totalUnpaid,
    total_all: totalAll,
    debug: buildQueryDebug(resolveMode(lineUserId), qInput, resolved, scanned, matchedRows.length)
  };
}

function resolveMode(lineUserId) {
  return lineUserId ? "line_user_id" : "key";
}

/**
 * action=admin_list
 */
function adminList(params) {
  const key = params.admin_key || "";
  if (CONFIG.adminKey && key !== CONFIG.adminKey) {
    return { ok: false, message: "管理碼錯誤" };
  }

  const ordersSheets = findOrdersSheets();
  const details = [];
  const groups = [];

  ordersSheets.forEach(sheetInfo => {
    const sheetName = sheetInfo.sheet.getName();
    if (!groups.includes(sheetName)) {
      groups.push(sheetName);
    }
    const sheetRows = readRows(sheetInfo.sheet, ORDER_FIELD_ALIASES, sheetInfo.headerIndex, sheetInfo.requiredMissing);
    sheetRows.forEach(row => {
      row.sheet = sheetName;
      row.row_id = `${sheetName}|${row.row_index}`;
      details.push(row);
    });
  });

  return { ok: true, message: "OK", details: details, groups: groups };
}

/**
 * action=admin_update
 * payload:
 * {
 *   action: "admin_update",
 *   admin_key: "...",
 *   updates: [{ row_id: "sheet|12", patch: { pack_status: "已包" } }]
 * }
 */
function adminUpdate(payload) {
  const key = payload.admin_key || "";
  if (CONFIG.adminKey && key !== CONFIG.adminKey) {
    return { ok: false, message: "管理碼錯誤" };
  }

  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  if (!updates.length) {
    return { ok: false, message: "沒有更新內容" };
  }

  const ordersSheets = findOrdersSheets();
  const sheetMap = {};
  ordersSheets.forEach(info => {
    sheetMap[info.sheet.getName()] = info;
  });

  let updated = 0;
  updates.forEach(update => {
    if (!update || !update.row_id || !update.patch) return;
    const parts = String(update.row_id).split("|");
    if (parts.length < 2) return;
    const sheetName = parts[0];
    const rowIndex = Number(parts[1]);
    const sheetInfo = sheetMap[sheetName];
    if (!sheetInfo || !rowIndex || rowIndex < 2) return;

    const sheet = sheetInfo.sheet;
    const values = sheet.getDataRange().getValues();
    if (rowIndex > values.length) return;

    const headers = values[0];
    const headerIndex = buildHeaderIndex(headers);
    const columnMap = buildColumnMap(ORDER_FIELD_ALIASES, headerIndex);
    const rowValues = values[rowIndex - 1].slice();

    Object.keys(update.patch).forEach(field => {
      const colIndex = columnMap[field];
      if (colIndex) {
        rowValues[colIndex - 1] = update.patch[field];
      }
    });

    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowValues]);
    updated += 1;
  });

  return { ok: true, message: "更新完成", updated: updated };
}

/**
 * action=debug
 */
function debugSheets() {
  const aliasData = loadAliases();
  const ordersSheets = findOrdersSheets(true);
  const scanned = ordersSheets.scanned || [];
  return {
    ok: true,
    sheets: scanned,
    aliases: {
      enabled: aliasData.enabled,
      count: aliasData.list.length
    }
  };
}

/**
 * 查詢準備：掃描所有分頁，找出訂單分頁
 */
function findOrdersSheets(includeDebug) {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheets = spreadsheet.getSheets();
  const orders = [];
  const scanned = [];

  sheets.forEach(sheet => {
    const name = sheet.getName();
    if (SKIP_SHEET_PATTERNS.some(pattern => pattern.test(name))) {
      if (includeDebug) {
        scanned.push({
          name: name,
          isOrdersSheet: false,
          rows: sheet.getLastRow(),
          missing: ["skip"]
        });
      }
      return;
    }

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] || [];
    const headerIndex = buildHeaderIndex(headers);
    const requiredMissing = requiredOrderMissing(headerIndex);
    const isOrdersSheet = requiredMissing.length === 0;

    if (includeDebug) {
      scanned.push({
        name: name,
        isOrdersSheet: isOrdersSheet,
        rows: sheet.getLastRow(),
        missing: requiredMissing
      });
    }

    if (isOrdersSheet) {
      orders.push({ sheet: sheet, headerIndex: headerIndex, requiredMissing: requiredMissing });
    }
  });

  if (includeDebug) {
    return { orders: orders, scanned: scanned };
  }
  return orders;
}

function requiredOrderMissing(headerIndex) {
  const required = ["nickname", "item", "qty", "amount"];
  const missing = [];
  required.forEach(field => {
    const aliases = ORDER_FIELD_ALIASES[field];
    if (!aliases || findHeaderIndex(headerIndex, aliases) < 0) {
      missing.push(field);
    }
  });
  return missing;
}

function readRows(sheet, aliasMap, headerIndex, requiredMissing) {
  if (requiredMissing && requiredMissing.length) return [];
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];

  const headers = values[0];
  const idx = headerIndex || buildHeaderIndex(headers);
  const rows = [];

  for (let i = 1; i < values.length; i++) {
    const rowValues = values[i];
    if (rowValues.every(cell => String(cell || "").trim() === "")) {
      continue;
    }
    rows.push(mapRow(idx, rowValues, aliasMap, i + 1));
  }
  return rows;
}

function mapRow(headerIndex, rowValues, aliasMap, rowIndex) {
  const output = {};
  Object.keys(aliasMap).forEach(key => {
    const aliases = aliasMap[key];
    const index = findHeaderIndex(headerIndex, aliases);
    output[key] = index >= 0 ? rowValues[index] : "";
  });
  output.row_index = rowIndex;
  return output;
}

function buildHeaderIndex(headers) {
  const index = {};
  headers.forEach((header, i) => {
    const normalized = normalizeHeader(header);
    if (normalized) {
      index[normalized] = i;
    }
  });
  return index;
}

function normalizeHeader(header) {
  return String(header || "").trim().toLowerCase();
}

function findHeaderIndex(headerIndex, aliases) {
  for (let i = 0; i < aliases.length; i++) {
    const normalized = normalizeHeader(aliases[i]);
    if (Object.prototype.hasOwnProperty.call(headerIndex, normalized)) {
      return headerIndex[normalized];
    }
  }
  return -1;
}

function buildColumnMap(aliasMap, headerIndex) {
  const map = {};
  Object.keys(aliasMap).forEach(key => {
    const colIndex = findHeaderIndex(headerIndex, aliasMap[key]);
    if (colIndex >= 0) {
      map[key] = colIndex + 1;
    }
  });
  return map;
}

/**
 * 暱稱標準化
 */
function normalizeName(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  text = text.replace(/\u3000/g, " ");
  text = text.trim().replace(/\s+/g, " ");
  text = stripDecorators(text);
  return text.toLowerCase();
}

function stripDecorators(text) {
  const decorators = [
    ["【", "】"],
    ["（", "）"],
    ["(", ")"],
    ["「", "」"],
    ["『", "』"],
    ["[", "]"],
    ["<", ">"]
  ];

  let trimmed = text.trim();
  decorators.forEach(pair => {
    const start = pair[0];
    const end = pair[1];
    if (trimmed.startsWith(start) && trimmed.endsWith(end) && trimmed.length > 2) {
      trimmed = trimmed.substring(1, trimmed.length - 1).trim();
    }
  });
  return trimmed;
}

/**
 * 別名表
 */
function loadAliases() {
  const result = { enabled: false, list: [] };
  if (!CONFIG.aliasesSheetName) return result;

  const spreadsheet = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(CONFIG.aliasesSheetName);
  if (!sheet) return result;

  const values = sheet.getDataRange().getValues();
  if (!values.length) return result;

  const headers = values[0];
  const headerIndex = buildHeaderIndex(headers);
  const aliasCol = findHeaderIndex(headerIndex, ["alias"]);
  const canonicalCol = findHeaderIndex(headerIndex, ["canonical"]);
  const lineCol = findHeaderIndex(headerIndex, ["line_user_id", "line id", "line"]);

  if (aliasCol < 0 || canonicalCol < 0) return result;

  for (let i = 1; i < values.length; i++) {
    const rowValues = values[i];
    const alias = rowValues[aliasCol];
    const canonical = rowValues[canonicalCol];
    const lineUserId = lineCol >= 0 ? rowValues[lineCol] : "";
    if (!alias || !canonical) continue;
    result.list.push({
      alias: normalizeName(alias),
      canonical: normalizeName(canonical),
      canonicalRaw: String(canonical),
      line_user_id: String(lineUserId || "").trim()
    });
  }

  result.enabled = result.list.length > 0;
  return result;
}

function resolveNickname(qInput, lineUserId, aliasData) {
  const normalizedInput = normalizeName(qInput);
  let canonical = "";
  let canonicalNormalized = "";

  if (lineUserId && aliasData.enabled) {
    const match = aliasData.list.find(row => row.line_user_id === lineUserId);
    if (match) {
      canonical = match.canonicalRaw;
      canonicalNormalized = match.canonical;
    }
  }

  if (!canonical) {
    const match = aliasData.enabled
      ? aliasData.list.find(row => row.alias === normalizedInput)
      : null;
    if (match) {
      canonical = match.canonicalRaw;
      canonicalNormalized = match.canonical;
    } else {
      canonical = qInput;
      canonicalNormalized = normalizedInput;
    }
  }

  return {
    input: qInput,
    normalized: normalizedInput,
    canonical: canonical,
    canonicalNormalized: canonicalNormalized
  };
}

function loadPayments(canonicalNormalized) {
  if (!CONFIG.paymentsSheetName) return [];
  const spreadsheet = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(CONFIG.paymentsSheetName);
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];

  const headers = values[0];
  const headerIndex = buildHeaderIndex(headers);
  const missing = requiredPaymentMissing(headerIndex);
  if (missing.length) return [];

  const rows = readRows(sheet, PAYMENT_FIELD_ALIASES, headerIndex, []);
  return rows.filter(row => normalizeName(row.nickname) === canonicalNormalized);
}

function requiredPaymentMissing(headerIndex) {
  const required = ["nickname", "amount"];
  const missing = [];
  required.forEach(field => {
    const aliases = PAYMENT_FIELD_ALIASES[field];
    if (!aliases || findHeaderIndex(headerIndex, aliases) < 0) {
      missing.push(field);
    }
  });
  return missing;
}

function sumAmount(values) {
  return values.reduce((sum, value) => sum + Number(value || 0), 0);
}

function buildQueryDebug(mode, qInput, resolved, scannedSheets, matchedRows) {
  return {
    mode: mode,
    q_input: qInput,
    q_normalized: resolved.normalized,
    q_canonical: resolved.canonical,
    scannedSheets: scannedSheets || [],
    matchedRows: matchedRows || 0
  };
}

function parsePayload(e) {
  let payload = {};
  if (e && e.postData && e.postData.contents) {
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (err) {
      payload = {};
    }
  }
  const params = e && e.parameter ? e.parameter : {};
  Object.keys(params).forEach(key => {
    if (payload[key] === undefined) {
      payload[key] = params[key];
    }
  });
  return payload;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
