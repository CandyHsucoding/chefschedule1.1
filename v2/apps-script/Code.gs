/**
 * 廚房計時人員排班系統 v2 — Google Apps Script 後端
 *
 * 與舊版的差異：
 *  1. 新增 doGet：網頁可讀回試算表資料，管理者在任何裝置都看得到兩人的提交狀態。
 *  2. 每位人員的資料分開存放於「v2提交紀錄」，由伺服器合併後重建「115年X月排班表」，
 *     後送出的人不會再覆蓋先送出的人的請假資料。
 *  3. 若某月份尚無 v2 紀錄，會從既有的「115年X月排班表」反推兩人資料（相容舊版已送出的班表）。
 *  4. 通知信會註明是哪一位人員提交、請假幾天。
 *
 * 部署方式（不影響舊版）：
 *  1. 到 https://script.google.com 按「新專案」，把本檔內容整份貼上取代 Code.gs。
 *  2. 按「部署」→「新增部署作業」→ 類型選「網頁應用程式」
 *     執行身分：我；誰可以存取：所有人 → 部署，依提示授權。
 *  3. 複製「網頁應用程式網址」(以 /exec 結尾)，貼到 v2/index.html 的 API_URL。
 */

const SPREADSHEET_ID = "1S0Koh97wDHxmaxSaOpZh921aJcc730qgtsac_b_83Eg";
const RECORD_SHEET = "v2提交紀錄";
const HOLIDAY_SHEET = "假日設定";
const ADJUST_SHEET = "臨時異動紀錄";
const STAFF = ["溫美萍", "郭恒妘"];
const RECORD_HEADER = ["提交時間", "年", "月", "填表人", "日期", "狀態", "代班人員", "備註"];
const ADJUST_HEADER = ["登記時間", "年", "月", "日期", "人員", "異動", "代班人員"];
const ADJUSTED_MARK = "臨時異動";
const NOTIFY_EMAIL = ""; // 留空則寄給部署者本人
const COLOR = {
  white: "#ffffff",
  ink: "#263238",
  muted: "#607d8b",
  title: "#274e13",
  header: "#d9ead3",
  border: "#8a8a8a",
  leaveRow: "#fde7e4",     // 有人請假的那一列
  leaveCell: "#ea9999",    // 代班人員所在的排班格
  leaveText: "#a61c00",
  summaryLeave: "#fff4e5",
  summaryNone: "#f3f6f4"
};

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (params.action === "month") {
      return json_({ status: "success", data: getMonth_(Number(params.year), Number(params.month)) });
    }
    return json_({ status: "success", data: getCalendar_() });
  } catch (error) {
    return json_({ status: "error", message: String(error) });
  }
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (error) {
    return json_({ status: "error", message: "資料格式不正確" });
  }
  if (payload.action === "verifyAdmin") return json_(verifyAdmin_(payload.pin));

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (payload.action === "adjust") return json_(adjust_(payload));


    const year = Number(payload.year);
    const month = Number(payload.month);
    const staff = String(payload.submittedBy || "");
    if (!year || !month || STAFF.indexOf(staff) === -1 || !Array.isArray(payload.personalData) || !Array.isArray(payload.days)) {
      return json_({ status: "error", message: "資料格式不正確" });
    }

    const submittedAt = new Date();
    saveSubmission_(year, month, staff, payload.personalData, submittedAt);
    const monthData = getMonth_(year, month);
    writeMonthSheet_(year, month, payload.days, monthData.submissions, staff + "送出");
    notify_(year, month, staff, payload.personalData);

    return json_({ status: "success", data: monthData });
  } catch (error) {
    return json_({ status: "error", message: String(error) });
  } finally {
    lock.releaseLock();
  }
}

// 管理者 PIN 存在「專案設定 → 指令碼屬性」的 ADMIN_PIN，不寫在程式碼裡
function verifyAdmin_(pin) {
  const expected = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!expected) {
    return { status: "error", message: "尚未設定管理者 PIN，請在 Apps Script「專案設定 → 指令碼屬性」新增 ADMIN_PIN。" };
  }
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("adminPinFails") || 0);
  if (fails >= 5) return { status: "error", message: "PIN 錯誤次數過多，請 10 分鐘後再試。" };
  if (String(pin || "") === expected) {
    cache.remove("adminPinFails");
    return { status: "success" };
  }
  cache.put("adminPinFails", String(fails + 1), 600);
  return { status: "error", message: "PIN 碼錯誤。" };
}

