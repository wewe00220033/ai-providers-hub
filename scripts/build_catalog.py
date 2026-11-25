"""build_catalog.py - deterministic CATALOG.md + docs/index.html generator (PLAN 3.10 / 5.1 / 7).

Python 3.15 stdlib ONLY. Shared helpers come from scripts/hub_common.py (canonical_json,
normalize_host, load_enums, to_cairo_time) - nothing is re-implemented here.

CLI:
    python scripts/build_catalog.py [--repo <root>] [--out-md CATALOG.md] [--out-html docs/index.html]

Determinism: generated_at_utc = max(created_at_utc) over all pieces and reviews (or
'1970-01-01T00:00:00Z' when empty) - never datetime.now(). Hosts are sorted alphabetically,
pieces inside a provider by (created_at_utc, piece_id), reviews by (created_at_utc, review_id).
Running twice on the same input yields byte-identical files.

reviews/ overlay: the LAST event per piece_id (ordered by created_at_utc then review_id) wins:
  action flag    -> review_status 'needs_reverify'
  action resolve -> review_status 'resolved'

HTML safety: data is embedded in <script type="application/json" id="hub-data"> with '</' -> '<\/'
and '<!--' -> '<\u0021--' (both remain valid JSON for JSON.parse); the inline script builds the DOM
with createElement/textContent only (no innerHTML with data). No CDN / external resources.
"""
from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.hub_common import canonical_json, load_enums, to_cairo_time  # noqa: E402

EPOCH = "1970-01-01T00:00:00Z"

STATUS_REVERIFY = "🔁 يحتاج إعادة فحص"
STATUS_VERIFIED = "✅ موثق بوكيلين"
STATUS_PENDING = "🟡 بانتظار تأكيد ثانٍ"
STATUS_NEGATIVE = "🚫 دليل سلبي"
STATUS_ORDER = [STATUS_VERIFIED, STATUS_PENDING, STATUS_REVERIFY, STATUS_NEGATIVE]
STATUS_KEYS = {
    STATUS_VERIFIED: "verified",
    STATUS_PENDING: "pending",
    STATUS_REVERIFY: "needs_reverify",
    STATUS_NEGATIVE: "negative",
}

SECTION_TITLES = {
    "guest_chat": "🆓 بدون تسجيل:",
    "free_tier": "🎁 الباقة المجانية:",
    "signup_delta": "📈 بعد التسجيل:",
    "auth_flow": "🔐 التسجيل والدخول:",
    "paid_pricing": "💳 المدفوع:",
    "referrals": "🤝 الإحالات:",
    "not_found": "🚫 دليل سلبي:",
}
SECTION_ORDER = ["guest_chat", "free_tier", "signup_delta", "auth_flow", "paid_pricing", "referrals", "not_found"]
GUEST_MODES = {
    "instant": "Instant",
    "fast": "Fast",
    "quick": "Quick",
    "auto": "Auto",
    "model_select": "اختيار موديل",
    "unknown": "غير معروف",
}


# ---------------------------------------------------------------------------
# loading
# ---------------------------------------------------------------------------


def _read_json_files(base: Path) -> list[dict]:
    out: list[dict] = []
    if not base.is_dir():
        return out
    for path in sorted(p for p in base.rglob("*.json") if p.is_file()):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                obj = json.load(fh)
        except (OSError, ValueError, UnicodeDecodeError):
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def load_pieces(repo_root: str | Path) -> list[dict]:
    pieces = [p for p in _read_json_files(Path(repo_root) / "pieces") if isinstance(p.get("piece_id"), str)]
    pieces.sort(key=lambda p: (str(p.get("created_at_utc", "")), p["piece_id"]))
    return pieces


def load_reviews(repo_root: str | Path) -> list[dict]:
    reviews = [r for r in _read_json_files(Path(repo_root) / "reviews") if isinstance(r.get("review_id"), str)]
    reviews.sort(key=lambda r: (str(r.get("created_at_utc", "")), r["review_id"]))
    return reviews


