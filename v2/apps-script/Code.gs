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
const STAFF = ["溫美萍", "郭恒妘"];
const RECORD_HEADER = ["提交時間", "年", "月", "填表人", "日期", "狀態", "代班人員"];
const NOTIFY_EMAIL = ""; // 留空則寄給部署者本人

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (params.action === "month") {
      return json_({ status: "success", data: getMonth_(Number(params.year), Number(params.month)) });
    }
    return json_({ status: "success", data: { holidays: getHolidays_() } });
  } catch (error) {
    return json_({ status: "error", message: String(error) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const payload = JSON.parse(e.postData.contents);
    const year = Number(payload.year);
    const month = Number(payload.month);
    const staff = String(payload.submittedBy || "");
    if (!year || !month || STAFF.indexOf(staff) === -1 || !Array.isArray(payload.personalData) || !Array.isArray(payload.days)) {
      return json_({ status: "error", message: "資料格式不正確" });
    }

    const submittedAt = new Date();
    saveSubmission_(year, month, staff, payload.personalData, submittedAt);
    const monthData = getMonth_(year, month);
    writeMonthSheet_(year, month, payload.days, monthData.submissions);
    notify_(year, month, staff, payload.personalData);

    return json_({ status: "success", data: monthData });
  } catch (error) {
    return json_({ status: "error", message: String(error) });
  } finally {
    lock.releaseLock();
  }
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
  const newRows = rows.map(row => [
    submittedAt, year, month, staff, String(row.date),
    row.status === "請假" ? "請假" : "出勤",
    row.status === "請假" ? String(row.substitute || "").trim() : ""
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
    submissions[staff].rows.push({ date: toText_(r[4]), status: r[5], substitute: r[6] || "" });
  }

  // 相容舊版：此月份沒有 v2 紀錄的人，改從既有月排班表反推
  const missing = STAFF.filter(name => !submissions[name]);
  if (missing.length) {
    const legacy = readLegacyMonthSheet_(year, month);
    missing.forEach(name => { if (legacy[name]) submissions[name] = legacy[name]; });
  }

  return { year: year, month: month, submissions: submissions, holidays: getHolidays_() };
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

function writeMonthSheet_(year, month, days, submissions) {
  const ss = ss_();
  const name = monthSheetName_(year, month);
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name, 1);
  const output = [["序號", "日期", "星期", "排班 1", "排班 2", "代班人員"]];

  days.forEach((day, index) => {
    const notes = [];
    const names = STAFF.map(staff => {
      const sub = submissions[staff];
      const row = sub && sub.rows.filter(r => r.date === day.date)[0];
      if (row && row.status === "請假") {
        notes.push(staff + "請假：" + row.substitute);
        return row.substitute;
      }
      return staff;
    });
    output.push([index + 1, day.label, day.weekday, names[0], names[1], notes.join("；")]);
  });

  sheet.clearContents();
  sheet.getRange(1, 1, output.length, output[0].length).setNumberFormat("@").setValues(output);
}

function getHolidays_() {
  const sheet = ss_().getSheetByName(HOLIDAY_SHEET);
  if (!sheet || sheet.getLastRow() < 1) return [];
  return sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues()
    .map(r => toText_(r[0]).trim())
    .filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v));
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
