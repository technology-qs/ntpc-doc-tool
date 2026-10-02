importScripts("common.js", "vendor/jszip.min.js");

const BASE_FOLDER = "新北市公文";
const CONTEXT_TTL_MS = 15 * 60 * 1000;
// 點「匯出PDF」之後幾秒內觸發的下載，才算是本文匯出；超過這個時間就當作跟這次點擊無關
const INTENT_TTL_MS = 8 * 1000;
// 「檔案處理」下拉選單關閉自己時會另外觸發一兩次雜訊點擊，緊接在真正點到
// 「匯出PDF」之後（見 content.js 的說明），用這個很短的窗期吸收掉那個雜訊
// 就夠了。不能沿用上面的 INTENT_TTL_MS（8秒）——那是給「下載觸發時，這個
// 下載還算不算是本文匯出」用的，如果拿來當雜訊吸收窗期，會連使用者匯出
// 本文後緊接著手動點的、真正的附件下載都一起吸收掉，導致那個附件被誤套用
// 本文的命名（文號+主旨），而不是「文號_附件N」（實測踩過這個坑，2026-09-22）。
const BODY_NOISE_SUPPRESS_MS = 1.5 * 1000;

const EMPTY_DOC = { docNo: "", issueNo: "", subject: "", dateStr: "", attachmentCount: 0 };

// service worker 在閒置一段時間後會被 Chrome 關掉、下次事件觸發時重開，
// 所有一般變數（let/const 宣告的）都會被重置成初始值。用 chrome.storage.session
// 存狀態才能撐過這種重開（session 儲存不會寫到硬碟，關瀏覽器就清空，跟一般變數
// 差在「活得比 service worker 久」）。
async function getState() {
  const { currentDoc, capturedAt, lastIntent } = await chrome.storage.session.get([
    "currentDoc",
    "capturedAt",
    "lastIntent",
  ]);
  return {
    currentDoc: currentDoc || { ...EMPTY_DOC },
    capturedAt: capturedAt || 0,
    lastIntent: lastIntent || null,
  };
}

async function setState(partial) {
  await chrome.storage.session.set(partial);
}

async function mergeFields(payload) {
  const { currentDoc } = await getState();
  const isNewDoc =
    payload.docNo && currentDoc.docNo && payload.docNo !== currentDoc.docNo;

  const base = isNewDoc ? { ...EMPTY_DOC } : currentDoc;
  const next = { ...base };

  // content.js 用 all_frames 注入到頁面上每一層 frame，同一個分頁裡可能還有
  // 跟目前公文完全無關的其他 frame（例如入口網站的公告/憑證安裝說明），裡面
  // 的文字剛好也符合「XX字第YYYY號」這種發文字號格式，會被 extractDocFields()
  // 誤判成一份公文回報上來。這種報告沒有自己的文號，如果目前已經鎖定某個
  // 文號了，只讓它「補空欄位」，不能覆蓋已經抓到的正確值——不然它到達的時間
  // 只要晚於正確的那份報告，就會把已經抓對的文號/主旨蓋掉（實測踩過這個坑：
  // 查歷年公文清單頁抓到正確資料後，被同頁的 cloud2.ntpc.gov.tw/home 公告
  // iframe 蓋掉，2026-09-22）。
  // 還沒鎖定任何文號時（base.docNo 是空的），或這份報告本身帶的文號跟目前
  // 鎖定的一致，才信任它可以覆蓋——這也是原本編輯頁面「多個 frame 各自回報
  // 部分欄位」能夠正常合併的情況，不受影響。
  const sameDocOrUnlocked =
    !base.docNo || (payload.docNo && payload.docNo === base.docNo);

  for (const key of ["docNo", "issueNo", "subject", "dateStr"]) {
    if (!payload[key]) continue;
    if (sameDocOrUnlocked || !next[key]) next[key] = payload[key];
  }

  await setState({ currentDoc: next, capturedAt: Date.now() });
  console.log("[公文小工具] 合併後的文件資訊：", next);
}