def apply_reviews(pieces: list[dict], reviews: list[dict]) -> list[dict]:
    """Return copies of pieces with 'review_status' set from the latest review event per piece_id."""
    latest: dict[str, dict] = {}
    for r in sorted(reviews, key=lambda r: (str(r.get("created_at_utc", "")), str(r.get("review_id", "")))):
        pid = r.get("piece_id")
        if isinstance(pid, str):
            latest[pid] = r
    superseded = {p.get("supersedes_piece_id") for p in pieces if isinstance(p.get("supersedes_piece_id"), str)}
    out: list[dict] = []
    for p in pieces:
        c = dict(p)
        ev = latest.get(c["piece_id"])
        if ev is None:
            c["review_status"] = ""
        elif ev.get("action") == "flag":
            c["review_status"] = "needs_reverify"
        elif ev.get("action") == "resolve":
            c["review_status"] = "resolved"
        else:
            c["review_status"] = str(ev.get("status", ""))
        c["active"] = c["piece_id"] not in superseded
        out.append(c)
    return out


def compute_generated_at(pieces: list[dict], reviews: list[dict]) -> str:
    stamps = [str(x.get("created_at_utc")) for x in list(pieces) + list(reviews) if isinstance(x.get("created_at_utc"), str)]
    return max(stamps) if stamps else EPOCH


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _cairo(iso: Any) -> str:
    try:
        return to_cairo_time(str(iso))
    except Exception:
        return str(iso or "")


def _yn(v: Any) -> str:
    if v is True:
        return "نعم"
    if v is False:
        return "لا"
    return "غير معروف"


def compress_models(names: list[Any]) -> tuple[list[str], list[str]]:
    """Group the 9 target models by family -> ['Fable 5 / 5.2', 'Astra 6']; others returned verbatim."""
    enums = load_enums()
    short = enums.get("model_short", {})
    known = set(enums["models_full"])
    present = {n for n in names if isinstance(n, str)}
    groups: list[str] = []
    for info in enums["model_families"].values():
        prefix = str(info["compact"]).split(" ")[0]
        versions = [str(short.get(m, m))[len(prefix):].strip() for m in info["members"] if m in present]
        if versions:
            groups.append(f"{prefix} {' / '.join(versions)}")
    others: list[str] = []
    for n in names:
        if isinstance(n, str) and n not in known and n not in others:
            others.append(n)
    return groups, others


def _models_text(names: list[Any]) -> str:
    groups, others = compress_models(names)
    parts = []
    if groups:
        parts.append(" · ".join(groups))
    if others:
        parts.append("أخرى: " + " · ".join(others))
    return " · ".join(parts)


def _lines_for_piece(piece: dict) -> list[str]:
    """Human lines (without attribution) for one piece, by piece_type."""
    t = piece.get("piece_type")
    pl = piece.get("payload") if isinstance(piece.get("payload"), dict) else {}
    parts: list[str] = []
    if t == "guest_chat":
        parts.append("يعمل بدون تسجيل: " + _yn(pl.get("works_without_signup")))
        parts.append("الوضع: " + GUEST_MODES.get(str(pl.get("mode", "unknown")), str(pl.get("mode", ""))))
        m = _models_text(pl.get("models_named") or [])
        if m:
            parts.append("الموديلات: " + m)
        if pl.get("free_credits_or_quota"):
            parts.append("الحصة: " + str(pl["free_credits_or_quota"]))
        if "requires_card" in pl:
            parts.append("بطاقة: " + _yn(pl.get("requires_card")))
        if pl.get("limits_notes"):
            parts.append("ملاحظات: " + str(pl["limits_notes"]))
    elif t == "free_tier":
        if pl.get("exists") is False:
            parts.append("لا توجد باقة مجانية")
        groups, others = compress_models(list(pl.get("models_named") or []))
        if groups:
            parts.append("الموديلات المطلوبة: " + " · ".join(groups))
        extra = list(pl.get("free_models_other") or []) + others
        if extra:
            parts.append("أخرى: " + " · ".join(str(x) for x in extra))
        if pl.get("free_credits_or_quota"):
            parts.append("الحصة: " + str(pl["free_credits_or_quota"]))
        parts.append("بطاقة: " + _yn(pl.get("requires_card")))
        parts.append("سحب تلقائي بعد التجربة: " + _yn(pl.get("auto_charges_after_trial")))
        if pl.get("how_to_use"):
            parts.append("كيف: " + str(pl["how_to_use"]))
    elif t == "signup_delta":
        parts.append("زيادة الرصيد: " + _yn(pl.get("credits_increase")))
        m = _models_text(pl.get("unlocked_models") or [])
        if m:
            parts.append("موديلات تُفتح: " + m)
        if pl.get("notes"):
            parts.append(str(pl["notes"]))
    elif t == "auth_flow":
        label = "Sign up" if pl.get("flow") == "signup" else "Login"
        parts.append(f"{label}: " + " · ".join(str(x) for x in pl.get("methods") or []))
        if pl.get("oauth_providers"):
            parts.append("OAuth: " + " · ".join(str(x) for x in pl["oauth_providers"]))
        cap = pl.get("captcha") if isinstance(pl.get("captcha"), dict) else {}
        parts.append("CAPTCHA: " + str(cap.get("type", "unknown")))
        if pl.get("probe_result"):
            parts.append("Probe: " + str(pl["probe_result"]))
        if pl.get("notes"):
            parts.append(str(pl["notes"]))
    elif t == "paid_pricing":
        for plan in pl.get("plans") or []:
            if not isinstance(plan, dict):
                continue
            seg = f"{plan.get('name', '')}: {plan.get('price', '')}"
            if plan.get("period"):
                seg += f" / {plan['period']}"
            if "includes_target_models" in plan:
                seg += " · يشمل الموديلات المطلوبة: " + _yn(plan.get("includes_target_models"))
            if plan.get("notes"):
                seg += " · " + str(plan["notes"])
            parts.append(seg)
        if pl.get("per_million_tokens"):
            parts.append("لكل مليون توكن: " + str(pl["per_million_tokens"]))
        if pl.get("terms_excerpt"):
            parts.append("الشروط: " + str(pl["terms_excerpt"]))
    elif t == "referrals":
        parts.append("يوجد نظام إحالة: " + _yn(pl.get("exists")))
        if pl.get("exists"):
            parts.append("المكافأة فورية عند التسجيل: " + _yn(pl.get("reward_immediate")))
            parts.append("يشترط شحن/اشتراك المدعو: " + _yn(pl.get("requires_invitee_payment")))
        if pl.get("reward_description"):
            parts.append(str(pl["reward_description"]))
    elif t == "not_found":
        pages = [str(x) for x in pl.get("checked_pages") or []]
        if pages:
            parts.append("الصفحات المفحوصة: " + " · ".join(pages))
        if pl.get("checked_at_utc"):
            parts.append("وقت الفحص: " + _cairo(pl["checked_at_utc"]))
        if pl.get("reason"):
            parts.append("السبب: " + str(pl["reason"]))
    else:
        parts.append(str(piece.get("summary", "")))
    return [" · ".join(p for p in parts if p)]


