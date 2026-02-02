// app.js：共用工具（入口/查詢/管理都可以用）

// ✅ 你只要改這個：換成你 Apps Script /exec
const API_URL = "https://script.google.com/macros/s/AKfycbzwEAj6nG_MdvHoMWJ_KrggB17o15xiIgWyo-zosvLLbrHb87Fabs6leAb9CIQJ6soS/exec"; // ← 改這裡

// 方便抓元素
const $ = (id) => document.getElementById(id);

// 安全轉義（避免有人輸入奇怪字元把頁面弄壞）
function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

// 數字格式化（1,234）
function fmt(n){
  return Number(n || 0).toLocaleString("zh-Hant-TW");
}

// fetch 後嘗試 parse JSON；失敗就回傳 raw（很適合 debug）
async function safeJson(res){
  const text = await res.text();
  try{
    return { ok:true, json: JSON.parse(text) };
  }catch(e){
    return { ok:false, raw:text };
  }
}

// 按鈕 loading 狀態（顯示 spinner、避免連點）
function setBtnLoading(btn, on){
  btn.disabled = on;
  btn.classList.toggle("loading", on);
}
