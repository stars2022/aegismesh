from __future__ import annotations

import ast
import csv
import inspect
import json
import operator
import os
from pathlib import Path
import re
from datetime import datetime
from typing import Any, Callable
import zipfile
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    import pypdf
except ImportError:
    pypdf = None


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, tuple[dict[str, Any], Callable[[dict[str, Any]], Any]]] = {
            "calculator": (
                {
                    "type": "function",
                    "function": {
                        "name": "calculator",
                        "description": "计算基础算术表达式。",
                        "parameters": {
                            "type": "object",
                            "properties": {"expression": {"type": "string"}},
                            "required": ["expression"],
                            "additionalProperties": False,
                        },
                    },
                },
                self._calculator,
            ),
            "current_time": (
                {
                    "type": "function",
                    "function": {
                        "name": "current_time",
                        "description": "获取指定 IANA 时区的当前时间。",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "timezone": {"type": "string", "default": "UTC"}
                            },
                            "additionalProperties": False,
                        },
                    },
                },
                self._current_time,
            ),
            "extract_file_content": (
                {
                    "type": "function",
                    "function": {
                        "name": "extract_file_content",
                        "description": "读取并解析本地或已上传的研究文献与数据文件（支持 PDF、DOCX、TXT、MD、CSV、JSON 格式），提取正文文本、标题大纲与统计信息。",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "file_path": {
                                    "type": "string",
                                    "description": "文件相对路径、绝对路径或文件名（如 'data/uploads/paper.pdf' 或 'paper.pdf'）",
                                },
                                "max_chars": {
                                    "type": "integer",
                                    "description": "最大提取字符数（默认 20000，最大 100000）",
                                    "default": 20000,
                                },
                                "page_start": {
                                    "type": "integer",
                                    "description": "起始页码（仅对 PDF 有效，从 1 开始）",
                                    "default": 1,
                                },
                                "page_end": {
                                    "type": "integer",
                                    "description": "结束页码（仅对 PDF 有效）",
                                },
                            },
                            "required": ["file_path"],
                            "additionalProperties": False,
                        },
                    },
                },
                self._extract_file_content,
            ),
            "citation_tool": (
                {
                    "type": "function",
                    "function": {
                        "name": "citation_tool",
                        "description": "学术引证与 BibTeX 工具。支持 BibTeX 解析、引用格式标准化（GB/T 7714-2015、IEEE、APA）与引文必要字段核验。",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "action": {
                                    "type": "string",
                                    "enum": ["parse_bibtex", "format_citation", "verify_fields"],
                                    "description": "操作类型：parse_bibtex (解析BibTeX), format_citation (格式化输出引用), verify_fields (核验必填字段)",
                                },
                                "bibtex_str": {
                                    "type": "string",
                                    "description": "BibTeX 字符串内容（用于 parse_bibtex）",
                                },
                                "citation_data": {
                                    "type": "object",
                                    "description": "结构化文献元数据，包含 title, authors, year, journal/booktitle, volume, pages, doi 等",
                                },
                                "style": {
                                    "type": "string",
                                    "enum": ["gbt7714", "ieee", "apa"],
                                    "default": "gbt7714",
                                    "description": "引文标准风格：gbt7714 (中文国标), ieee (IEEE), apa (APA)",
                                },
                            },
                            "required": ["action"],
                            "additionalProperties": False,
                        },
                    },
                },
                self._citation_tool,
            ),
            "text_similarity_check": (
                {
                    "type": "function",
                    "function": {
                        "name": "text_similarity_check",
                        "description": "学术文本相似度分析与查重比对工具。对比目标文本与参考资料之间的 n-gram 重叠度、重复片段识别与原创度风险等级评估。",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "target_text": {
                                    "type": "string",
                                    "description": "待检测的目标文本或段落",
                                },
                                "reference_text": {
                                    "type": "string",
                                    "description": "比对的参考资料、参考文献正文或已知资料库片段",
                                },
                                "ngram_size": {
                                    "type": "integer",
                                    "description": "连续字符比对窗口（默认 8 字符，即 8-gram）",
                                    "default": 8,
                                },
                            },
                            "required": ["target_text", "reference_text"],
                            "additionalProperties": False,
                        },
                    },
                },
                self._text_similarity_check,
            ),
        }

    def register(self, name: str, schema: dict[str, Any], executor: Callable[[dict[str, Any]], Any]) -> None:
        self._tools[name] = (schema, executor)

    def schemas(self, enabled: list[str]) -> list[dict[str, Any]]:
        return [self._tools[name][0] for name in enabled if name in self._tools]

    def execute(self, name: str, arguments: dict[str, Any]) -> Any:
        if name not in self._tools:
            return {"ok": False, "error": f"工具未注册：{name}"}
        try:
            outcome = self._tools[name][1](arguments)
        except (ArithmeticError, SyntaxError, ValueError, TypeError, ZoneInfoNotFoundError, RuntimeError) as exc:
            return {"ok": False, "error": str(exc)}
        if inspect.isawaitable(outcome):

            async def _finish() -> dict[str, Any]:
                try:
                    return {"ok": True, "result": await outcome}
                except (ValueError, TypeError, RuntimeError) as exc:
                    return {"ok": False, "error": str(exc)}

            return _finish()
        return {"ok": True, "result": outcome}

    @staticmethod
    def _calculator(arguments: dict[str, Any]) -> float | int:
        expression = arguments.get("expression")
        if not isinstance(expression, str) or not expression.strip():
            raise ValueError("expression 不能为空")
        if len(expression) > 200:
            raise ValueError("expression 过长")
        tree = ast.parse(expression, mode="eval")
        binary = {
            ast.Add: operator.add,
            ast.Sub: operator.sub,
            ast.Mult: operator.mul,
            ast.Div: operator.truediv,
            ast.FloorDiv: operator.floordiv,
            ast.Mod: operator.mod,
            ast.Pow: operator.pow,
        }
        unary = {ast.UAdd: operator.pos, ast.USub: operator.neg}

        def evaluate(node: ast.AST) -> float | int:
            if isinstance(node, ast.Expression):
                return evaluate(node.body)
            if isinstance(node, ast.Constant) and type(node.value) in {int, float}:
                return node.value
            if isinstance(node, ast.BinOp) and type(node.op) in binary:
                left, right = evaluate(node.left), evaluate(node.right)
                if isinstance(node.op, ast.Pow) and abs(right) > 10:
                    raise ValueError("指数超出允许范围")
                return binary[type(node.op)](left, right)
            if isinstance(node, ast.UnaryOp) and type(node.op) in unary:
                return unary[type(node.op)](evaluate(node.operand))
            raise ValueError("仅支持基础算术表达式")

        result = evaluate(tree)
        if abs(float(result)) > 1e100:
            raise ValueError("计算结果超出允许范围")
        return result

    @staticmethod
    def _current_time(arguments: dict[str, Any]) -> dict[str, str]:
        timezone_name = arguments.get("timezone", "UTC")
        if not isinstance(timezone_name, str) or len(timezone_name) > 80:
            raise ValueError("timezone 无效")
        now = datetime.now(ZoneInfo(timezone_name))
        return {"timezone": timezone_name, "iso": now.isoformat()}

    @staticmethod
    def _extract_file_content(arguments: dict[str, Any]) -> dict[str, Any]:
        file_path_str = str(arguments.get("file_path") or "").strip()
        if not file_path_str:
            raise ValueError("file_path 不能为空")
        max_chars = min(int(arguments.get("max_chars") or 20000), 100000)
        page_start = max(1, int(arguments.get("page_start") or 1))
        page_end = int(arguments.get("page_end")) if arguments.get("page_end") else None

        path = Path(file_path_str)
        if not path.is_absolute():
            candidates = [
                path,
                Path("data/uploads") / path,
                Path("backend/data/uploads") / path,
                Path("backend") / path,
            ]
            for cand in candidates:
                if cand.exists() and cand.is_file():
                    path = cand
                    break
            else:
                found = list(Path("data/uploads").glob(f"**/{path.name}")) or list(
                    Path("backend/data/uploads").glob(f"**/{path.name}")
                )
                if found:
                    path = found[0]
                elif not path.exists():
                    raise FileNotFoundError(f"文件不存在: {file_path_str}")

        if not path.is_file():
            raise ValueError(f"指定路径不是文件: {path}")

        suffix = path.suffix.lower()
        extracted_text = ""
        total_pages = 1
        outline: list[str] = []

        if suffix == ".pdf":
            if pypdf is None:
                raise RuntimeError("未安装 pypdf，无法解析 PDF 文件")
            reader = pypdf.PdfReader(str(path))
            total_pages = len(reader.pages)
            end_page = min(page_end, total_pages) if page_end else total_pages
            page_texts = []
            for i in range(page_start - 1, end_page):
                if i < total_pages:
                    text = reader.pages[i].extract_text() or ""
                    page_texts.append(f"--- [第 {i + 1} 页] ---\n{text.strip()}")
            extracted_text = "\n\n".join(page_texts)
            if getattr(reader, "outline", None):
                for item in reader.outline:
                    if hasattr(item, "title"):
                        outline.append(str(item.title))

        elif suffix in {".docx", ".doc"}:
            try:
                with zipfile.ZipFile(str(path)) as docx_zip:
                    xml_content = docx_zip.read("word/document.xml")
                    tree = ET.fromstring(xml_content)
                    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
                    paras = []
                    for p in tree.findall(".//w:p", ns):
                        texts = [t.text for t in p.findall(".//w:t", ns) if t.text]
                        if texts:
                            paras.append("".join(texts))
                    extracted_text = "\n\n".join(paras)
            except Exception as e:
                raise ValueError(f"DOCX 解析失败: {e}")

        elif suffix in {".txt", ".md", ".py", ".html", ".log", ".tex"}:
            try:
                extracted_text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                extracted_text = path.read_text(encoding="gbk", errors="replace")

        elif suffix == ".csv":
            rows = []
            with path.open("r", encoding="utf-8", errors="replace") as f:
                reader = csv.reader(f)
                for idx, row in enumerate(reader):
                    if idx < 50:
                        rows.append(" | ".join(row))
                    else:
                        break
            extracted_text = "\n".join(rows)

        elif suffix == ".json":
            data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            extracted_text = json.dumps(data, ensure_ascii=False, indent=2)

        else:
            try:
                extracted_text = path.read_text(encoding="utf-8")
            except Exception:
                raise ValueError(f"不支持解析的文件类型: {suffix}")

        char_count = len(extracted_text)
        truncated = char_count > max_chars
        content_slice = extracted_text[:max_chars]

        return {
            "ok": True,
            "filename": path.name,
            "file_type": suffix.lstrip("."),
            "file_size_bytes": path.stat().st_size,
            "total_pages": total_pages,
            "char_count": char_count,
            "truncated": truncated,
            "outline": outline[:20],
            "content": content_slice,
        }

    @staticmethod
    def _citation_tool(arguments: dict[str, Any]) -> dict[str, Any]:
        action = str(arguments.get("action") or "").strip()
        style = str(arguments.get("style") or "gbt7714").lower()

        if action == "parse_bibtex":
            bibtex_str = str(arguments.get("bibtex_str") or "").strip()
            if not bibtex_str:
                raise ValueError("bibtex_str 不能为空")
            m = re.search(r"@(\w+)\s*\{\s*([^,]+),", bibtex_str)
            if not m:
                raise ValueError("无效的 BibTeX 格式：未找到 @type{key,")
            entry_type, key = m.group(1).lower(), m.group(2).strip()
            fields: dict[str, str] = {}
            for field_match in re.finditer(r'(\w+)\s*=\s*[\{"\']([^"\'\}]+)[\}"\']', bibtex_str):
                k, v = field_match.group(1).lower(), field_match.group(2).strip()
                fields[k] = v
            return {
                "ok": True,
                "entry_type": entry_type,
                "key": key,
                "title": fields.get("title", ""),
                "authors": [a.strip() for a in fields.get("author", "").split(" and ") if a.strip()],
                "year": fields.get("year", ""),
                "journal": fields.get("journal", fields.get("booktitle", "")),
                "volume": fields.get("volume", ""),
                "pages": fields.get("pages", ""),
                "doi": fields.get("doi", ""),
                "raw_fields": fields,
            }

        elif action == "format_citation":
            data = arguments.get("citation_data") or {}
            if not isinstance(data, dict):
                raise ValueError("citation_data 必须为对象")
            title = str(data.get("title") or "").strip()
            authors = data.get("authors") or []
            if isinstance(authors, str):
                authors = [authors]
            year = str(data.get("year") or "").strip()
            venue = str(data.get("journal") or data.get("booktitle") or "").strip()
            volume = str(data.get("volume") or "").strip()
            pages = str(data.get("pages") or "").strip()
            doi = str(data.get("doi") or "").strip()

            authors_str = ", ".join(authors) if authors else "佚名"
            if style == "gbt7714":
                cite = f"{authors_str}. {title}[J/OL]. {venue}, {year}"
                if volume:
                    cite += f", {volume}"
                if pages:
                    cite += f": {pages}"
                if doi:
                    cite += f". DOI: {doi}"
            elif style == "ieee":
                cite = f'{authors_str}, "{title}," {venue}'
                if volume:
                    cite += f", vol. {volume}"
                if pages:
                    cite += f", pp. {pages}"
                cite += f", {year}."
                if doi:
                    cite += f" doi: {doi}."
            else:
                cite = f"{authors_str} ({year}). {title}. {venue}"
                if volume:
                    cite += f", {volume}"
                if pages:
                    cite += f", {pages}"
                cite += "."
                if doi:
                    cite += f" https://doi.org/{doi}"

            return {
                "ok": True,
                "style": style,
                "formatted_citation": cite,
            }

        elif action == "verify_fields":
            data = arguments.get("citation_data") or {}
            if not isinstance(data, dict):
                raise ValueError("citation_data 必须为对象")
            missing = []
            for req in ["title", "authors", "year"]:
                if not data.get(req):
                    missing.append(req)
            if not data.get("journal") and not data.get("booktitle"):
                missing.append("journal/booktitle")
            has_doi = bool(data.get("doi"))
            return {
                "ok": True,
                "is_complete": len(missing) == 0,
                "missing_fields": missing,
                "has_doi": has_doi,
                "recommendation": "文献引用字段完整" if not missing else f"缺失必要引证字段: {', '.join(missing)}",
            }
        else:
            raise ValueError(f"未知 action: {action}")

    @staticmethod
    def _text_similarity_check(arguments: dict[str, Any]) -> dict[str, Any]:
        target = str(arguments.get("target_text") or "").strip()
        ref = str(arguments.get("reference_text") or "").strip()
        if not target or not ref:
            raise ValueError("target_text 与 reference_text 均不能为空")
        ngram_size = max(4, min(int(arguments.get("ngram_size") or 8), 32))

        def clean(s: str) -> str:
            return re.sub(r"[\s\.,;:!?，。；：！？、\(\)（）《》\"\'\n\r\t]+", "", s).lower()

        clean_target = clean(target)
        clean_ref = clean(ref)

        if len(clean_target) < ngram_size or len(clean_ref) < ngram_size:
            return {
                "ok": True,
                "similarity_score_percent": 0.0,
                "risk_level": "样本过短，无法提取足额 n-gram",
                "overlapping_snippets": [],
            }

        target_ngrams = {clean_target[i : i + ngram_size] for i in range(len(clean_target) - ngram_size + 1)}
        ref_ngrams = {clean_ref[i : i + ngram_size] for i in range(len(clean_ref) - ngram_size + 1)}

        overlap = target_ngrams.intersection(ref_ngrams)
        overlap_ratio = len(overlap) / max(len(target_ngrams), 1)
        score_percent = round(overlap_ratio * 100, 2)

        overlapping_snippets = []
        for ng in list(overlap)[:6]:
            idx = clean_target.find(ng)
            if idx != -1:
                start = max(0, idx - 4)
                end = min(len(clean_target), idx + ngram_size + 8)
                snippet = clean_target[start:end]
                if snippet not in overlapping_snippets:
                    overlapping_snippets.append(snippet)

        if score_percent >= 25.0:
            risk = "高重合风险 (存在大段文字直接重合，需重点降重与重构表达)"
        elif score_percent >= 10.0:
            risk = "中度重合关注 (存在部分概念复用或标准引文，建议复核改写)"
        else:
            risk = "低风险 (原创度良好，未发现严重段落级抄袭或直接雷同)"

        return {
            "ok": True,
            "ngram_size": ngram_size,
            "target_length": len(target),
            "reference_length": len(ref),
            "similarity_score_percent": score_percent,
            "risk_level": risk,
            "overlapping_snippets": overlapping_snippets[:5],
        }