# ---------------------------------------------------------------------------
# grouping
# ---------------------------------------------------------------------------


def _agent_name(piece: dict) -> str:
    ag = piece.get("agent") if isinstance(piece.get("agent"), dict) else {}
    return str(ag.get("display_name") or ag.get("agent_id") or "?")


def _agent_id(piece: dict) -> str:
    ag = piece.get("agent") if isinstance(piece.get("agent"), dict) else {}
    return str(ag.get("agent_id") or "")


def _build_sections(pieces: list[dict]) -> list[dict]:
    by_type: dict[str, list[dict]] = {}
    for p in pieces:
        by_type.setdefault(str(p.get("piece_type", "")), []).append(p)
    types = [t for t in SECTION_ORDER if t in by_type] + sorted(t for t in by_type if t not in SECTION_ORDER and t != "identity")
    sections: list[dict] = []
    for t in types:
        group = by_type[t]
        active = [p for p in group if p.get("active", True)]
        conflict = ""
        seen: dict[str, str] = {}
        for p in active:
            payload_key = canonical_json(p.get("payload"))
            for aid, (name, key) in seen.items():
                if aid != _agent_id(p) and key != payload_key:
                    conflict = f"⚠️ تعارض: {name} vs {_agent_name(p)}"
                    break
            if conflict:
                break
            seen.setdefault(_agent_id(p), (_agent_name(p), payload_key))
        items = []
        for p in group:
            items.append(
                {
                    "piece_id": p["piece_id"],
                    "lines": _lines_for_piece(p),
                    "by": _agent_name(p),
                    "at": _cairo(p.get("created_at_utc")),
                    "reverify": p.get("review_status") == "needs_reverify",
                    "active": bool(p.get("active", True)),
                    "evidence_url": str((p.get("evidence") or {}).get("url", "")),
                }
            )
        sections.append({"type": t, "title": SECTION_TITLES.get(t, f"📦 {t}:"), "conflict": conflict, "items": items})
    return sections


