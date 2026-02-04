// app.js（最小可用版）
// 1) 把你的 GAS Web App 連結貼進來
//    長得像：https://script.google.com/macros/s/XXXXX/exec
window.API_URL = "https://script.google.com/macros/s/AKfycbzwEAj6nG_MdvHoMWJ_KrggB17o15xiIgWyo-zosvLLbrHb87Fabs6leAb9CIQJ6soS/exec";

// 2) HTML escape，避免 XSS/亂碼
window.esc = function (val) {
  const s = String(val ?? "");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

// 3) 金額格式化
window.fmt = function (n) {
  const num = Number(n || 0);
  return num.toLocaleString("zh-TW");
};
