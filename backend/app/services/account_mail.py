"""Transactional email presentation only; challenge creation/consumption stays in the API."""
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from html import escape
from pathlib import Path
from urllib.parse import urlencode, urlsplit

LOGO_PATH = Path(__file__).resolve().parents[1] / "assets/account-mail-logo.png"
LOGO_CID = "brand@aegismesh"
COPY = {
    "register": ("确认你的邮箱", "欢迎使用 AegisMesh。验证邮箱后，即可完成注册。", "验证邮箱", "注册"),
    "reset": ("重置你的密码", "我们收到了你的密码重置请求。点击下方按钮，设置新密码。", "重置密码", "重置"),
}


def build_account_mail(*, sender: str, recipient: str, origin: str, purpose: str,
                       token: str, preview: bool = False) -> EmailMessage:
    if purpose not in COPY:
        raise ValueError("Unsupported account mail purpose")
    title, description, button, operation = COPY[purpose]
    # Keep the token in a fragment: it must never reach a proxy/access log.
    link = origin.rstrip("/") + "/login?account_action=" + purpose + "#" + urlencode({"token": token})
    if preview:
        link, button = origin.rstrip("/") + "/login", "查看登录页"
    href = escape(link, quote=True)
    site = escape(urlsplit(origin).hostname or "AegisMesh")
    notice = "这是一封样式预览，不会创建账号或修改密码。" if preview else "如果不是你本人操作，请忽略这封邮件。"
    preheader = notice if preview else f"{title}，链接 15 分钟内有效。"
    browser_note = "预览按钮仅打开登录页。" if preview else f"请在发起{operation}请求的浏览器中打开。"
    html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>{title} · AegisMesh</title>
<style>
@media screen and (max-width: 480px) {{ .mail-outer {{ padding:24px 12px!important; }} .mail-inner {{ padding:28px 24px!important; }} .mail-title {{ font-size:25px!important; }} }}
@media (prefers-color-scheme: dark) {{
 .mail-page,.mail-outer {{ background:#101011!important; }} .mail-card {{ background:#1b1b1d!important;border-color:#303033!important; }}
 .mail-brand,.mail-title {{ color:#eeeeec!important; }} .mail-copy {{ color:#c5c5c0!important; }} .mail-muted {{ color:#a2a29b!important; }}
 .mail-action {{ background:#eeeeec!important;color:#161614!important; }} .mail-rule {{ border-color:#303033!important; }}
 .mail-validity {{ color:#69bd97!important; }} .mail-link {{ color:#c5c5c0!important; }}
}}
</style></head>
<body class="mail-page" style="margin:0;padding:0;background:#f5f5f2;color:#161614;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif;">
<div style="display:none;font-size:1px;line-height:1px;color:transparent;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">{preheader}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="mail-outer" align="center" style="padding:48px 20px;background:#f5f5f2;">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="mail-card" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e9e9e5;border-radius:14px;">
<tr><td class="mail-inner" style="padding:36px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
<td width="40" style="width:40px;"><img src="cid:{LOGO_CID}" alt="" width="40" height="40" style="display:block;border:0;border-radius:10px;"></td>
<td class="mail-brand" style="padding-left:12px;font-size:22px;font-weight:700;letter-spacing:-.5px;color:#161614;">AegisMesh</td>
</tr></table>
<h1 class="mail-title" style="margin:36px 0 14px;color:#161614;font-size:28px;line-height:1.35;font-weight:650;letter-spacing:-.6px;">{title}</h1>
<p class="mail-copy" style="margin:0 0 26px;color:#555550;font-size:15px;line-height:1.85;">{description}</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td class="mail-action" align="center" bgcolor="#161614" style="background:#161614;border-radius:10px;mso-padding-alt:14px 28px;">
<a class="mail-action" href="{href}" style="display:inline-block;padding:14px 28px;border:1px solid transparent;border-radius:10px;background:#161614;color:#ffffff;font-size:15px;font-weight:600;line-height:20px;text-decoration:none;text-align:center;">{button}</a>
</td></tr></table>
<p class="mail-validity" style="margin:16px 0 0;color:#15845f;font-size:12px;line-height:1.6;">{"样式预览" if preview else "15 分钟内有效 · 仅可使用一次"}</p>
<p class="mail-muted" style="margin:8px 0 0;color:#777773;font-size:12px;line-height:1.8;">{browser_note}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="mail-rule" style="padding-top:26px;border-bottom:1px solid #e9e9e5;font-size:0;line-height:0;">&nbsp;</td></tr></table>
<p class="mail-muted" style="margin:20px 0 8px;color:#777773;font-size:12px;line-height:1.8;">{notice}</p>
<p class="mail-muted" style="margin:0;color:#777773;font-size:12px;line-height:1.8;">按钮无法打开？<a class="mail-link" href="{href}" style="color:#555550;text-decoration:underline;">使用文字链接</a></p>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
<p class="mail-muted" style="margin:20px 0 0;color:#969690;font-size:11px;line-height:1.6;">AegisMesh &nbsp;·&nbsp; {site}</p>
</td></tr></table></body></html>"""
    message = EmailMessage()
    message["From"], message["To"] = sender, recipient
    message["Subject"] = ("AegisMesh 邮件样式预览" if preview else
                          "AegisMesh 邮箱验证" if purpose == "register" else "AegisMesh 密码重置")
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid(domain=urlsplit(origin).hostname or "aegismesh")
    message.set_content(f"AegisMesh\n\n{title}\n{description}\n\n{button}：\n{link}\n\n"
                        f"{'样式预览' if preview else '15 分钟内有效，仅可使用一次。'}\n{browser_note}\n\n{notice}\n")
    message.add_alternative(html, subtype="html")
    message.get_body(preferencelist=("html",)).add_related(
        LOGO_PATH.read_bytes(), maintype="image", subtype="png", cid=f"<{LOGO_CID}>",
        disposition="inline", filename="aegismesh.png")
    return message