def group_providers(pieces: list[dict]) -> list[dict]:
    """Group pieces by canonical_host (sorted) and compute status / sections / conflicts."""
    enums = load_enums()
    channel_order = list(enums["channels"])
    short = enums.get("model_short", {})
    hosts: dict[str, list[dict]] = {}
    for p in pieces:
        prov = p.get("provider") if isinstance(p.get("provider"), dict) else {}
        host = str(prov.get("canonical_host") or "")
        if host:
            hosts.setdefault(host, []).append(p)
    providers: list[dict] = []
    for host in sorted(hosts):
        plist = sorted(hosts[host], key=lambda p: (str(p.get("created_at_utc", "")), p["piece_id"]))
        for p in plist:
            p.setdefault("active", True)
            p.setdefault("review_status", "")
        identity = next((p for p in plist if p.get("piece_type") == "identity"), None)
        ipl = identity.get("payload", {}) if identity and isinstance(identity.get("payload"), dict) else {}
        prov0 = plist[0].get("provider", {})
        display_name = str(ipl.get("display_name") or prov0.get("display_name") or host)
        usage_url = str(ipl.get("usage_url") or next((str((p.get("evidence") or {}).get("url")) for p in plist if (p.get("evidence") or {}).get("url")), ""))
        chans = set()
        for p in plist:
            chans.update(str(c) for c in p.get("channels") or [])
        chans.update(str(c) for c in ipl.get("access_types") or [])
        channels = [c for c in channel_order if c in chans]
        active = [p for p in plist if p.get("active", True)]
        agents = {_agent_id(p) for p in active}
        needs_reverify = any(p.get("review_status") == "needs_reverify" for p in active)
        if needs_reverify:
            status = STATUS_REVERIFY
        elif active and all(p.get("piece_type") == "not_found" for p in active):
            status = STATUS_NEGATIVE
        elif len(agents) >= 2:
            status = STATUS_VERIFIED
        else:
            status = STATUS_PENDING
        models: set[str] = set()
        free = False
        for p in active:
            pl = p.get("payload") if isinstance(p.get("payload"), dict) else {}
            t = p.get("piece_type")
            if isinstance(p.get("model_tag"), str):
                models.add(p["model_tag"])
            if t in ("guest_chat", "free_tier"):
                models.update(m for m in pl.get("models_named") or [] if isinstance(m, str))
            if t == "guest_chat" and pl.get("works_without_signup") is True:
                free = True
            if t == "free_tier" and pl.get("exists") is True:
                free = True
        sections = _build_sections(plist)
        providers.append(
            {
                "host": host,
                "provider_id": str(prov0.get("provider_id", "")),
                "name": display_name,
                "status": status,
                "status_key": STATUS_KEYS[status],
                "usage_url": usage_url,
                "channels": channels,
                "models": sorted(str(short.get(m, m)) for m in models),
                "free": free,
                "reverify": needs_reverify,
                "conflict": any(s["conflict"] for s in sections),
                "agents": sorted(agents),
                "sections": sections,
            }
        )
    return providers


# ---------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------


def _item_md(item: dict) -> list[str]:
    out = []
    for line in item["lines"]:
        s = f"- {line} — {item['by']} · {item['at']}"
        if item["reverify"]:
            s += f" · {STATUS_REVERIFY}"
        if not item["active"]:
            s += " · (قطعة قديمة مُستبدلة)"
        out.append(s)
    return out


def render_markdown(providers: list[dict], generated_at_utc: str) -> str:
    lines: list[str] = ["# 📚 كتالوج مزودي الموديلات", "", f"آخر تحديث: {_cairo(generated_at_utc)}", ""]
    counts = {s: 0 for s in STATUS_ORDER}
    for p in providers:
        counts[p["status"]] += 1
    summary = " · ".join(f"{s}: {counts[s]}" for s in STATUS_ORDER if counts[s])
    lines.append(f"الملخص: {len(providers)} مزود" + (f" — {summary}" if summary else ""))
    lines.append("")
    for p in providers:
        lines.append(f"## {p['name']} ({p['host']}) — {p['status']}")
        lines.append(f"🔗 الاستخدام: {p['usage_url']}")
        if p["channels"]:
            lines.append("📡 القنوات: " + " · ".join(p["channels"]))
        for sec in p["sections"]:
            title = sec["title"] + (f" {sec['conflict']}" if sec["conflict"] else "")
            lines.append(title)
            for item in sec["items"]:
                lines.extend(_item_md(item))
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------


def safe_json_for_script(data: Any) -> str:
    """json.dumps that can never close a <script> tag or open a comment; still valid JSON."""
    text = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return text.replace("</", "<\\/").replace("<!--", "<\\u0021--")


