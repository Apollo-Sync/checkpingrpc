import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);
const BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_blockNumber",
  params: [],
});

function loadRpcs() {
  const raw = readFileSync(resolve("rpc.txt"), "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

async function askRounds() {
  // Cho phép vẫn dùng biến môi trường ROUNDS nếu có (bỏ qua hỏi)
  if (process.env.ROUNDS) {
    const n = Number(process.env.ROUNDS);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = await rl.question("Nhập số lần ping cho mỗi RPC (mặc định 10): ");
      const trimmed = answer.trim();
      if (trimmed === "") return 10;
      const n = Number(trimmed);
      if (Number.isInteger(n) && n > 0) return n;
      console.log("  -> Vui lòng nhập một số nguyên dương hợp lệ.");
    }
  } finally {
    rl.close();
  }
}

async function pingOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let block = null;
    try {
      const json = JSON.parse(text);
      if (json.result) block = Number.parseInt(json.result, 16);
    } catch {
      // ignore parse error
    }
    return { ok: res.ok && block !== null, ms, status: res.status, block, err: null };
  } catch (err) {
    return {
      ok: false,
      ms: performance.now() - t0,
      status: 0,
      block: null,
      err: err.name === "AbortError" ? "timeout" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function stats(rows) {
  const ok = rows.filter((r) => r.ok).map((r) => r.ms);
  if (!ok.length) return null;
  const sorted = [...ok].sort((a, b) => a - b);
  const sum = ok.reduce((a, b) => a + b, 0);
  return {
    ok: ok.length,
    fail: rows.length - ok.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / ok.length,
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
  };
}

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[93m"; // vàng nhạt
const RED = "\x1b[31m";

function fmt(n) {
  return `${n.toFixed(1)}ms`;
}

function pickColor(ms) {
  if (ms <= 30) return GREEN;
  if (ms <= 50) return YELLOW;
  return RED;
}

function colorMs(ms) {
  return `${pickColor(ms)}${fmt(ms)}${RESET}`;
}

const urls = loadRpcs();
if (!urls.length) {
  console.error("rpc.txt trống");
  process.exit(1);
}

const ROUNDS = await askRounds();

console.log(`\nRounds: ${ROUNDS}`);
console.log(`Timeout: ${TIMEOUT_MS}ms\n`);

const summary = [];

for (const url of urls) {
  console.log(`=== ${url} ===`);
  const rows = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await pingOnce(url);
    rows.push(r);
    if (r.ok) {
      console.log(`  #${String(i).padStart(2, "0")}  ${colorMs(r.ms)}  block=${r.block}`);
    } else {
      console.log(`  #${String(i).padStart(2, "0")}  FAIL  ${r.err || "http " + r.status}  ${colorMs(r.ms)}`);
    }
  }
  const s = stats(rows);
  if (!s) {
    console.log("  >> không có request thành công\n");
    summary.push({ url, ok: 0, fail: ROUNDS, min: null, avg: null, max: null, p50: null });
    continue;
  }
  console.log(
    `  >> ok ${s.ok}/${ROUNDS} | min ${colorMs(s.min)} | p50 ${colorMs(s.p50)} | avg ${colorMs(s.avg)} | max ${colorMs(s.max)}\n`
  );
  summary.push({ url, ...s });
}

// ===== Bảng tổng hợp =====
function short(url, max = 40) {
  return url.length > max ? url.slice(0, max - 1) + "…" : url;
}

function padRight(str, len) {
  str = String(str);
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function padLeft(str, len) {
  str = String(str);
  return str.length >= len ? str : " ".repeat(len - str.length) + str;
}

function colorPad(ms, width) {
  const padded = padLeft(fmt(ms), width);
  return `${pickColor(ms)}${padded}${RESET}`;
}

console.log("=".repeat(90));
console.log("BẢNG TỔNG HỢP KẾT QUẢ");
console.log("=".repeat(90));

const rankable = summary.filter((s) => s.avg !== null);
rankable.sort((a, b) => a.avg - b.avg);
const failed = summary.filter((s) => s.avg === null);
const ranked = [...rankable, ...failed];

const colUrl = 40;
console.log(
  `${padRight("RPC", colUrl)} ${padLeft("OK", 6)} ${padLeft("Min", 9)} ${padLeft("Avg", 9)} ${padLeft("P50", 9)} ${padLeft("Max", 9)}`
);
console.log("-".repeat(90));

for (const s of ranked) {
  if (s.avg === null) {
    console.log(`${padRight(short(s.url, colUrl), colUrl)} ${padLeft("0/" + (s.ok + s.fail), 6)}  LỖI HẾT (không có request thành công)`);
    continue;
  }
  console.log(
    `${padRight(short(s.url, colUrl), colUrl)} ${padLeft(`${s.ok}/${s.ok + s.fail}`, 6)} ${colorPad(s.min, 9)} ${colorPad(s.avg, 9)} ${colorPad(s.p50, 9)} ${colorPad(s.max, 9)}`
  );
}

console.log("=".repeat(90));
if (rankable.length) {
  console.log(`Nhanh nhất (avg thấp nhất): ${rankable[0].url}`);
}