// 管理者登記臨時請假／取消請假：不受提交期限限制，只改當天那一筆，並留下異動紀錄
function adjust_(payload) {
  const auth = verifyAdmin_(payload.pin);
  if (auth.status !== "success") return auth;

  const year = Number(payload.year);
  const month = Number(payload.month);
  const staff = String(payload.staff || "");
  const date = String(payload.date || "");
  const status = payload.status === "請假" ? "請假" : "出勤";
  const substitute = status === "請假" ? String(payload.substitute || "").trim() : "";
  const monthPrefix = year + "-" + ("0" + month).slice(-2) + "-";
  if (!year || !month || STAFF.indexOf(staff) === -1 || date.indexOf(monthPrefix) !== 0 || !Array.isArray(payload.days)) {
    return { status: "error", message: "資料格式不正確" };
  }
  if (status === "請假" && (!substitute || substitute === staff)) return { status: "error", message: "請填寫代班人員。" };

  const before = getMonth_(year, month).submissions[staff];
  // 此人本月尚未提交時，以全月出勤為底再修改當天
  const rows = before
    ? before.rows.map(row => ({ date: row.date, status: row.status, substitute: row.substitute, adjusted: row.adjusted }))
    : payload.days.map(day => ({ date: String(day.date), status: "出勤", substitute: "" }));
  let row = rows.filter(item => item.date === date)[0];
  if (!row) {
    row = { date: date };
    rows.push(row);
    rows.sort((a, b) => a.date < b.date ? -1 : 1);
  }
  row.status = status;
  row.substitute = substitute;
  row.adjusted = true;

  const submittedAt = before && before.source === "v2" && before.submittedAt ? new Date(before.submittedAt) : new Date();
  saveSubmission_(year, month, staff, rows, submittedAt);
  adjustSheet_().appendRow([new Date(), year, month, date, staff, status === "請假" ? "臨時請假" : "取消請假", substitute]);

  const label = Number(date.slice(5, 7)) + "/" + Number(date.slice(8, 10));
  const change = status === "請假" ? staff + "請假，" + substitute + "代班" : staff + "取消請假";
  const monthData = getMonth_(year, month);
  writeMonthSheet_(year, month, payload.days, monthData.submissions, "臨時異動：" + label + " " + change);
  notifyAdjust_(year, month, label + " " + change);
  return { status: "success", data: monthData };
}

function adjustSheet_() {
  const ss = ss_();
  let sheet = ss.getSheetByName(ADJUST_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ADJUST_SHEET);
    sheet.appendRow(ADJUST_HEADER);
    sheet.setFrozenRows(1);
    sheet.getRange("D:D").setNumberFormat("@");
  }
  return sheet;
}

