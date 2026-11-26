// 排班行事曆：排班系統 (v2) 與管理入口 (portal) 共用。改日期只要改這個檔。
// 薪資工具 worktool3 的 assets/app.js 另有一份假日與寒暑假，日期異動時要一起改。

// 國定假日（平日放假的日子），依行政院人事行政總處「政府行政機關辦公日曆表」
const nationalHolidays = {
    "2026-01-01": "元旦", "2026-02-16": "除夕", "2026-02-17": "春節", "2026-02-18": "春節", "2026-02-19": "春節",
    "2026-02-20": "春節", "2026-02-27": "和平紀念日補假", "2026-04-03": "兒童節補假", "2026-04-06": "清明節補假",
    "2026-05-01": "勞動節", "2026-06-19": "端午節", "2026-09-25": "中秋節", "2026-09-28": "教師節",
    "2026-10-09": "國慶日補假", "2026-10-26": "臺灣光復節補假", "2026-12-25": "行憲紀念日",
    "2027-01-01": "開國紀念日", "2027-02-04": "小年夜", "2027-02-05": "除夕", "2027-02-08": "春節",
    "2027-02-09": "春節補假", "2027-02-10": "春節補假", "2027-03-01": "和平紀念日補假", "2027-04-05": "清明節",
    "2027-04-06": "兒童節補假", "2027-04-30": "勞動節補假", "2027-06-09": "端午節", "2027-09-15": "中秋節",
    "2027-09-28": "教師節", "2027-10-11": "國慶日補假", "2027-10-25": "臺灣光復節", "2027-12-24": "行憲紀念日補假",
    "2027-12-31": "補假"
};
// 寒暑假不供餐（含頭尾）。暑假未列出的年份，沿用 7/1～8/30 不排班
const schoolBreaks = [
    { start: "2026-07-01", end: "2026-08-30", name: "暑假" },
    { start: "2027-01-21", end: "2027-02-10", name: "寒假", resume: "2027-02-11" }
];
// 學校活動造成的供餐異動：serve 為 true 表示週末需供餐，false 表示平日不供餐；會顯示在該月份備註
const schoolEvents = [
    { date: "2026-12-14", serve: false, note: "由本校廚工出勤，臨時人員不用出勤" },
    { date: "2026-12-19", serve: false, note: "五福國小校慶，由廠商送披薩，臨時人員不用出勤" },
    { date: "2026-12-21", serve: false, note: "校慶補休，臨時人員不用出勤" }
];
const builtInHolidays = Object.keys(nationalHolidays)
    .concat(schoolEvents.filter(event => !event.serve).map(event => event.date));
const builtInWorkdays = schoolEvents.filter(event => event.serve).map(event => event.date);

function toDateString(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getSchoolBreak(date) {
    const dateString = toDateString(date);
    const listed = schoolBreaks.find(item => dateString >= item.start && dateString <= item.end);
    if (listed) return listed;
    const year = date.getFullYear();
    const summerListed = schoolBreaks.some(item => item.name === "暑假" && item.start.startsWith(String(year)));
    if (!summerListed && dateString >= `${year}-07-01` && dateString <= `${year}-08-30`) {
        return { start: `${year}-07-01`, end: `${year}-08-30`, name: "暑假" };
    }
    return null;
}

// 是否排臨時人員：extra 為試算表「假日設定」的額外假日與補班日
function isServiceDay(date, extraHolidays = [], extraWorkdays = []) {
    const dateString = toDateString(date);
    if (builtInWorkdays.includes(dateString) || extraWorkdays.includes(dateString)) return true;
    if (date.getDay() === 0 || date.getDay() === 6) return false;
    if (builtInHolidays.includes(dateString) || extraHolidays.includes(dateString)) return false;
    return !getSchoolBreak(date);
}

function getServiceDays(year, month, extraHolidays = [], extraWorkdays = []) {
    const days = [];
    for (let day = 1; day <= new Date(year, month, 0).getDate(); day++) {
        const date = new Date(year, month - 1, day);
        if (isServiceDay(date, extraHolidays, extraWorkdays)) days.push(date);
    }
    return days;
}

// 班表截止：前一個月最後一個供餐日的中午 12:00（寒假前就要交開學那個月的班表）
function getSubmissionDeadline(year, month, extraHolidays = [], extraWorkdays = []) {
    const date = new Date(year, month - 1, 0);
    while (!isServiceDay(date, extraHolidays, extraWorkdays)) date.setDate(date.getDate() - 1);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
}
