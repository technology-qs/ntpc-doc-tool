// 共用的檔名淨化邏輯：content.js 用 <script> 順序載入，background.js 用 importScripts() 載入

// 公文主旨的原始文字通常是完整的一句話（例如「本校辦理教育部『國中小素養
// 導向之AI素養教學推動計畫』中心學校推廣工作坊，敬請惠允出席人員（差）假
// 登記及人事派代，請查照。」），直接拿來當資料夾/檔名太長又含冗字。
// 精簡規則：取「第一個｢之後、第一個，之前」這段當精簡主旨（這段中間如果
// 還有｣會被拿掉）；抓不到這個模式（沒有｢或後面沒有，）就整句照用。
// 在 background.js 的 computeNames() 統一套用，這樣不管主旨是從編輯頁面
// （extractDocFields）還是歷年公文清單頁（extractHistoricalListFields）
// 抓到的，命名規則都一致。
function refineSubjectFromBrackets(raw) {
  if (!raw) return raw;
  const start = raw.indexOf("「");
  if (start === -1) return raw;
  const halfWidthComma = raw.indexOf(",", start + 1);
  const fullWidthComma = raw.indexOf("，", start + 1);
  const commaIdx =
    halfWidthComma === -1
      ? fullWidthComma
      : fullWidthComma === -1
      ? halfWidthComma
      : Math.min(halfWidthComma, fullWidthComma);
  if (commaIdx === -1) return raw;
  const core = raw.slice(start + 1, commaIdx).replace(/[「」]/g, "").trim();
  return core || raw;
}

function sanitizeFilePart(str, maxLen) {
  if (!str) return "未命名";
  let s = String(str).replace(/[\r\n\t]+/g, "").trim();
  const map = {
    "\\": "＼",
    "/": "／",
    ":": "：",
    "*": "＊",
    "?": "？",
    '"': "＂",
    "<": "＜",
    ">": "＞",
    "|": "｜",
  };
  s = s.replace(/[\\/:*?"<>|]/g, (c) => map[c] || "_");
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/[\s.]+$/g, "");
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s || "未命名";
}
