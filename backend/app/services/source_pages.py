"""Anonymous, bounded excerpts of sources discovered in the current branch.

URLs are data, not authority: every redirect and DNS answer is validated. The
connection is pinned to the checked public IP while TLS still checks the hostname.
No model/provider credentials, environment proxy or browser cookies are used.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from html.parser import HTMLParser
import ipaddress
import re
import socket
from typing import Any
from urllib.parse import urljoin

import httpx

from .prompt import fence_untrusted

MAX_PAGES = 2
MAX_BYTES = 200 * 1024
MAX_CHARS = 6000
MAX_REDIRECTS = 3

READ_WEB_PAGE_SCHEMA = {
    "type": "function", "function": {
        "name": "read_web_page",
        "description": "读取本分支 web_search 返回的公开网页摘录。最多两页，仅支持 HTML/纯文本；不代表阅读全文、真实性或发布时间已核实。失败时如实说明，不绕过访问限制。",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "本分支搜索结果中的完整 URL"},
        }, "required": ["url"], "additionalProperties": False},
    },
}


def source_url(value: Any) -> str:
    if (not isinstance(value, str) or not value or len(value) > 2048
            or re.search(r"[\x00-\x20\x7f\\]", value)):
        raise ValueError("来源 URL 格式无效")
    try:
        url = httpx.URL(value)
        if (url.scheme not in {"http", "https"} or not url.host or url.userinfo
                or url.port not in {None, 80 if url.scheme == "http" else 443}):
            raise ValueError("只允许无凭据、标准端口的 HTTP/HTTPS 来源")
        return str(url.copy_with(fragment=None))
    except (httpx.InvalidURL, UnicodeError) as exc:
        raise ValueError("来源 URL 格式无效") from exc


def remember_sources(cache: dict, scope: str, sources: list) -> None:
    allowed = cache.setdefault(f"pages:allowed:{scope}", {})
    for item in sources:
        try:
            url = source_url(item.get("url"))
        except (ValueError, AttributeError):
            continue
        allowed[url] = True


def _resolve_public(url: str) -> tuple[httpx.URL, str]:
    parsed = httpx.URL(source_url(url))
    try:
        addresses = socket.getaddrinfo(parsed.host, parsed.port or (
            443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError("来源主机无法解析") from exc
    if not addresses:
        raise ValueError("来源主机没有可用地址")
    ips = [ipaddress.ip_address(row[4][0]) for row in addresses]
    if any(not ip.is_global or ip.is_multicast or (ip.version == 6 and ip.ipv4_mapped
                               and not ip.ipv4_mapped.is_global) for ip in ips):
        raise ValueError("不得读取内网、环回、链路本地或保留地址")
    return parsed, str(ips[0])


class _PageText(HTMLParser):
    _skip = {"script", "style", "nav", "footer", "form", "aside", "noscript", "template"}
    _void = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    _metadata = {"citation_title", "citation_author", "citation_publication_date",
                 "citation_date", "citation_doi", "article:published_time", "dcterms.issued"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden: list[str] = []
        self.in_title = False
        self.title: list[str] = []
        self.text: list[str] = []
        self.metadata: dict[str, list[str]] = {}
        self.metadata_truncated = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and not self.hidden:
            name = (attrs.get("name") or attrs.get("property") or "").lower()
            value = " ".join((attrs.get("content") or "").split())
            if name in self._metadata and value:
                if sum(map(len, self.metadata.values())) < 20:
                    self.metadata.setdefault(name, []).append(value[:300])
                    self.metadata_truncated |= len(value) > 300
                else:
                    self.metadata_truncated = True
        hidden = tag in self._skip or "hidden" in attrs or attrs.get("aria-hidden") == "true"
        if (self.hidden or hidden) and tag not in self._void:
            self.hidden.append(tag)
        elif tag == "title":
            self.in_title = True

    def handle_endtag(self, tag):
        if tag in self.hidden:
            self.hidden = self.hidden[:self.hidden.index(tag)]
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.hidden:
            return
        if self.in_title:
            self.title.append(data)
        else:
            self.text.append(data)


async def _fetch_excerpt(url: str) -> dict:
    current = url
    # Bounds include DNS, all redirects and the streamed response body.
    async with asyncio.timeout(10):
        for hop in range(MAX_REDIRECTS + 1):
            parsed, pinned_ip = await asyncio.to_thread(_resolve_public, current)
            pinned_url = parsed.copy_with(host=pinned_ip)
            headers = {"Host": parsed.netloc.decode("ascii"), "User-Agent": "AegisMesh/0.1",
                       "Accept": "text/html,text/plain;q=0.9", "Accept-Encoding": "identity"}
            async with httpx.AsyncClient(timeout=5, follow_redirects=False, trust_env=False) as client:
                async with client.stream("GET", pinned_url, headers=headers,
                                         extensions={"sni_hostname": parsed.host}) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location or hop == MAX_REDIRECTS:
                            raise RuntimeError("来源重定向过多或无有效地址")
                        target = source_url(urljoin(current, location))
                        if parsed.scheme == "https" and httpx.URL(target).scheme != "https":
                            raise ValueError("不得通过重定向降低来源 TLS 保护")
                        current = target
                        continue
                    if response.status_code != 200:
                        raise RuntimeError(f"来源返回 HTTP {response.status_code}，未取得正文")
                    mime = response.headers.get("content-type", "").split(";", 1)[0].lower().strip()
                    if mime not in {"text/html", "application/xhtml+xml", "text/plain"}:
                        raise RuntimeError("当前原文读取仅支持 HTML/纯文本，其他文件需上传后解析")
                    if response.headers.get("content-encoding", "identity").lower() not in {"", "identity"}:
                        raise RuntimeError("来源未提供未压缩正文，未读取")
                    body = bytearray()
                    truncated = False
                    async for chunk in response.aiter_raw():
                        room = MAX_BYTES - len(body)
                        body.extend(chunk[:room])
                        if len(chunk) > room or len(body) >= MAX_BYTES:
                            truncated = True
                            break
                    try:
                        text = body.decode(response.encoding or "utf-8", errors="replace")
                    except LookupError:
                        text = body.decode("utf-8", errors="replace")
                    title = ""
                    metadata, metadata_truncated = {}, False
                    if mime != "text/plain":
                        page = _PageText()
                        page.feed(text)
                        title = " ".join(" ".join(page.title).split())[:300]
                        metadata, metadata_truncated = page.metadata, page.metadata_truncated
                        text = " ".join(" ".join(page.text).split())
                    else:
                        text = " ".join(text.split())
                    if not text.strip():
                        raise RuntimeError("来源没有可读取正文，未取得证据")
                    return {"url": url, "final_url": current, "title": title,
                            "source_metadata": metadata, "metadata_truncated": metadata_truncated,
                            "content": fence_untrusted("网页原文摘录，仍须核验", text[:MAX_CHARS]),
                            "retrieved_at": datetime.now(timezone.utc).isoformat(),
                            "truncated": truncated or len(text) > MAX_CHARS,
                            "evidence_status": "page_excerpt",
                            "notice": "只读取了有限网页摘录，不等于阅读全文或事实已核实；题录/日期字段是网页自身的声明，查询时间不是发布时间。"}
    raise RuntimeError("来源读取失败")


class SourcePageReader:
    def __init__(self, cache: dict, scope: str, *, max_pages: int | None = None):
        if max_pages is not None and (type(max_pages) is not int or not 0 <= max_pages <= MAX_PAGES):
            raise ValueError("任务原文读取上限无效")
        self.cache, self.scope = cache, scope
        self.max_pages = MAX_PAGES if max_pages is None else max_pages

    async def __call__(self, arguments: dict) -> dict:
        if not isinstance(arguments, dict):
            raise ValueError("原文读取参数必须是对象")
        url = source_url(arguments.get("url"))
        if url not in self.cache.get(f"pages:allowed:{self.scope}", {}):
            raise ValueError("只能读取当前分支 web_search 已返回的来源")
        budget = self.cache.setdefault(f"pages:budget:{self.scope}", {"used": 0})
        def remaining():
            return {"used": budget["used"], "limit": self.max_pages,
                    "remaining": max(0, self.max_pages - budget["used"])}
        key = f"pages:cache:{url}"
        seen = budget.setdefault("seen", [])
        if key in self.cache and url in seen:
            return {**self.cache[key], "cached": True, "page_budget": remaining()}
        if budget["used"] >= self.max_pages:
            return {"status": "budget_exhausted", "url": url, "evidence_status": "unread",
                    "notice": "本分支已达到原文读取上限，未发起新请求。", "page_budget": remaining()}
        # Reserve synchronously, before DNS/I/O; concurrent tools cannot overspend.
        # A first read of a cached page still counts for this branch's excerpt limit.
        budget["used"] += 1
        if url not in seen:
            seen.append(url)
        if key in self.cache:
            return {**self.cache[key], "cached": True, "page_budget": remaining()}
        try:
            result = await _fetch_excerpt(url)
        except (httpx.HTTPError, TimeoutError, OSError) as exc:
            raise RuntimeError("来源读取失败或超时，未取得正文；不绕过访问限制") from exc
        self.cache[key] = result
        return {**result, "page_budget": remaining()}
