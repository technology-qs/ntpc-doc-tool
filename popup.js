chrome.runtime.sendMessage({ type: "GET_CONTEXT" }, (ctx) => {
  const el = document.getElementById("content");
  if (!ctx) {
    el.innerHTML = '<p class="empty">目前沒有擷取到任何文件資訊。請先開啟一份公文頁面。</p>';
    return;
  }
  const age = Math.round((Date.now() - ctx.capturedAt) / 1000);
  el.innerHTML = `
    <div class="row"><span class="label">資料夾名稱：</span><div class="value">${ctx.folderName}</div></div>
    <div class="row"><span class="label">檔案基底名稱：</span><div class="value">${ctx.fileBaseName}</div></div>
    <div class="row"><span class="label">擷取時間：</span><span class="value">${age} 秒前</span></div>
  `;
});