function getAdjustments_(year, month) {
  const sheet = ss_().getSheetByName(ADJUST_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1)
    .filter(r => Number(r[1]) === year && Number(r[2]) === month)
    .map(r => ({ loggedAt: new Date(r[0]).toISOString(), date: toText_(r[3]), staff: r[4], change: r[5], substitute: r[6] || "" }));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function monthSheetName_(year, month) {
  return (year - 1911) + "年" + month + "月排班表";
}

function recordSheet_() {
  const ss = ss_();
  let sheet = ss.getSheetByName(RECORD_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(RECORD_SHEET);
    sheet.appendRow(RECORD_HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function toText_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return String(value);
}

function saveSubmission_(year, month, staff, rows, submittedAt) {
  const sheet = recordSheet_();
  const values = sheet.getDataRange().getValues();
  // 由下往上刪除此人此月份的舊紀錄，保留其他人與其他月份
  for (let i = values.length - 1; i >= 1; i--) {
    if (Number(values[i][1]) === year && Number(values[i][2]) === month && values[i][3] === staff) {
      sheet.deleteRow(i + 1);
    }
  }
  if (sheet.getRange(1, RECORD_HEADER.length).getValue() === "") sheet.getRange(1, RECORD_HEADER.length).setValue(RECORD_HEADER[RECORD_HEADER.length - 1]);
  const newRows = rows.map(row => [
    submittedAt, year, month, staff, String(row.date),
    row.status === "請假" ? "請假" : "出勤",
    row.status === "請假" ? String(row.substitute || "").trim() : "",
    row.adjusted ? ADJUSTED_MARK : ""
  ]);
  if (newRows.length) {
    const start = sheet.getLastRow() + 1;
    sheet.getRange(start, 5, newRows.length, 1).setNumberFormat("@"); // 日期欄保持文字
    sheet.getRange(start, 1, newRows.length, RECORD_HEADER.length).setValues(newRows);
  }
}

function getMonth_(year, month) {
  const submissions = {};
  const values = recordSheet_().getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (Number(r[1]) !== year || Number(r[2]) !== month || STAFF.indexOf(r[3]) === -1) continue;
    const staff = r[3];
    if (!submissions[staff]) {
      submissions[staff] = { staff: staff, submitted: true, source: "v2", submittedAt: new Date(r[0]).toISOString(), rows: [] };
    }
    submissions[staff].rows.push({ date: toText_(r[4]), status: r[5], substitute: r[6] || "", adjusted: r[7] === ADJUSTED_MARK });
  }

  // 相容舊版：此月份沒有 v2 紀錄的人，改從既有月排班表反推
  const missing = STAFF.filter(name => !submissions[name]);
  if (missing.length) {
    const legacy = readLegacyMonthSheet_(year, month);
    missing.forEach(name => { if (legacy[name]) submissions[name] = legacy[name]; });
  }

  const calendar = getCalendar_();
  return { year: year, month: month, submissions: submissions, holidays: calendar.holidays, workdays: calendar.workdays,
    adjustments: getAdjustments_(year, month) };
}

function readLegacyMonthSheet_(year, month) {
  const sheet = ss_().getSheetByName(monthSheetName_(year, month));
  if (!sheet || sheet.getLastRow() < 2) return {};
  const values = sheet.getDataRange().getDisplayValues();
  const result = {};
  STAFF.forEach(name => {
    result[name] = { staff: name, submitted: true, source: "legacy", submittedAt: "", rows: [] };
  });
  for (let i = 1; i < values.length; i++) {
    const match = String(values[i][1]).match(/(\d+)月(\d+)日/);
    if (!match) continue;
    const date = year + "-" + ("0" + match[1]).slice(-2) + "-" + ("0" + match[2]).slice(-2);
    STAFF.forEach((name, index) => {
      const scheduled = String(values[i][3 + index] || "").trim();
      const isLeave = scheduled !== "" && scheduled !== name;
      result[name].rows.push({ date: date, status: isLeave ? "請假" : "出勤", substitute: isLeave ? scheduled : "" });
    });
  }
  return result;
}

function writeMonthSheet_(year, month, days, submissions, updateNote) {
  const ss = ss_();
  const name = monthSheetName_(year, month);
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name, 1);
  const cols = 6;
  const headerRow = 3;
  const body = [];
  const backgrounds = [];
  const fontColors = [];
  const fontWeights = [];
  const leaveItems = STAFF.map(() => []);

  days.forEach((day, index) => {
    const notes = [];
    const rowBg = [COLOR.white, COLOR.white, COLOR.white, COLOR.white, COLOR.white, COLOR.white];
    const rowColor = [COLOR.ink, COLOR.ink, COLOR.ink, COLOR.ink, COLOR.ink, COLOR.leaveText];
    const rowWeight = ["normal", "normal", "normal", "normal", "normal", "bold"];
    const names = STAFF.map((staff, s) => {
      const sub = submissions[staff];
      const row = sub && sub.rows.filter(r => r.date === day.date)[0];
      if (row && row.status === "請假") {
        notes.push(staff + (row.adjusted ? "臨時請假：" : "請假：") + row.substitute);
        leaveItems[s].push(shortDate_(day.label) + " " + row.substitute + "代" + (row.adjusted ? "（臨時）" : ""));
        rowBg[3 + s] = COLOR.leaveCell;
        rowWeight[3 + s] = "bold";
        return row.substitute;
      }
      return staff;
    });
    if (notes.length) {
      [0, 1, 2, 5].forEach(c => { rowBg[c] = COLOR.leaveRow; });
      rowWeight[1] = "bold";
    }
    body.push([index + 1, day.label, day.weekday, names[0], names[1], notes.join("\n")]);
    backgrounds.push(rowBg);
    fontColors.push(rowColor);
    fontWeights.push(rowWeight);
  });

  const summaryLines = STAFF.map((staff, s) => "● " + staff + "　請假 " + leaveItems[s].length + " 天" +
    (leaveItems[s].length ? "：" + leaveItems[s].join("、") : ""));
  summaryLines.push("最後更新：" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm") +
    (updateNote ? "（" + updateNote + "）" : ""));
  const totalLeave = leaveItems.reduce((sum, items) => sum + items.length, 0);

  // 重建前先清掉舊內容、格式與合併儲存格
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();

  sheet.getRange(1, 1, 1, cols).merge()
    .setValue((year - 1911) + "年" + month + "月 廚房計時人員排班表")
    .setFontSize(16).setFontWeight("bold").setFontColor(COLOR.title)
    .setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.getRange(2, 1, 1, cols).merge()
    .setValue(summaryLines.join("\n"))
    .setWrap(true).setFontSize(12).setVerticalAlignment("middle")
    .setFontColor(totalLeave ? COLOR.leaveText : COLOR.muted)
    .setBackground(totalLeave ? COLOR.summaryLeave : COLOR.summaryNone);
  sheet.setRowHeight(1, 36);
  sheet.setRowHeight(2, 22 * summaryLines.length + 10);

  sheet.getRange(headerRow, 1, 1, cols)
    .setValues([["序號", "日期", "星期", "排班 1", "排班 2", "代班人員"]])
    .setBackground(COLOR.header).setFontWeight("bold").setFontSize(13);

  if (body.length) {
    const range = sheet.getRange(headerRow + 1, 1, body.length, cols);
    range.setNumberFormat("@").setValues(body)
      .setBackgrounds(backgrounds).setFontColors(fontColors).setFontWeights(fontWeights)
      .setFontSize(12).setWrap(true);
    sheet.setRowHeights(headerRow + 1, body.length, 30);
  }

  const table = sheet.getRange(headerRow, 1, body.length + 1, cols);
  table.setHorizontalAlignment("center").setVerticalAlignment("middle")
    .setBorder(true, true, true, true, true, true, COLOR.border, SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeight(headerRow, 34);
  [56, 110, 56, 120, 120, 220].forEach((width, i) => sheet.setColumnWidth(i + 1, width));
  sheet.setFrozenRows(headerRow);
}

function shortDate_(label) {
  const match = String(label).match(/(\d+)月(\d+)日/);
  return match ? match[1] + "/" + match[2] : label;
}

// 由已存資料推回工作日清單（供「重新排版既有月份」使用）
function daysFromSubmissions_(year, submissions) {
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const dates = {};
  Object.keys(submissions).forEach(staff => submissions[staff].rows.forEach(r => { dates[r.date] = true; }));
  return Object.keys(dates).sort().map(date => {
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    return { date: date, label: m + "月" + d + "日", weekday: weekdays[new Date(year, m - 1, d).getDay()] };
  });
}

/**
 * 在 Apps Script 編輯器上方選擇此函式並按「執行」，
 * 會把試算表中所有「XXX年X月排班表」套用新排版（內容不變）。
 */
function reformatAllMonths() {
  ss_().getSheets().forEach(sheet => {
    const match = sheet.getName().match(/^(\d+)年(\d+)月排班表$/);
    if (!match) return;
    const year = Number(match[1]) + 1911;
    const month = Number(match[2]);
    const data = getMonth_(year, month);
    const days = daysFromSubmissions_(year, data.submissions);
    if (days.length) writeMonthSheet_(year, month, days, data.submissions, "重新排版");
  });
}

// 「假日設定」工作表：A 欄＝不供餐日期，B 欄＝週末要供餐的補班日
function getCalendar_() {
  const sheet = ss_().getSheetByName(HOLIDAY_SHEET);
  if (!sheet || sheet.getLastRow() < 1) return { holidays: [], workdays: [] };
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  const pick = col => values.map(r => toText_(r[col]).trim()).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v));
  return { holidays: pick(0), workdays: pick(1) };
}

function notify_(year, month, staff, rows) {
  try {
    const to = NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
    if (!to) return;
    const leaves = rows.filter(r => r.status === "請假");
    const lines = leaves.map(r => "・" + r.date + " 請假，代班：" + r.substitute);
    const subject = "【班表提交通知】" + (year - 1911) + "年" + month + "月 " + staff + " 已送出（請假 " + leaves.length + " 天）";
    const body = staff + " 已透過網頁提交 " + (year - 1911) + "年" + month + "月 的排班表。\n\n" +
      (lines.length ? lines.join("\n") : "本月無請假。") +
      "\n\n合併後班表：" + ss_().getUrl();
    MailApp.sendEmail(to, subject, body);
  } catch (error) {
    // 寄信失敗不影響資料寫入
  }
}

function notifyAdjust_(year, month, change) {
  try {
    const to = NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
    if (!to) return;
    MailApp.sendEmail(to, "【班表臨時異動】" + (year - 1911) + "年" + month + "月 " + change,
      "管理者已登記臨時異動：" + change + "\n\n如有代班，請記得產生臨時代班勞保通知單交總務處。\n\n合併後班表：" + ss_().getUrl());
  } catch (error) {
    // 寄信失敗不影響資料寫入
  }
}
