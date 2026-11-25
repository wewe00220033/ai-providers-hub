# 🤖 ربط Claude Desktop / Claude Code / عملاء MCP

## 1) حالة الدعم المباشر (بصراحة تقنية)
- **Claude Code / أي وكيل يملك الطرفية:** لا يحتاج MCP أصلاً — يقرأ `MASTER_PROMPT` مباشرة ويبعث بـ `curl -sL` أو سكريبت Python الموجود في [`opencode.md`](opencode.md) و[`generic_script.md`](generic_script.md).
- **Claude Desktop عبر جسر MCP محلي (`stdio`):** Google Apps Script لا يدعم جلسات SSE/Streamable HTTP طويلة، لذلك لو عايز تشغّل Hub كأدوات داخل **Claude Desktop** على جهازك، استخدم جسر `stdio` محلي خفيف يترجم استدعاء الأداة إلى `POST $HUB_URL`.
- **تطبيقات الشات المقفولة تماماً (موبايل / ويب بلا أدوات ولا Connector):** تُصنَّف **للقراءة فقط** (من رابط GitHub Pages أو `CATALOG.md`) ولا تكتب في Hub بدون نقل يدوي، وهو مستبعد حفاظاً على قاعدة «صفر عمل يدوي».

## 2) مثال جسر MCP محلي خفيف (Python stdlib — صفر حزم خارجية)
احفظ الملف التالي محلياً (مثلاً `~/.local/bin/hub_mcp_bridge.py` خارج الريبو) واضبط متغيري البيئة `HUB_URL` و`HUB_TOKEN`:

```python
#!/usr/bin/env python3
"""Minimal JSON-RPC stdio bridge forwarding MCP tool calls to Apps Script POST."""
import json
import os
import sys
import urllib.request

HUB_URL = os.environ["HUB_URL"]
HUB_TOKEN = os.environ["HUB_TOKEN"]


def call_hub(body: dict) -> dict:
    payload = dict(body)
    payload["token"] = HUB_TOKEN
    req = urllib.request.Request(
        HUB_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def respond(msg_id, result=None, error=None):
    frame = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        frame["error"] = error
    else:
        frame["result"] = result
    sys.stdout.write(json.dumps(frame, ensure_ascii=False) + "\n")
    sys.stdout.flush()


TOOLS = [
    {
        "name": "hub_call",
        "description": "Call AI Providers Puzzle Hub action (get_tasks, claim_task, submit_piece, report_captcha, probe_email, ...)",
        "inputSchema": {
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {"type": "string"},
                "prompt_version": {"type": "string"},
                "host": {"type": "string"},
                "piece_type": {"type": "string"}
            },
            "additionalProperties": True
        },
    }
]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    mid = req.get("id")
    method = req.get("method")
    if method == "initialize":
        respond(mid, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "puzzle-hub", "version": "1.0.0"}})
    elif method == "tools/list":
        respond(mid, {"tools": TOOLS})
    elif method == "tools/call":
        args = (req.get("params") or {}).get("arguments") or {}
        try:
            res = call_hub(args)
            respond(mid, {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False)}]})
        except Exception as exc:
            respond(mid, {"content": [{"type": "text", "text": str(exc)}], "isError": True})
    elif mid is not None:
        respond(mid, {})
```

## 3) تفعيل الجسر في `claude_desktop_config.json`
```json
{
  "mcpServers": {
    "ai-providers-hub": {
      "command": "python",
      "args": ["C:/Users/USER/.local/bin/hub_mcp_bridge.py"],
      "env": {
        "HUB_URL": "https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec",
        "HUB_TOKEN": "ag_<YOUR_AGENT_TOKEN>"
      }
    }
  }
}
```
> 🔒 تذكير: لا تضع ملف الإعداد هذا أو أي توكن حقيقي داخل مستودع GitHub العام.
