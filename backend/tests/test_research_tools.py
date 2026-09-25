from __future__ import annotations

import json
from pathlib import Path
from app.services.tools import ToolRegistry


def test_extract_file_content_txt_and_json(tmp_path: Path) -> None:
    registry = ToolRegistry()
    # Test TXT
    txt_file = tmp_path / "test_paper.txt"
    txt_file.write_text("这是关于多智能体强化学习的学术论文正文内容。\n第二段进行理论证明分析。", encoding="utf-8")

    res = registry.execute("extract_file_content", {"file_path": str(txt_file)})
    assert res["ok"] is True
    assert res["result"]["filename"] == "test_paper.txt"
    assert res["result"]["file_type"] == "txt"
    assert "多智能体强化学习" in res["result"]["content"]
    assert res["result"]["char_count"] > 0

    # Test JSON
    json_file = tmp_path / "dataset_meta.json"
    json_file.write_text(json.dumps({"dataset": "MMLU", "samples": 14000, "domains": ["CS", "Math"]}), encoding="utf-8")
    res_json = registry.execute("extract_file_content", {"file_path": str(json_file)})
    assert res_json["ok"] is True
    assert "MMLU" in res_json["result"]["content"]


def test_citation_tool() -> None:
    registry = ToolRegistry()

    # 1. Parse BibTeX
    bibtex = """@article{vaswani2017attention,
      title={Attention is all you need},
      author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
      journal={Advances in neural information processing systems},
      volume={30},
      year={2017},
      doi={10.5555/3295222.3295349}
    }"""
    parsed = registry.execute("citation_tool", {"action": "parse_bibtex", "bibtex_str": bibtex})
    assert parsed["ok"] is True
    res = parsed["result"]
    assert res["key"] == "vaswani2017attention"
    assert res["title"] == "Attention is all you need"
    assert "Vaswani, Ashish" in res["authors"]
    assert res["year"] == "2017"
    assert res["doi"] == "10.5555/3295222.3295349"

    # 2. Format Citation (GBT 7714)
    formatted_gb = registry.execute("citation_tool", {
        "action": "format_citation",
        "style": "gbt7714",
        "citation_data": res,
    })
    assert formatted_gb["ok"] is True
    assert "Attention is all you need" in formatted_gb["result"]["formatted_citation"]
    assert "2017" in formatted_gb["result"]["formatted_citation"]

    # 3. Format Citation (IEEE)
    formatted_ieee = registry.execute("citation_tool", {
        "action": "format_citation",
        "style": "ieee",
        "citation_data": res,
    })
    assert formatted_ieee["ok"] is True
    assert 'doi: 10.5555/3295222.3295349' in formatted_ieee["result"]["formatted_citation"]

    # 4. Verify Fields
    verified = registry.execute("citation_tool", {
        "action": "verify_fields",
        "citation_data": res,
    })
    assert verified["ok"] is True
    assert verified["result"]["is_complete"] is True
    assert verified["result"]["has_doi"] is True


def test_text_similarity_check() -> None:
    registry = ToolRegistry()

    # High similarity test
    text_a = "在大规模分布式多智能体强化学习系统中，策略梯度的方差会随着智能体数量呈指数级增加，导致训练过程极度不稳定。"
    text_b = "在大规模分布式多智能体强化学习系统中，策略梯度的方差会随智能体数量增加，导致训练过程极度不稳定。"

    sim = registry.execute("text_similarity_check", {
        "target_text": text_a,
        "reference_text": text_b,
        "ngram_size": 6,
    })
    assert sim["ok"] is True
    assert sim["result"]["similarity_score_percent"] > 25.0
    assert "高重合风险" in sim["result"]["risk_level"]
    assert len(sim["result"]["overlapping_snippets"]) > 0

    # Low similarity test
    text_c = "量子计算中的Shor算法可以在多项式时间内完成大整数质因子分解。"
    sim_low = registry.execute("text_similarity_check", {
        "target_text": text_a,
        "reference_text": text_c,
        "ngram_size": 6,
    })
    assert sim_low["ok"] is True
    assert sim_low["result"]["similarity_score_percent"] < 10.0
    assert "低风险" in sim_low["result"]["risk_level"]
