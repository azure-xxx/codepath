/**
 * CodePath バックエンド — AIコーチAPI代理関数（Vercel版）
 *
 * 役割：
 *   ブラウザから直接 Gemini API を叩くとAPIキーが誰にでも見える。
 *   この関数を「代理人」として挟むことで、
 *     ブラウザ → /api/ai-coach（Vercel） → Gemini API
 *   という経路にし、APIキーをサーバー側だけに隠す。
 *
 * 使用モデル： gemini-2.5-flash（無料枠あり・課金登録不要）
 *   ※ Gemini無料枠は予告なく変更されることがあるため、
 *      運用しながら https://ai.google.dev/gemini-api/docs/rate-limits
 *      を定期的に確認することを推奨。
 *
 * Vercelの仕組み：
 *   このファイルを api/ai-coach.js に置くだけで、
 *   自動的に https://あなたのドメイン/api/ai-coach というURLで
 *   呼び出せるサーバーレス関数になる（特別な設定不要）。
 */

const SYSTEM_PROMPT = `あなたは優秀なプログラミング学習AIコーチです。学習者がエラーを出したか課題を解けなかった場合に解析してください。
必ず以下のJSON形式のみで返答（コードブロックや余分なテキスト不要、説明文も不要）:
{
  "errorType": "エラー種別",
  "cause": "根本原因を1〜2文で",
  "whyThought": "なぜそのコードを書いたかの推定（肯定的に）",
  "correctIdea": "正しい考え方・修正方針（1〜2文）",
  "exercises": [
    {"difficulty":"easy","title":"演習タイトル","description":"課題内容1〜2文"},
    {"difficulty":"medium","title":"演習タイトル","description":"課題内容1〜2文"}
  ]
}`;

const MAX_FIELD_LENGTH = 4000;

// 簡易レート制限（同一IPからの連打を防ぐ）。
// 本格運用ではVercel KVやSupabase等での永続化が望ましいが、
// MVP段階ではメモリ上の簡易カウンタで十分。
const requestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分
const RATE_LIMIT_MAX = 8; // 1分あたり最大8回（Gemini Flashの無料枠 15RPMより少し余裕を持たせる）

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestLog.get(ip) || [];
  const recent = entry.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  requestLog.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

module.exports = async function handler(req, res) {
  // CORS設定（必要に応じて自分のドメインに絞る）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "POSTメソッドのみ受け付けます" });
    return;
  }

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    res.status(429).json({ error: "リクエストが多すぎます。少し待ってから再試行してください。" });
    return;
  }

  try {
    const { code, errorName, errorMessage, output } = req.body || {};

    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "codeは必須です" });
      return;
    }
    if (code.length > MAX_FIELD_LENGTH) {
      res.status(400).json({ error: "コードが長すぎます" });
      return;
    }

    const isErr = !!errorName;
    const userMsg = isErr
      ? `JavaScriptコードでエラーが発生しました。\n\nコード:\n${code}\n\nエラー: ${errorName}: ${errorMessage}\n\nJSON形式で解析してください。`
      : `コードは実行されましたが課題を満たしていません。\n\nコード:\n${code}\n\n出力: ${String(
          output || ""
        ).slice(0, MAX_FIELD_LENGTH)}\n\nJSON形式で解析してください。`;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "サーバー設定エラー（APIキー未設定）" });
      return;
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: userMsg }] }],
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: {
            maxOutputTokens: 1000,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);
      res.status(502).json({ error: "AIコーチの応答取得に失敗しました" });
      return;
    }

    const data = await geminiRes.json();

    // Gemini独自のレスポンス形式から、フロントエンドが扱いやすい
    // 「テキスト1本」の形に正規化して返す。
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    res.status(200).json({ text });
  } catch (err) {
    console.error("ai-coach unexpected error:", err);
    res.status(500).json({ error: "サーバー内部エラー" });
  }
};
