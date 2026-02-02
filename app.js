// app.js
// ✅ 你只要改這裡：換成你的 Apps Script /exec URL
const API_URL = "https://script.google.com/macros/s/AKfycbzwEAj6nG_MdvHoMWJ_KrggB17o15xiIgWyo-zosvLLbrHb87Fabs6leAb9CIQJ6soS/exec";

// 小工具：避免 XSS / 亂碼
function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}
function fmt(n){
  return Number(n || 0).toLocaleString("zh-Hant-TW");
}
