// 在公文系統頁面上執行：解析目前文件的公文文號/發文字號/主旨/日期，
// 回報給 background，background 再用這份資料攔截後續的下載並改檔名。
//
// 這個頁面把本文內容放在 iframe 裡，外層（標題列）跟裡層（本文）是不同的
// document，各自只看得到自己框架內的文字。所以這支 script 用 all_frames
// 注入到每一層 frame，每一層各自抓自己看得到的欄位、把「找到的部分」回報
// 給 background，由 background 合併成完整資訊（見 background.js 的合併邏輯）。
//
// 實測發現：這個編輯器的「受文者：」「發文日期：」「發文字號：」「速別：」
// 「附件：」「主旨：」「說明：」等標籤都是版面樣式（CSS）畫出來的，不是真的
// HTML 文字，innerText 只讀得到「值」本身，讀不到標籤。所以沒辦法用「標籤:值」
// 的方式抓欄位，改成：
// - 發文字號：不管有沒有標籤，本身格式固定是「XX字第YYYY號」，直接抓這個格式，
//   取文章中第一個符合的（後面說明段落引用其他機關文號也會符合，但那些一定
//   出現在更後面，所以取第一個通常就是本文自己的發文字號）
// - 發文日期：抓「中華民國Ｎ年Ｎ月Ｎ日」格式，一樣取第一個出現的
// - 主旨：沒有標籤可以定位，改成「找到發文字號那一行之後，往下找第一個不是
//   速別關鍵字、不是附件說明（含『如說明』或副檔名字樣）、而且夠長的一行」
//   當作主旨。這是用位置＋格式特徵去猜，不是每種公文格式都保證準，需要多測
//   幾種公文類型校正。
// - 民國年一律轉西元年（+1911）

const SPEED_KEYWORDS = /^(最速件|速件|普通件|密件|極機密|機密|密)$/;
const ATTACHMENT_HINT = /如說明|附件|\.pdf|\.docx?|\.tif/i;