_CSS = """
:root{--bg:#f6f7fb;--card:#fff;--txt:#1d2433;--muted:#5d6577;--line:#e2e6ef;--acc:#2f6fed;--acc2:#e8f0ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,'Segoe UI',Tahoma,Arial,sans-serif;line-height:1.7;word-break:keep-all}
header{padding:20px 16px 8px;max-width:1100px;margin:0 auto}h1{margin:0 0 4px;font-size:26px}.muted{color:var(--muted);font-size:14px}
.tools{max-width:1100px;margin:0 auto;padding:8px 16px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tools input[type=search]{flex:1 1 260px;min-width:0;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:15px}
.tools select{padding:8px;border:1px solid var(--line);border-radius:8px}label.sw{display:inline-flex;gap:6px;align-items:center;font-size:14px}
.models{display:flex;flex-wrap:wrap;gap:6px;width:100%}.models button{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:4px 12px;cursor:pointer;font-size:13px}
.models button.on{background:var(--acc);color:#fff;border-color:var(--acc)}#count{font-weight:600}
main{max-width:1100px;margin:0 auto;padding:0 16px 40px;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-width:0}.card h2{margin:0 0 6px;font-size:18px}
.card .line{margin:2px 0;font-size:14px}.card a{color:var(--acc);word-break:break-all}.sec{margin-top:8px;font-weight:600}.sec .conf{color:#b54708;font-weight:600;margin-inline-start:6px}
.card ul{margin:2px 0 0;padding-inline-start:18px}.card li{font-size:14px}.by{color:var(--muted);font-size:12px}.rev{color:#b54708}.old{color:var(--muted);text-decoration:line-through}
.badge{display:inline-block;background:var(--acc2);border-radius:6px;padding:0 6px;font-size:12px;margin-inline-start:4px}
"""

_JS = r"""
(function(){
'use strict';
var raw=document.getElementById('hub-data').textContent;var DATA=JSON.parse(raw);var P=DATA.providers;var MODELS=DATA.models;
var q=document.getElementById('q'),st=document.getElementById('st'),fr=document.getElementById('free'),rv=document.getElementById('rev'),mb=document.getElementById('models'),out=document.getElementById('cards'),cnt=document.getElementById('count');
var sel={};
function el(t,c){var e=document.createElement(t);if(c){e.className=c;}return e;}
function txt(t,c,s){var e=el(t,c);e.textContent=s;return e;}
MODELS.forEach(function(m){var b=txt('button','',m);b.type='button';b.addEventListener('click',function(){sel[m]=!sel[m];b.classList.toggle('on',!!sel[m]);render();});mb.appendChild(b);});
function card(p){var c=el('article','card');c.appendChild(txt('h2','',p.name+' ('+p.host+') \u2014 '+p.status));
var u=el('div','line');u.appendChild(document.createTextNode('\ud83d\udd17 \u0627\u0644\u0627\u0633\u062a\u062e\u062f\u0627\u0645: '));
if(/^https:\/\//.test(p.usage_url)){var a=el('a');a.href=p.usage_url;a.rel='noopener noreferrer';a.target='_blank';a.textContent=p.usage_url;u.appendChild(a);}else{u.appendChild(document.createTextNode(p.usage_url));}
c.appendChild(u);
if(p.channels.length){c.appendChild(txt('div','line','\ud83d\udce1 \u0627\u0644\u0642\u0646\u0648\u0627\u062a: '+p.channels.join(' \u00b7 ')));}
p.sections.forEach(function(s){var h=el('div','sec');h.appendChild(document.createTextNode(s.title));if(s.conflict){h.appendChild(txt('span','conf',s.conflict));}c.appendChild(h);
var ul=el('ul');s.items.forEach(function(it){it.lines.forEach(function(ln){var li=el('li');if(!it.active){li.className='old';}li.appendChild(document.createTextNode(ln+' '));li.appendChild(txt('span','by','\u2014 '+it.by+' \u00b7 '+it.at));if(it.reverify){li.appendChild(txt('span','badge rev','\ud83d\udd01 \u064a\u062d\u062a\u0627\u062c \u0625\u0639\u0627\u062f\u0629 \u0641\u062d\u0635'));}ul.appendChild(li);});});c.appendChild(ul);});
return c;}
function match(p){var s=q.value.trim().toLowerCase();if(s){var hay=(p.host+' '+p.name+' '+p.models.join(' ')).toLowerCase();if(hay.indexOf(s)<0){return false;}}
if(st.value&&p.status_key!==st.value){return false;}if(fr.checked&&!p.free){return false;}if(rv.checked&&!p.reverify){return false;}
var keys=Object.keys(sel).filter(function(k){return sel[k];});if(keys.length){var ok=keys.some(function(k){return p.models.indexOf(k)>=0;});if(!ok){return false;}}return true;}
function render(){while(out.firstChild){out.removeChild(out.firstChild);}var n=0;P.forEach(function(p){if(match(p)){out.appendChild(card(p));n++;}});cnt.textContent=String(n)+' / '+String(P.length);}
[q,st,fr,rv].forEach(function(e){e.addEventListener('input',render);e.addEventListener('change',render);});
render();
})();
"""