function computeNames(currentDoc) {
  const fileBaseKey = currentDoc.issueNo || currentDoc.docNo || "未編號公文";
  const subject = refineSubjectFromBrackets(currentDoc.subject);
  const folderName = `${currentDoc.dateStr || "未知日期"}_${sanitizeFilePart(
    subject,
    60
  )}`;
  const fileBaseName = `${sanitizeFilePart(fileBaseKey, 40)}_${sanitizeFilePart(
    subject,
    60
  )}`;
  return { folderName, fileBaseName };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "DOC_FIELDS") {
    const tabId = sender.tab && sender.tab.id;
    mergeFields(msg.payload)
      .then(() => (tabId ? setState({ lastTabId: tabId }) : Promise.resolve()))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.type === "DOWNLOAD_INTENT") {
    console.log("[公文小工具] 收到下載意圖：", msg.payload);
    (async () => {
      const { lastIntent } = await getState();
      const now = Date.now();
      const freshBody =
        lastIntent && lastIntent.kind === "body" && now - lastIntent.ts < BODY_NOISE_SUPPRESS_MS;

      if (msg.payload.kind === "attachment" && freshBody) {
        // 忽略：這很可能是下拉選單自己關閉時觸發的雜訊點擊，
        // 不要蓋掉剛剛才記錄到的「匯出PDF」訊號
        console.log("[公文小工具] 忽略雜訊點擊，維持剛剛的 body 訊號");
      } else {
        await setState({ lastIntent: { kind: msg.payload.kind, ts: now } });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg && msg.type === "GET_CONTEXT") {
    getState().then(({ currentDoc, capturedAt }) => {
      if (!capturedAt) {
        sendResponse(null);
      } else {
        const { folderName, fileBaseName } = computeNames(currentDoc);
        sendResponse({ folderName, fileBaseName, capturedAt });
      }
    });
    return true;
  }
  return false;
});

// 「下載所有附件」這顆系統按鈕給的是一個包好所有附件的 .zip，不是個別檔案。
// 這裡請公文頁面本身（content script）重新抓一次同一個網址的原始 zip 資料——
// 一定要用頁面自己發的請求，不能用背景程式（service worker）自己 fetch，
// 因為背景程式發出的請求沒有正確的來源頁面資訊，伺服器會直接回 HTTP 500。
// 抓到資料後傳回背景程式解壓縮，把裡面每個檔案個別存成 {發文字號或公文文號}_附件N，
// 編號接續現有的附件計數。
async function fetchZipViaContentScript(zipUrl) {
  const { lastTabId } = await chrome.storage.session.get(["lastTabId"]);
  if (!lastTabId) throw new Error("找不到公文分頁，無法重新抓取 zip");

  const res = await chrome.tabs.sendMessage(lastTabId, {
    type: "FETCH_FOR_EXTRACT",
    url: zipUrl,
  });
  if (!res || !res.ok) {
    throw new Error("頁面抓取 zip 失敗：" + (res && res.error ? res.error : "未知錯誤"));
  }
  return res.buffer;
}

async function extractZipAndDownloadEntries(zipUrl, currentDoc, folderName) {
  try {
    const buf = await fetchZipViaContentScript(zipUrl);
    const zip = await JSZip.loadAsync(buf);
    const docNoKey = currentDoc.issueNo || currentDoc.docNo || "未編號公文";

    let count = currentDoc.attachmentCount || 0;
    const entries = Object.values(zip.files).filter((f) => !f.dir);

    for (const entry of entries) {
      const base64 = await entry.async("base64");
      const extMatch = entry.name.match(/\.[a-zA-Z0-9]+$/);
      const ext = extMatch ? extMatch[0] : "";
      count++;
      const filename = `${BASE_FOLDER}/${folderName}/${sanitizeFilePart(
        docNoKey,
        40
      )}_附件${count}${ext}`;

      await chrome.downloads.download({
        url: `data:application/octet-stream;base64,${base64}`,
        filename,
        conflictAction: "uniquify",
      });
      console.log("[公文小工具] 從 zip 解壓存檔：", entry.name, "→", filename);
    }

    await setState({ currentDoc: { ...currentDoc, attachmentCount: count } });
    console.log("[公文小工具] zip 解壓完成，共", entries.length, "個檔案");
  } catch (err) {
    console.error("[公文小工具] zip 解壓失敗：", err);
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    const { currentDoc, capturedAt, lastIntent } = await getState();
    if (!capturedAt) return suggest();

    if (Date.now() - capturedAt > CONTEXT_TTL_MS) {
      await setState({ currentDoc: { ...EMPTY_DOC }, capturedAt: 0 });
      return suggest();
    }

    const fromOurDomain =
      (item.url && /ntpc\.gov\.tw/i.test(item.url)) ||
      (item.referrer && /ntpc\.gov\.tw/i.test(item.referrer));
    if (!fromOurDomain) return suggest();

    const { folderName, fileBaseName } = computeNames(currentDoc);
    const docNoKey = currentDoc.issueNo || currentDoc.docNo || "未編號公文";

    const isZip =
      /\.zip$/i.test(item.filename) || (item.mime && /zip/i.test(item.mime));
    if (isZip) {
      // 不要把這個 zip 本身存下來：讓它先用預設名稱短暫落地，馬上取消，
      // 改成自己重抓同一個網址、解壓縮成個別檔案分開存。
      suggest();
      chrome.downloads.cancel(item.id).catch(() => {});
      extractZipAndDownloadEntries(item.url, currentDoc, folderName).catch((err) =>
        console.error("[公文小工具] zip 處理失敗：", err)
      );
      return;
    }

    const extMatch = item.filename.match(/\.[a-zA-Z0-9]+$/);
    const ext = extMatch ? extMatch[0] : ".pdf";

    const isBody =
      lastIntent &&
      lastIntent.kind === "body" &&
      Date.now() - lastIntent.ts < INTENT_TTL_MS;

    let finalName;
    if (isBody) {
      // 剛剛點的是「匯出PDF」，這個下載算本文
      finalName = `${BASE_FOLDER}/${folderName}/${fileBaseName}${ext}`;
    } else {
      // 沒有收到「匯出PDF」的訊號，當作附件處理
      const nextCount = (currentDoc.attachmentCount || 0) + 1;
      finalName = `${BASE_FOLDER}/${folderName}/${sanitizeFilePart(
        docNoKey,
        40
      )}_附件${nextCount}${ext}`;
      await setState({ currentDoc: { ...currentDoc, attachmentCount: nextCount } });
    }

    console.log(
      "[公文小工具] 改名下載：",
      item.filename,
      "→",
      finalName,
      " intent=",
      lastIntent
    );
    suggest({ filename: finalName, conflictAction: "uniquify" });
  })();
  return true; // 非同步呼叫 suggest()，要回傳 true 告訴 Chrome 等我們
});
