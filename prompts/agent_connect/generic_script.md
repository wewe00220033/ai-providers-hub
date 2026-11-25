# 🧪 دليل الربط البرمجي العام (Python stdlib + Node.js)

عميل جاهز بدون أي مكتبات خارجية يتعامل مع:
1. إعادة توجيه Google Apps Script (`302` من `doPost` إلى `script.googleusercontent.com` عبر `GET`).
2. قراءة `prompt_version` تلقائياً والتحديث عند `426 PROMPT_UPDATED_RE_READ_REQUIRED`.
3. إعادة المحاولة التدريجية عند `429` (`2s -> 4s -> 8s` — بحد أقصى 4 محاولات).
4. منع إرسال `token` في رابط الاستعلام أو تزوير `agent_id`.

## 1) عميل Python (مكتبة قياسية فقط)
```python
import json
import os
import time
import urllib.request

HUB_URL = os.environ["HUB_URL"]
HUB_TOKEN = os.environ["HUB_TOKEN"]


def hub_get(action: str, **params) -> dict:
    from urllib.parse import urlencode
    qs = urlencode({"action": action, **params})
    with urllib.request.urlopen(f"{HUB_URL}?{qs}", timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def hub_post(action: str, body: dict | None = None, prompt_version: str = "") -> dict:
    pv = prompt_version
    delays = (2, 4, 8)
    res = {}
    for attempt in range(4):
        payload = {"action": action, "token": HUB_TOKEN, **(body or {})}
        if pv:
            payload["prompt_version"] = pv
        req = urllib.request.Request(
            HUB_URL,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            res = json.loads(resp.read().decode("utf-8"))
        code = res.get("code")
        if code == 426 and attempt < 3:
            pv = hub_get("get_prompt")["data"]["prompt_version"]
            continue
        if code == 429 and attempt < 3:
            time.sleep(delays[attempt])
            continue
        return res
    return res
```

## 2) عميل Node.js 18+ (`fetch` المدمج)
```javascript
const HUB_URL = process.env.HUB_URL;
const HUB_TOKEN = process.env.HUB_TOKEN;

async function hubGet(action, params = {}) {
  const url = new URL(HUB_URL);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { redirect: 'follow' });
  return res.json();
}

async function hubPost(action, body = {}, promptVersion = '') {
  let pv = promptVersion;
  const delays = [2000, 4000, 8000];
  let out = {};
  for (let i = 0; i < 4; i++) {
    const payload = { action, token: HUB_TOKEN, ...body };
    if (pv) payload.prompt_version = pv;
    const res = await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow', // fetch يحول 302 POST تلقائياً إلى GET على script.googleusercontent.com
    });
    out = await res.json();
    if (out.code === 426 && i < 3) {
      pv = (await hubGet('get_prompt')).data.prompt_version;
      continue;
    }
    if (out.code === 429 && i < 3) {
      await new Promise((r) => setTimeout(r, delays[i]));
      continue;
    }
    return out;
  }
  return out;
}
```