def render_html(providers: list[dict], generated_at_utc: str) -> str:
    enums = load_enums()
    model_buttons = [str(enums["model_short"][m]) for m in enums["models_full"]]
    data = {"generated_at_utc": generated_at_utc, "generated_at_cairo": _cairo(generated_at_utc), "models": model_buttons, "providers": providers}
    counts = {s: 0 for s in STATUS_ORDER}
    for p in providers:
        counts[p["status"]] += 1
    summary = " · ".join(f"{s}: {counts[s]}" for s in STATUS_ORDER if counts[s])
    options = "".join(
        f'<option value="{html.escape(STATUS_KEYS[s])}">{html.escape(s)}</option>' for s in STATUS_ORDER
    )
    return (
        '<!DOCTYPE html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>" + html.escape("📚 كتالوج مزودي الموديلات") + "</title>\n"
        "<style>" + _CSS + "</style>\n</head>\n<body>\n<header>\n"
        "<h1>" + html.escape("📚 كتالوج مزودي الموديلات") + "</h1>\n"
        '<div class="muted">' + html.escape(f"آخر تحديث: {_cairo(generated_at_utc)} · {len(providers)} مزود" + (f" — {summary}" if summary else "")) + "</div>\n"
        "</header>\n<section class=\"tools\">\n"
        '<input id="q" type="search" placeholder="' + html.escape("ابحث: المزود / الدومين / الموديل") + '" aria-label="' + html.escape("بحث") + '">\n'
        '<select id="st" aria-label="' + html.escape("الحالة") + '"><option value="">' + html.escape("كل الحالات") + "</option>" + options + "</select>\n"
        '<label class="sw"><input id="free" type="checkbox">' + html.escape("مجاني فقط") + "</label>\n"
        '<label class="sw"><input id="rev" type="checkbox">' + html.escape("يحتاج إعادة فحص") + "</label>\n"
        '<span class="muted">' + html.escape("النتائج:") + ' <span id="count">0</span></span>\n'
        '<div id="models" class="models" aria-label="' + html.escape("فلتر الموديلات") + '"></div>\n'
        "</section>\n<main id=\"cards\"></main>\n"
        '<script type="application/json" id="hub-data">' + safe_json_for_script(data) + "</script>\n"
        "<script>" + _JS + "</script>\n</body>\n</html>\n"
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build(repo_root: str | Path) -> tuple[str, str, list[dict], str]:
    repo_root = Path(repo_root)
    pieces = load_pieces(repo_root)
    reviews = load_reviews(repo_root)
    generated_at = compute_generated_at(pieces, reviews)
    providers = group_providers(apply_reviews(pieces, reviews))
    return render_markdown(providers, generated_at), render_html(providers, generated_at), providers, generated_at


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="build_catalog", description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--out-md", default=None, help="default: <repo>/CATALOG.md")
    parser.add_argument("--out-html", default=None, help="default: <repo>/docs/index.html")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    repo = Path(args.repo)
    if not repo.is_dir():
        print(f"USAGE_ERROR repo root not found: {repo}")
        return 2
    md, page, providers, generated_at = build(repo)
    out_md = Path(args.out_md) if args.out_md else repo / "CATALOG.md"
    out_html = Path(args.out_html) if args.out_html else repo / "docs" / "index.html"
    _write(out_md, md)
    _write(out_html, page)
    print(f"CATALOG: {len(providers)} providers, generated_at={generated_at}, md={out_md}, html={out_html}")
    return 0


__all__ = [
    "load_pieces",
    "load_reviews",
    "apply_reviews",
    "compute_generated_at",
    "compress_models",
    "group_providers",
    "render_markdown",
    "render_html",
    "safe_json_for_script",
    "build",
    "main",
]

if __name__ == "__main__":
    sys.exit(main())