function extractDocFields() {
  const text = document.body.innerText || "";
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const docNoMatch = text.match(/公文文號[:：]\s*([^\s（(]+)/);

  const issueNoMatch = text.match(
    /([一-鿿A-Za-z0-9（）()]{1,14}字第[0-9A-Za-z]+號)/
  );
  const issueNo = issueNoMatch ? issueNoMatch[1] : "";

  const dateMatch = text.match(
    /中華民國\s*(\d{1,3})年(\d{1,2})月(\d{1,2})日/
  );
  let dateStr = "";
  if (dateMatch) {
    const y = parseInt(dateMatch[1], 10) + 1911;
    const m = dateMatch[2].padStart(2, "0");
    const d = dateMatch[3].padStart(2, "0");
    dateStr = `${y}${m}${d}`;
  }

  // 主旨沒有欄位標籤可以定位，用「找到一個錨點之後，往下找第一個不是速別
  // 關鍵字、不是附件說明、而且夠長的一行」當主旨。優先用發文字號當錨點
  // （「函」這類已經發文的文件都有「XX字第YYYY號」）；但「以稿代簽」這種
  // 還沒發文、只在簽稿階段的文件沒有發文字號，這時候退而求其次改用發文
  // 日期（「中華民國Ｎ年Ｎ月Ｎ日」）那一行當錨點——實測這種文件的主旨
  // 一樣會出現在日期後面幾行（日期 → 承辦處室 → 簽稿類別 → 主旨）。沒有
  // 這兩種錨點的話主旨留空，不硬猜。
  let subject = "";
  const anchorText = issueNo || (dateMatch ? dateMatch[0] : "");
  if (anchorText) {
    const idx = lines.findIndex((l) => l.includes(anchorText));
    if (idx !== -1) {
      for (let i = idx + 1; i < lines.length && i < idx + 6; i++) {
        const line = lines[i];
        if (SPEED_KEYWORDS.test(line)) continue;
        if (ATTACHMENT_HINT.test(line)) continue;
        if (line.length < 6) continue;
        subject = line;
        break;
      }
    }
  }

  return {
    docNo: docNoMatch ? docNoMatch[1] : "",
    issueNo,
    subject,
    dateStr,
  };
}

// 「查詢以往歷年公文」這種清單頁是例外情況：整頁就是一個表格，沒有 iframe
// 本文，選取某一列之後下方分頁會列出該筆的電子檔案，點檔名連結會直接觸發
// 下載（不會經過「匯出PDF」那個流程）。這種頁面沒有「XX字第YYYY號」「中華
// 民國Ｎ年Ｎ月Ｎ日」這種本文格式可以套用 extractDocFields()，所以另外寫一套：
// 直接從清單表格裡，找「目前選取的這一列」，抓它的文號／主旨／日期欄位。
//
// 「目前選取的是哪一列」用下方電子檔案分頁裡「公文文號」那個單選鈕旁顯示
// 的號碼反查：這個號碼在整頁文字裡通常不只出現一次（清單表格的欄位標題
// 也叫「公文文號」），但分頁裡的這個值一定是全頁最後一個出現的「公文文號」
// 字樣，所以用全域比對、取最後一個符合的。
function extractHistoricalListFields() {
  const bodyText = document.body.innerText || "";
  const matches = [...bodyText.matchAll(/公文文號[^\d]{0,20}(\d{9,12})/g)];
  if (!matches.length) return null;
  const targetDocNo = matches[matches.length - 1][1];

  const rows = document.querySelectorAll("tr");
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll("td, th"));
    if (cells.length < 4) continue;
    const cellTexts = cells.map((c) => (c.innerText || "").trim());
    if (!cellTexts.includes(targetDocNo)) continue;

    // 一列裡通常有兩個 ROC 日期欄（例如收文日期／歸檔日期），只要比較早的
    // 那一個當收文日期；轉成西元 YYYYMMDD 後字串排序就是日期先後排序。
    const dateStrs = cellTexts
      .filter((t) => /^\d{2,3}\/\d{1,2}\/\d{1,2}$/.test(t))
      .map(rocDateToWestern)
      .filter(Boolean)
      .sort();
    const dateStr = dateStrs[0] || "";

    // 主旨欄沒有固定的欄位標籤可以定位，用「這一列裡扣掉文號跟日期欄之後
    // 最長的一段文字」當主旨——序號/收發別/歸檔狀態/承辦處室/承辦人這些
    // 欄位都是短字詞，主旨一定明顯長很多。
    // 主旨欄位保留原始文字（不在這裡精簡），精簡邏輯統一放在
    // background.js 的 computeNames()，跟編輯頁面共用同一套規則。
    const subject = cellTexts
      .filter((t) => t !== targetDocNo && !/^\d{2,3}\/\d{1,2}\/\d{1,2}$/.test(t))
      .sort((a, b) => b.length - a.length)[0] || "";

    console.log("[公文小工具][歷年公文清單] 目前選取列：", {
      targetDocNo,
      subject,
      dateStr,
      cellTexts,
    });

    return { docNo: targetDocNo, issueNo: "", subject, dateStr };
  }
  console.log("[公文小工具][歷年公文清單] 抓到文號 " + targetDocNo + " 但清單表格裡找不到對應列");
  return null;
}

function rocDateToWestern(rocDate) {
  const m = rocDate.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return "";
  const y = parseInt(m[1], 10) + 1911;
  const mo = m[2].padStart(2, "0");
  const d = m[3].padStart(2, "0");
  return `${y}${mo}${d}`;
}

