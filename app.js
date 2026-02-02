// app.js
// ✅ 你只要改這裡：換成你的 Apps Script /exec URL
const API_URL = "PASTE_YOUR_APPS_SCRIPT_EXEC_URL_HERE";

// 小工具：避免 XSS / 亂碼
function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}
function fmt(n){
  return Number(n || 0).toLocaleString("zh-Hant-TW");
}
