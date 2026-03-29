import React, { useEffect, useMemo, useRef, useState } from "react";
import Tesseract from "tesseract.js";
import "./App.css";

function normalizeLine(s) {
  return (s || "")
    .replace(/\u200f|\u200e/g, "")
    .replace(/[•·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  const radius = typeof r === "number" ? { tl: r, tr: r, br: r, bl: r } : r;
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + w - radius.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius.tr);
  ctx.lineTo(x + w, y + h - radius.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius.br, y + h);
  ctx.lineTo(x + radius.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function formatTime(d = new Date()) {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "م" : "ص";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function wrapLines(ctx, text, maxWidth) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const test = (line ? line + " " : "") + words[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = words[i];
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function hasLetters(s) {
  return /[A-Za-z\u0600-\u06FF]/.test(s);
}

function pickTimeToken(s) {
  const t = normalizeLine(s);
  const m1 = t.match(/(\d{1,2}:\d{2}\s*[صم]?)/);
  if (m1) return normalizeLine(m1[1]);
  if (t.includes("أمس")) return "أمس";
  if (t.includes("اليوم")) return "اليوم";
  const m2 = t.match(/(\d+\s*(h|hr|hrs|m|min|s|sec))\b/i);
  if (m2) return m2[1].replace(/\s+/g, "");
  return "";
}

function looksLikeNameLine(line) {
  const t = normalizeLine(line);
  if (!t) return false;
  const l = t.toLowerCase();
  if (l.includes("you:")) return false;
  if (!hasLetters(t) && !t.includes("+")) return false;
  if (t.length > 45) return false;
  return true;
}

function looksLikeNoise(line) {
  const t = normalizeLine(line);
  if (!t) return true;
  const l = t.toLowerCase();
  if (l === "you:" || l.startsWith("you:")) return true;
  if (l.includes("seen") || l.includes("ago")) return true;
  if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(t)) return true;
  return false;
}

function preprocessForOCR(imgEl, opts) {
  const { scale = 3, threshold = 175 } = opts || {};
  const sw = imgEl.naturalWidth;
  const sh = imgEl.naturalHeight;

  const W = Math.floor(sw * scale);
  const H = Math.floor(sh * scale);

  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(imgEl, 0, 0, sw, sh, 0, 0, W, H);

  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    v = v > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return c.toDataURL("image/png");
}

function extractPhonesFromLine(line) {
  const t = normalizeLine(line).replace(/\s+/g, " ");
  const out = [];
  const re = /(\+?\d[\d\s]{7,}\d)/g;
  let m;
  while ((m = re.exec(t))) {
    const raw = m[1];
    const compact = raw.replace(/\s+/g, "");
    const digitsCount = (compact.match(/\d/g) || []).length;
    if (digitsCount < 9) continue;
    let cleaned = compact.replace(/[^\d+]/g, "");
    if (cleaned.startsWith("+200")) cleaned = "+20" + cleaned.slice(4);
    out.push(cleaned);
  }
  return [...new Set(out)];
}

function parseConversationsFromRawText(rawText) {
  const lines = (rawText || "")
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean);

  const convos = [];
  let current = null;

  for (const line of lines) {
    if (looksLikeNoise(line)) continue;

    if (looksLikeNameLine(line)) {
      if (current && current.title) convos.push(current);
      current = { title: line, preview: "", time: "", rawLines: [line], phone: "" };
      continue;
    }

    if (!current) continue;

    current.rawLines.push(line);

    const tk = pickTimeToken(line);
    if (tk && !current.time) current.time = tk;

    if (!current.preview) current.preview = line;
    else if (current.preview.length < 100) current.preview = normalizeLine(current.preview + " " + line);
  }

  if (current && current.title) convos.push(current);

  return convos.map((c) => {
    const phones = [
      ...extractPhonesFromLine(c.title),
      ...extractPhonesFromLine(c.preview),
      ...c.rawLines.flatMap(extractPhonesFromLine),
    ];
    const phone = phones[0] || "";
    const title = normalizeLine(c.title);
    return { ...c, title, phone };
  });
}

function parsePhoneLines(digitsText) {
  const lines = (digitsText || "")
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean);

  const phoneLines = [];
  for (const ln of lines) {
    const phones = extractPhonesFromLine(ln);
    for (const p of phones) phoneLines.push(p);
  }

  const seen = new Set();
  const out = [];
  for (const p of phoneLines) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function attachPhonesSmart(convos, phonePool) {
  const used = new Set(convos.map((c) => c.phone).filter(Boolean));
  let pool = phonePool.filter((p) => !used.has(p));

  const fixed = convos.map((c) => {
    if (c.phone) {
      if (c.phone.startsWith("+") && !c.title.includes("+")) return { ...c, title: c.phone };
      return c;
    }
    const titlePhones = extractPhonesFromLine(c.title);
    if (titlePhones[0]) return { ...c, phone: titlePhones[0], title: titlePhones[0] };

    const next = pool[0] || "";
    if (next) pool = pool.slice(1);
    return { ...c, phone: next };
  });

  return fixed;
}

function safeFileBase(title) {
  const safe = (title || "chat")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 40);

  const ts = new Date();
  const stamp =
    ts.getFullYear() +
    "-" +
    String(ts.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(ts.getDate()).padStart(2, "0") +
    "_" +
    String(ts.getHours()).padStart(2, "0") +
    "-" +
    String(ts.getMinutes()).padStart(2, "0");

  return `lead_${safe}_${stamp}`;
}

export default function App() {
  const [imgUrl, setImgUrl] = useState("");
  const [imgEl, setImgEl] = useState(null);

  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);

  const [rawGeneral, setRawGeneral] = useState("");
  const [rawDigits, setRawDigits] = useState("");
  const [debugImgUrl, setDebugImgUrl] = useState("");

  const [convos, setConvos] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [query, setQuery] = useState("");

  const [incoming, setIncoming] = useState("تمام، ممكن التفاصيل؟");
  const [msg1, setMsg1] = useState("🌙 رمضان مبارك — خصم مميز + هدية مجانية 🎁");
  const [msg2, setMsg2] = useState("الكمية محدودة… تحب أثبت لك الحجز؟ ✅");
  const [timeText, setTimeText] = useState(formatTime());
  const [platform, setPlatform] = useState("whatsapp");

  const [toast, setToast] = useState("");

  const canvasRef = useRef(null);
  const dropRef = useRef(null);

  useEffect(() => {
    if (!imgUrl) return;
    const img = new Image();
    img.onload = () => setImgEl(img);
    img.src = imgUrl;
  }, [imgUrl]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const onPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) resetAll(URL.createObjectURL(file));
          e.preventDefault();
          break;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;

    const prevent = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDrop = (e) => {
      prevent(e);
      const file = e.dataTransfer?.files?.[0];
      if (file) resetAll(URL.createObjectURL(file));
    };

    el.addEventListener("dragenter", prevent);
    el.addEventListener("dragover", prevent);
    el.addEventListener("dragleave", prevent);
    el.addEventListener("drop", onDrop);

    return () => {
      el.removeEventListener("dragenter", prevent);
      el.removeEventListener("dragover", prevent);
      el.removeEventListener("dragleave", prevent);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  const resetAll = (url) => {
    setImgUrl(url);
    setConvos([]);
    setActiveId("");
    setRawGeneral("");
    setRawDigits("");
    setDebugImgUrl("");
    setQuery("");
    setToast("");
  };

  const runOCR = async () => {
    if (!imgEl || ocrBusy) return;

    setOcrBusy(true);
    setOcrProgress(0);
    setConvos([]);
    setActiveId("");
    setRawGeneral("");
    setRawDigits("");
    setDebugImgUrl("");
    setToast("");

    try {
      const pre = preprocessForOCR(imgEl, { scale: 3, threshold: 175 });
      setDebugImgUrl(pre);

      const pimg = new Image();
      await new Promise((resolve, reject) => {
        pimg.onload = resolve;
        pimg.onerror = reject;
        pimg.src = pre;
      });

      const resGeneral = await Tesseract.recognize(pimg, "ara+eng", {
        logger: (m) => {
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            setOcrProgress(m.progress * 0.6);
          }
        },
        tessedit_pageseg_mode: 6,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
      });
      const generalText = resGeneral?.data?.text || "";
      setRawGeneral(generalText);

      const resDigits = await Tesseract.recognize(pimg, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            setOcrProgress(0.6 + m.progress * 0.4);
          }
        },
        tessedit_pageseg_mode: 6,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
        tessedit_char_whitelist: "+0123456789",
      });
      const digitsText = resDigits?.data?.text || "";
      setRawDigits(digitsText);

      const parsed = parseConversationsFromRawText(generalText).map((c, i) => ({ ...c, id: `c-${i}` }));
      const phonePool = parsePhoneLines(digitsText);
      const improved = attachPhonesSmart(parsed, phonePool);

      setConvos(improved);
      setActiveId(improved[0]?.id || "");
      setToast(improved.length ? "تم استخراج المحادثات" : "لم يتم العثور على محادثات");
    } catch (e) {
      console.error(e);
      setToast("حصل خطأ أثناء الاستخراج");
    } finally {
      setOcrBusy(false);
    }
  };

  const activeConvo = useMemo(() => convos.find((c) => c.id === activeId) || null, [convos, activeId]);

  const filtered = useMemo(() => {
    const q = normalizeLine(query).toLowerCase();
    if (!q) return convos;
    return convos.filter((c) =>
      `${c.title} ${c.preview} ${c.time} ${c.phone}`.toLowerCase().includes(q)
    );
  }, [convos, query]);

  useEffect(() => {
    renderCanvas();
  }, [activeConvo?.title, incoming, msg1, msg2, timeText, platform]);

  const renderCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const W = 1000;
    const H = 1600;
    canvas.width = W;
    canvas.height = H;

    const bg = platform === "instagram" ? "#f6f0ff" : platform === "whatsapp" ? "#eaf4ea" : "#eef2ff";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = "#000";
    for (let y = 0; y < H; y += 34) {
      for (let x = 0; x < W; x += 34) {
        ctx.beginPath();
        ctx.arc(x + 10, y + 10, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    const pad = 34;
    const headerH = 130;

    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, pad, pad, W - pad * 2, headerH, 28, true, false);

    const title = activeConvo?.title || "—";
    const av = 78;
    const ax = pad + 20;
    const ay = pad + (headerH - av) / 2;

    ctx.fillStyle = "rgba(0,0,0,0.10)";
    ctx.beginPath();
    ctx.arc(ax + av / 2, ay + av / 2, av / 2, 0, Math.PI * 2);
    ctx.fill();

    const firstChar = (title.trim()[0] || "؟").toUpperCase();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.font = "800 34px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(firstChar, ax + av / 2, ay + av / 2);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";

    ctx.fillStyle = "#111827";
    ctx.font = "900 34px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText(title, ax + av + 18, pad + 56);

    ctx.fillStyle = "rgba(17,24,39,0.65)";
    ctx.font = "700 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText("نشط الآن", ax + av + 18, pad + 92);

    const t = timeText || formatTime();
    ctx.fillStyle = "rgba(17,24,39,0.55)";
    ctx.font = "800 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    const tw = ctx.measureText(t).width;
    ctx.fillText(t, W - pad - 22 - tw, pad + 78);
    ctx.restore();

    let y = pad + headerH + 30;

    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = "#000";
    roundRect(ctx, W / 2 - 110, y, 220, 44, 22, true, false);
    ctx.restore();
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.font = "800 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "center";
    ctx.fillText("Today", W / 2, y + 29);
    ctx.textAlign = "start";
    y += 70;

    y = drawBubble(ctx, { W, y, side: "left", text: incoming, platform });
    y += 18;
    y = drawBubble(ctx, { W, y, side: "right", text: msg1, platform });
    y += 12;
    y = drawBubble(ctx, { W, y, side: "right", text: msg2, platform });

    const barH = 92;
    const barY = H - pad - barH;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, pad, barY, W - pad * 2, barH, 28, true, false);
    ctx.fillStyle = "rgba(17,24,39,0.55)";
    ctx.font = "700 24px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText("Message...", pad + 90, barY + 56);
    ctx.restore();
  };

  const drawBubble = (ctx, { W, y, side, text, platform }) => {
    const padX = 22;
    const padY = 16;
    const maxW = 620;

    ctx.font = "750 26px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    const lines = wrapLines(ctx, text || "", maxW - padX * 2);
    const lineH = 36;

    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), 80);
    const bubbleW = Math.min(maxW, textW + padX * 2);
    const bubbleH = lines.length * lineH + padY * 2;

    const leftX = 64;
    const rightX = W - 64;
    const bx = side === "right" ? rightX - bubbleW : leftX;
    const by = y;

    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = "#000";
    roundRect(ctx, bx + 2, by + 4, bubbleW, bubbleH, 24, true, false);
    ctx.restore();

    const isRight = side === "right";
    let fill = "rgba(255,255,255,0.95)";
    if (isRight) {
      if (platform === "whatsapp") fill = "#dcfce7";
      else if (platform === "instagram") fill = "#ede9fe";
      else fill = "#dbeafe";
    }
    ctx.fillStyle = fill;
    roundRect(ctx, bx, by, bubbleW, bubbleH, 24, true, false);

    ctx.fillStyle = isRight
      ? platform === "instagram"
        ? "#3b0764"
        : platform === "whatsapp"
          ? "#14532d"
          : "#1e3a8a"
      : "#111827";

    let ty = by + padY;
    for (const l of lines) {
      ctx.fillText(l, bx + padX, ty);
      ty += lineH;
    }
    return by + bubbleH;
  };

  const copyText = async (txt) => {
    try {
      await navigator.clipboard.writeText(txt || "");
      setToast("تم النسخ");
    } catch {
      setToast("لم يتم النسخ");
    }
  };

  const downloadPNG = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const base = safeFileBase(activeConvo?.title || "chat");
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.png`;
    a.click();
  };

  const copyImageOnly = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
      if (!blob) throw new Error("blob");
      if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error("clip");

      await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
      setToast("تم نسخ الصورة");
    } catch {
      setToast("لم يتم نسخ الصورة");
    }
  };

  const exportAndCopy = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const base = safeFileBase(activeConvo?.title || "chat");

    let copied = false;
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
      if (blob && window.ClipboardItem && navigator.clipboard?.write) {
        await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
        copied = true;
      }
    } catch {
      copied = false;
    }

    try {
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${base}.png`;
      a.click();
    } catch {
      setToast("لم يتم التحميل");
      return;
    }

    setToast(copied ? "تم النسخ + التحميل" : "تم التحميل");
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="t1">Rokhaa</div>
        <div className="t2">{toast ? toast : ""}</div>
      </header>

      <div className="layout">
        <aside className="left">
          <div className="box">
            <div className="boxTitle">1) صورة القائمة</div>

            {!imgUrl ? (
              <div className="dropArea" ref={dropRef}>
                <div className="dropBig">اسحب الصورة هنا أو الصقها</div>
                <div className="dropSmall">Ctrl+V</div>
                <label className="uploadBtn">
                  اختيار صورة
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) resetAll(URL.createObjectURL(f));
                    }}
                  />
                </label>
              </div>
            ) : (
              <>
                <img className="imgPreview" src={imgUrl} alt="list" />
                <div className="row">
                  <button className="btn primary" onClick={runOCR} disabled={!imgEl || ocrBusy}>
                    {ocrBusy ? `جاري الاستخراج... ${Math.round(ocrProgress * 100)}%` : "استخراج"}
                  </button>
                  <button className="btn" onClick={() => resetAll("")}>مسح</button>
                </div>
              </>
            )}
          </div>

          <div className="box">
            <div className="boxTitle">2) المحادثات</div>

            <input className="in" placeholder="بحث..." value={query} onChange={(e) => setQuery(e.target.value)} />

            <div className="list" style={{ maxHeight: 420, overflow: "auto" }}>
              {filtered.length === 0 ? (
                <div className="hint">ارفع الصورة ثم اضغط استخراج</div>
              ) : (
                filtered.map((c) => {
                  const active = c.id === activeId;
                  return (
                    <button key={c.id} className={`chatRow ${active ? "on" : ""}`} onClick={() => setActiveId(c.id)}>
                      <div className="avatar">{(c.title?.trim?.()[0] || "؟").toUpperCase()}</div>
                      <div className="rowMain">
                        <div className="rowTop">
                          <div className="title" title={c.title}>{c.title}</div>
                          <div className="time">{c.time || ""}</div>
                        </div>
                        <div className="preview" title={c.preview}>{c.preview || "—"}</div>
                        {c.phone ? (
                          <div className="badge">📞 {c.phone}</div>
                        ) : (
                          <div className="badge" style={{ opacity: 0.6 }}>📞 —</div>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="row">
              <button
                className="btn blue"
                onClick={() => copyText(activeConvo?.phone || activeConvo?.title || "")}
                disabled={!activeConvo}
              >
                نسخ الاسم/الرقم
              </button>
            </div>

            <details className="details">
              <summary>تشخيص</summary>
              {debugImgUrl ? <img className="imgPreview" src={debugImgUrl} alt="debug" /> : <div className="hint">—</div>}
              <pre className="raw">{rawGeneral || "—"}</pre>
              <pre className="raw">{rawDigits || "—"}</pre>
            </details>
          </div>
        </aside>

        <main className="right">
          <div className="box">
            <div className="boxTitle">المعاينة</div>
            <canvas ref={canvasRef} className="canvas" />
            <div className="row">
              <button className="btn primary" onClick={exportAndCopy} disabled={!activeConvo}>
                نسخ + تحميل
              </button>
              <button className="btn" onClick={downloadPNG} disabled={!activeConvo}>
                تحميل فقط
              </button>
              <button className="btn blue" onClick={copyImageOnly} disabled={!activeConvo}>
                نسخ الصورة فقط
              </button>
            </div>
          </div>

          <div className="grid2">
            <div className="box">
              <div className="boxTitle">الرسائل</div>
              <label className="lbl">رسالة العميل</label>
              <textarea className="ta" value={incoming} onChange={(e) => setIncoming(e.target.value)} />
              <label className="lbl">رسالتك 1</label>
              <textarea className="ta" value={msg1} onChange={(e) => setMsg1(e.target.value)} />
              <label className="lbl">رسالتك 2</label>
              <textarea className="ta" value={msg2} onChange={(e) => setMsg2(e.target.value)} />
            </div>

            <div className="box">
              <div className="boxTitle">إعدادات</div>
              <label className="lbl">الشكل</label>
              <select className="sel" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="whatsapp">واتساب</option>
                <option value="messenger">ماسنجر</option>
                <option value="instagram">انستجرام</option>
              </select>
              <label className="lbl">الوقت</label>
              <input className="in" value={timeText} onChange={(e) => setTimeText(e.target.value)} />
            </div>
          </div>
        </main>
      </div>

      <footer className="foot">
        استخدم زر "نسخ + تحميل" لو عايز نفس إحساس القصاصة
      </footer>
    </div>
  );
}