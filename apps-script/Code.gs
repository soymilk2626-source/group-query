/**
 * Google Apps Script (doGet API)
 * - 專供本專案使用（action=query / admin_list / admin_update）
 * - 請先確認試算表 ID 與分頁名稱是否正確
 */

const CONFIG = {
  // ✅ 請改成正確的試算表 ID（網址中的 /d/<ID>/）
  spreadsheetId: "PUT_YOUR_SPREADSHEET_ID_HERE",
  // ✅ 訂單明細分頁（每一列一筆品項）
  ordersSheetName: "orders",
  // ✅ 付款明細分頁（每一列一筆付款紀錄）
  paymentsSheetName: "payments",
  // ✅ 使用者查詢用密碼（可留空表示不驗證）
  userQueryKey: "USER_QUERY_KEY",
  // ✅ 管理者密碼（可留空表示不驗證）
  adminKey: "ADMIN_KEY"
};

/**
 * entry point
 */
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = (params.action || "query").trim();

  try {
    if (action === "query") {
      return jsonResponse(queryByName(params.q, params.key));
    }
    if (action === "admin_list") {
      return jsonResponse(adminList(params.key));
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
 * admin_update 建議用 POST
 */
function doPost(e) {
  try {
    const payload = parsePayload(e);
    if ((payload.action || "").trim() === "admin_update" || payload.updates) {
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
 * 一般查詢：action=query&q=暱稱&key=USER_QUERY_KEY
 * - 暱稱採「trim 後包含式比對」
 */
function queryByName(rawName, key) {
  if (!rawName) {
    return { ok: false, message: "請提供暱稱" };
  }
  if (CONFIG.userQueryKey && key !== CONFIG.userQueryKey) {
    return { ok: false, message: "查詢密碼錯誤" };
  }

  const nameQuery = normalizeValue(rawName);
  const ordersSheet = getSheet(CONFIG.ordersSheetName);
  const paymentsSheet = getSheet(CONFIG.paymentsSheetName);

  const orderRows = readRows(ordersSheet, ORDER_FIELD_ALIASES);
  const paymentRows = readRows(paymentsSheet, PAYMENT_FIELD_ALIASES);

  const matchedOrders = orderRows.filter(row => includesName(row.name, nameQuery));
  const matchedPayments = paymentRows.filter(row => includesName(row.name, nameQuery));

  const dueTotal = sumAmount(matchedOrders.map(row => row.amount));
  const paidTotal = sumAmount(matchedPayments.map(row => row.amount));
  const balance = Number(dueTotal) - Number(paidTotal);

  return {
    ok: true,
    message: "OK",
    details: matchedOrders,
    payments: matchedPayments,
    due_total: dueTotal,
    paid_total: paidTotal,
    balance: balance
  };
}

/**
 * 管理者列出：action=admin_list&key=ADMIN_KEY
 */
function adminList(key) {
  if (CONFIG.adminKey && key !== CONFIG.adminKey) {
    return { ok: false, message: "管理碼錯誤" };
  }
  const ordersSheet = getSheet(CONFIG.ordersSheetName);
  const orderRows = readRows(ordersSheet, ORDER_FIELD_ALIASES);
  const groups = uniqueValues(orderRows.map(row => row.group || row.sheet));
  return { ok: true, message: "OK", details: orderRows, groups: groups };
}

/**
 * 管理者更新：POST action=admin_update
 * payload:
 * {
 *   key: "ADMIN_KEY",
 *   updates: [{ row_index: 2, arrived_qty: 3, pack_status: "已包", ... }]
 * }
 */
function adminUpdate(payload) {
  const key = payload.key || payload.admin_key || "";
  if (CONFIG.adminKey && key !== CONFIG.adminKey) {
    return { ok: false, message: "管理碼錯誤" };
  }

  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  if (!updates.length) {
    return { ok: false, message: "沒有更新內容" };
  }

  const ordersSheet = getSheet(CONFIG.ordersSheetName);
  const values = ordersSheet.getDataRange().getValues();
  if (!values.length) {
    return { ok: false, message: "資料表為空" };
  }

  const headers = values[0];
  const headerIndex = buildHeaderIndex(headers);
  const columnMap = buildColumnMap(ORDER_FIELD_ALIASES, headerIndex);
  const updatedRows = [];

  updates.forEach(update => {
    const rowIndex = Number(update.row_index);
    if (!rowIndex || rowIndex < 2 || rowIndex > values.length) {
      return;
    }

    const rowValues = values[rowIndex - 1].slice();
    Object.keys(update).forEach(field => {
      if (field === "row_index") return;
      const colIndex = columnMap[field];
      if (colIndex) {
        rowValues[colIndex - 1] = update[field];
      }
    });

    ordersSheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowValues]);
    updatedRows.push(rowIndex);
  });

  return { ok: true, message: "更新完成", updated: updatedRows.length };
}

/**
 * 讀取試算表
 */
function getSheet(sheetName) {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error("找不到分頁：" + sheetName);
  }
  return sheet;
}

/**
 * 讀取資料列（第一列為標題）
 */
function readRows(sheet, aliasMap) {
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];

  const headers = values[0];
  const headerIndex = buildHeaderIndex(headers);
  const rows = [];

  for (let i = 1; i < values.length; i++) {
    const rowValues = values[i];
    if (rowValues.every(cell => String(cell || "").trim() === "")) {
      continue;
    }
    rows.push(mapRow(headerIndex, rowValues, aliasMap, i + 1));
  }
  return rows;
}

/**
 * 把一列資料依欄位別名映射成物件
 */
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

/**
 * 標題列建立索引（trim+lower）
 */
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
 * 查詢比對（包含式）
 */
function normalizeValue(value) {
  return String(value || "").trim().toLowerCase();
}

function includesName(nameValue, queryValue) {
  if (!queryValue) return false;
  const target = normalizeValue(nameValue);
  if (!target) return false;
  return target.indexOf(queryValue) !== -1;
}

function sumAmount(values) {
  return values.reduce((sum, value) => sum + Number(value || 0), 0);
}

function uniqueValues(values) {
  const result = [];
  values.forEach(value => {
    const text = String(value || "").trim();
    if (text && !result.includes(text)) {
      result.push(text);
    }
  });
  return result;
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

/**
 * 欄位別名（依你的試算表標題自行調整）
 */
const ORDER_FIELD_ALIASES = {
  name: ["暱稱", "name", "nickname"],
  group: ["團別", "group", "sheet"],
  item: ["品項", "item", "product"],
  qty: ["數量", "qty", "quantity"],
  amount: ["金額", "amount", "price", "total"],
  paid_status: ["付款", "付款狀態", "paid_status", "payment_status", "paid"],
  arrived_qty: ["到貨", "到貨數量", "arrived_qty", "arrived"],
  ship_pref: ["出貨偏好", "ship_pref", "ship preference"],
  package_id: ["包裹編號", "package_id", "package"],
  pack_status: ["包貨", "包貨狀態", "pack_status"],
  ship_status: ["出貨", "出貨狀態", "ship_status"],
  packed_at: ["包貨時間", "packed_at", "packed_time"],
  shipped_at: ["出貨時間", "shipped_at", "shipped_time"],
  tracking_no: ["物流單號", "tracking_no", "tracking"],
  order_link: ["賣貨便連結", "order_link", "link"],
  note: ["備註", "note", "memo"]
};

const PAYMENT_FIELD_ALIASES = {
  name: ["暱稱", "name", "nickname"],
  paid_at: ["時間", "付款時間", "paid_at", "date"],
  amount: ["金額", "amount", "price", "total"],
  note: ["備註", "note", "memo"]
};