function reportFields() {
  const text = document.body.innerText || "";

  // 先試「查詢以往歷年公文」清單頁那套：找到「目前選取的這一列」是很明確、
  // 專屬於那個頁面版型的訊號，找到了就直接採用，不要再讓 extractDocFields()
  // 插手——它的「XX字第YYYY號」規則很寬鬆，在這種清單頁上很容易因為主旨或
  // 附件說明裡剛好出現類似格式的文字（例如引用到其他機關文號）而誤判，把
  // 抓到的文號/附件命名污染成一段主旨文字。在原本的編輯頁面上，清單頁的
  // 表格結構找不到、一定回傳 null，所以這裡完全不影響原本頁面的行為。
  const histFields = extractHistoricalListFields();
  let fields = histFields || extractDocFields();
  let hasAnything = fields.docNo || fields.issueNo || fields.subject || fields.dateStr;

  // 診斷用：先把這一層 frame 實際讀到的完整文字印出來，
  // 之後確認抓取邏輯穩定了可以整段刪掉。
  console.log(
    "[公文小工具][診斷] frame=" + location.href,
    " textLength=" + text.length,
    " 全文=", JSON.stringify(text)
  );

  if (!hasAnything) return; // 這一層 frame 沒看到任何相關欄位，不用回報

  console.log("[公文小工具] (" + location.href + ") 這一層抓到：", fields);

  chrome.runtime.sendMessage({
    type: "DOC_FIELDS",
    payload: fields,
  });
}

// 本文常是非同步載入（AJAX 把內容塞進 iframe），
// 所以先立刻抓一次，再用 MutationObserver 監聽一段時間，抓到內容變化就重抓。
reportFields();

let debounceTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(reportFields, 500);
});
observer.observe(document.body, { childList: true, subtree: true, characterData: true });

// 10 分鐘後停止觀察，避免長時間掛著的分頁持續耗效能
setTimeout(() => observer.disconnect(), 10 * 60 * 1000);

// 用「點擊當下是不是點在匯出PDF上」來告訴 background 接下來的下載該怎麼命名，
// 不要再用「第幾個下載」去猜——因為背景程式（service worker）閒置一陣子會被
// Chrome 關掉重開，計數器會被重置，猜的順序就會跟實際不一樣（之前踩到的坑）。
document.addEventListener(
  "click",
  (e) => {
    // 「是不是匯出PDF」一定要先判斷，不能被下面的「看起來像按鈕」篩選條件擋住——
    // 這個下拉選單的項目不一定是 <button>/<a>/<li>，篩選條件太嚴格會讓這個判斷
    // 完全沒機會執行，之前就是這樣導致點匯出PDF卻被當成附件命名。
    let isExportPdf = false;
    let check = e.target;
    for (let i = 0; i < 8 && check; i++, check = check.parentElement) {
      if ((check.textContent || "").trim() === "匯出PDF") {
        isExportPdf = true;
        break;
      }
    }

    if (isExportPdf) {
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_INTENT",
        payload: { kind: "body" },
      });
      return;
    }

    // 不是匯出PDF的話，才用「看起來像按鈕/連結」這個條件過濾雜訊
    // （避免打字、選字這種跟下載無關的點擊也一直觸發訊息）。
    const interactive = e.target.closest(
      'button, a, li, [class*="btn"], [data-speed-action], [data-speed-id], [data-speed-editstyle]'
    );
    if (!interactive) return;

    chrome.runtime.sendMessage({
      type: "DOWNLOAD_INTENT",
      payload: { kind: "attachment" },
    });
  },
  true
);

// 「下載所有附件」給的是一個 .zip，background 需要重新抓一次同一個網址的資料
// 才能解壓縮，但一定要用這個頁面自己發的請求（帶有正確的登入 session/來源資訊），
// 背景程式自己 fetch 會被伺服器拒絕（實測回 HTTP 500）。這裡負責代為抓取。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FETCH_FOR_EXTRACT") {
    fetch(msg.url, { credentials: "same-origin" })
      .then((resp) => {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.arrayBuffer();
      })
      .then((buffer) => sendResponse({ ok: true, buffer }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 非同步回覆
  }
  return false;
});
