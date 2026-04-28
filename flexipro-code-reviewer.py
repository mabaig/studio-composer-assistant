#!/usr/bin/env python3
"""
Flexi Review Toolkit -> one Excel report with multiple review sheets.

Core sheets:
1) Glossary_Report
2) API_Findings
3) Redundant APIs
4) Commit Validation
5) Structure Findings
6) Reference Findings
7) Script Findings
8) Credential Findings
9) Response Guard Findings
10) Placeholder Dependency Findings
11) Page Variant Diff Report
12) Mirror Handler Findings
13) Duplicate Call Risk
14) Network Cost Hotspots

What it does:
- Traverses each Flexi JSON file in a page-aware single pass.
- Validates glossary/component naming against the provided glossary.
- Audits Fusion REST usage for payload and projection best practices.
- Detects repeated endpoint usage, duplicate IDs, weak script patterns, and
  broken or unused webservice references.

No fixes are applied. Review-only report.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Set, Tuple
from urllib.parse import urlparse, parse_qs

try:
    import pandas as pd
except Exception as exc:  # pragma: no cover - import environment specific
    pd = None  # type: ignore[assignment]
    PANDAS_IMPORT_ERROR = exc
else:
    PANDAS_IMPORT_ERROR = None

# Optional faster fuzzy matcher
try:
    from rapidfuzz import fuzz  # type: ignore

    def fuzzy_ratio(a: str, b: str) -> int:
        return int(fuzz.ratio(a, b))
except Exception:
    import difflib

    def fuzzy_ratio(a: str, b: str) -> int:
        return int(difflib.SequenceMatcher(None, a, b).ratio() * 100)


# ---------------------------
# Buckets (Glossary)
# ---------------------------
BUCKET_EXACT = "Exact Match"
BUCKET_HIGH = "High Confidence"
BUCKET_MED = "Medium Confidence"
BUCKET_LOW = "Low Confidence"

GLOSSARY_IGNORE_TYPES = {"webservice", "div", "page"}  # for glossary validation only

SCRIPT_MARKERS = ("script:", "groovy:")
SERVICE_REF_METHODS = (
    "callWebService",
    "getResponseCode",
    "getRawResponse",
    "updateRawResponse",
    "addRequestHeader",
)
FUNCTION_CALL_RX = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*call\s*\(")
LINE_COMMENT_RX = re.compile(r"//.*?$", re.MULTILINE)
BLOCK_COMMENT_RX = re.compile(r"/\*.*?\*/", re.DOTALL)
EMPTY_CATCH_RX = re.compile(r"catch\s*\([^)]*\)\s*\{(.*?)\}", re.IGNORECASE | re.DOTALL)

SEVERITY_RANK = {"": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3}
PLACEHOLDER_ONLY_RX = re.compile(r"^\s*\$\{[^}]+\}\s*$")
SENSITIVE_NAME_RX = re.compile(
    r"(?i)(?:pass(?:word)?|pwd|secret|token|api[_-]?key|client[_-]?secret|authorization)"
)
URL_WITH_CREDS_RX = re.compile(r"(?i)https?://[^/\s:@]+:[^/\s@]+@")
AUTH_HEADER_LITERAL_RX = re.compile(
    r"(?i)addRequestHeader\s*\(\s*['\"]Authorization['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)"
)
BASIC_TOKEN_RX = re.compile(r"(?i)\bBasic\s+[A-Za-z0-9+/=]{12,}\b")
BEARER_TOKEN_RX = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{20,}\b")
SENSITIVE_KEY_VALUE_RX = re.compile(
    r"""(?ix)
    (['"]?(?:password|passwd|pwd|secret|client_secret|access_token|refresh_token|api[_-]?key|authorization)['"]?\s*[:=]\s*['"])
    ([^'"]{3,})
    (['"])
    """
)
SENSITIVE_SETTER_RX = re.compile(
    r"""(?ix)
    \b(?:put(?:Session)?Object|set(?:Attribute|Property))\s*\(
        \s*['"]([^'"]*(?:pass|pwd|secret|token|api[_-]?key|authorization)[^'"]*)['"]\s*,
        \s*['"]([^'"]{3,})['"]
    """
)
PLACEHOLDER_RX = re.compile(r"\$\{([^}]+)\}")
OBJECT_SETTER_RX = re.compile(r"""\b(?:flexi\.)?put(?:Session)?Object\s*\(\s*['"]([A-Z0-9_]+)['"]""")
MAP_PUT_RX = re.compile(r"""\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*put\s*\(\s*['"]([A-Z0-9_]+)['"]""")
RAW_RESPONSE_METHOD_RX = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*getRawResponse\s*\(")
RESPONSE_CODE_METHOD_RX = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*getResponseCode\s*\(")
CALL_WEBSERVICE_RX = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*callWebService\s*\(")
JSON_ARRAY_ASSIGN_RX = re.compile(
    r"""\bJSONArray\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^;]*getJSONArray\s*\(\s*['"]([^'"]+)['"]\s*\)""",
    re.IGNORECASE,
)
JSON_ARRAY_DIRECT_INDEX_RX = re.compile(
    r"""getJSONArray\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*get(?:JSONObject|JSONArray|String|Int|Long|Double|Boolean)?\s*\(\s*0\b""",
    re.IGNORECASE,
)
MIRROR_STOPWORDS = {
    "script",
    "groovy",
    "flexi",
    "logger",
    "string",
    "jsonobject",
    "jsonarray",
    "true",
    "false",
    "null",
    "value",
    "hidden",
    "reset",
    "sethidden",
    "setvalue",
    "getvalue",
    "callwebservice",
}
KNOWN_RUNTIME_PREFIXES = (
    "ORACLE_",
    "CURRENT_",
    "ACCESS_",
    "SCM_",
    "SESSION_",
    "USER_",
    "AUTH_",
    "BEARER_",
    "REST_",
)
KNOWN_RUNTIME_EXACT = {
    "CURRENT_TIMESTAMP",
    "INPUT",
}
KNOWN_DUPLICATE_ACTION_PAIRS = (
    frozenset({"NEXT", "DONE"}),
    frozenset({"RECEIVE", "RECEIVE_NEXT"}),
    frozenset({"PUTAWAY", "PUTAWAY_NEXT"}),
    frozenset({"SUBMIT", "SUBMIT_NEXT"}),
    frozenset({"SAVE", "DONE"}),
    frozenset({"SAVE", "SAVE_NEXT"}),
)
VARIANT_SUFFIX_TOKENS = (
    "OLD",
    "NEW",
    "TEMP",
    "BACKUP",
    "BKP",
    "COPY",
    "SALAH",
    "TEST",
)


# ---------------------------
# I/O helpers
# ---------------------------
def prompt_str(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        sys.exit(1)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Review Flexi JSON pages and export findings to Excel.")
    parser.add_argument("--glossary", help="Glossary JSON path")
    parser.add_argument("--pages", help="Flexi page JSON path(s), directory, or glob")
    parser.add_argument("--out", help="Output Excel path")
    return parser


def resolve_cli_or_prompt_inputs(argv: Sequence[str] | None = None) -> Tuple[str, str, str]:
    args = build_arg_parser().parse_args(list(argv) if argv is not None else None)
    glossary_in = args.glossary or prompt_str("Enter glossary JSON path: ")
    flexi_in = args.pages or prompt_str(
        "Enter Flexi page JSON path(s) (single, comma-separated, directory, or glob like pages/*.json): "
    )
    out_in = args.out or prompt_str("Enter output Excel path (e.g., flexi_review_toolkit.xlsx): ")
    return glossary_in, flexi_in, out_in


def load_json(path: Path) -> Any:
    last_error: Exception | None = None
    for encoding in ("utf-8", "utf-8-sig", "utf-16"):
        try:
            with path.open("r", encoding=encoding) as f:
                return json.load(f)
        except UnicodeError as exc:
            last_error = exc
            continue
        except json.JSONDecodeError as exc:
            if "utf-8 bom" in exc.msg.lower():
                last_error = exc
                continue
            raise ValueError(
                f"Invalid JSON in {path} at line {exc.lineno}, column {exc.colno}: {exc.msg}"
            ) from exc

    if last_error is not None:
        raise last_error
    raise ValueError(f"Unable to read JSON file: {path}")


def expand_inputs(user_input: str) -> List[Path]:
    """
    Supports:
      - single file path
      - comma-separated paths
      - directory (collect *.json recursively)
      - glob pattern (e.g., pages/*.json)
    """
    raw_parts = [p.strip() for p in user_input.split(",") if p.strip()]
    if not raw_parts:
        return []

    paths: List[Path] = []
    for part in raw_parts:
        p = Path(part)

        if p.exists() and p.is_dir():
            paths.extend([x for x in p.rglob("*.json") if x.is_file()])
            continue

        if p.exists() and p.is_file():
            paths.append(p)
            continue

        if any(ch in part for ch in ["*", "?", "[", "]"]):
            base = Path(".")
            pattern = part
            if Path(part).is_absolute():
                base = Path(part).parent
                pattern = Path(part).name
            paths.extend([x for x in base.glob(pattern) if x.is_file() and x.suffix.lower() == ".json"])
            continue

        print(f"[WARN] Skipping not-found input: {part}", file=sys.stderr)

    return sorted(set(paths), key=lambda x: x.as_posix())


# ---------------------------
# Page context + ONE-PASS traversal
# ---------------------------
def looks_like_script_text(text: str) -> bool:
    low = (text or "").lower()
    return any(marker in low for marker in SCRIPT_MARKERS)


def strip_comments(text: str) -> str:
    text = BLOCK_COMMENT_RX.sub("", text or "")
    return LINE_COMMENT_RX.sub("", text)


def normalize_script_body(text: str) -> str:
    body = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    for marker in SCRIPT_MARKERS:
        if body.lower().startswith(marker):
            body = body[len(marker) :].strip()
            break
    body = re.sub(r"\s+", " ", body)
    return body.strip()


def page_scope(page_id: str, page_title: str) -> Tuple[str, str]:
    return (page_id or "", page_title or "")


def page_display(page_id: str, page_title: str) -> str:
    return page_id or page_title or "UNKNOWN_PAGE"


def label_from_properties(props: Dict[str, Any]) -> str:
    for key in ("label", "text", "title", "placeholder"):
        value = props.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def iter_nodes_with_page_context(root: Any) -> Iterable[Dict[str, Any]]:
    stack: List[Tuple[Any, str, str]] = [(root, "", "")]
    while stack:
        node, current_page_id, current_page_title = stack.pop()

        if isinstance(node, dict):
            node_type = str(node.get("type", "") or "").strip()
            node_type_l = node_type.lower()
            props = node.get("properties") if isinstance(node.get("properties"), dict) else {}

            next_page_id = current_page_id
            next_page_title = current_page_title
            if node_type_l == "page" and isinstance(props, dict):
                next_page_id = str(props.get("id", "") or next_page_id).strip()
                next_page_title = str(props.get("title", "") or next_page_title).strip()

            yield {
                "node": node,
                "node_type": node_type,
                "node_type_l": node_type_l,
                "props": props,
                "page_id": next_page_id,
                "page_title": next_page_title,
            }

            for value in reversed(list(node.values())):
                stack.append((value, next_page_id, next_page_title))

        elif isinstance(node, list):
            for value in reversed(node):
                stack.append((value, current_page_id, current_page_title))


def get_page_context(root: Any) -> Tuple[str, str]:
    """Best-effort first page id/title extraction from a Flexi JSON file."""
    for ctx in iter_nodes_with_page_context(root):
        if ctx["node_type_l"] == "page":
            return ctx["page_id"], ctx["page_title"]
    return "", ""


def collect_page_artifacts(root: Any) -> Dict[str, List[Dict[str, Any]]]:
    """
    Single traversal collects page-aware artifacts used by all review functions.
    """
    ui_nodes: List[Dict[str, Any]] = []
    ws_nodes: List[Dict[str, Any]] = []
    script_nodes: List[Dict[str, Any]] = []
    id_nodes: List[Dict[str, Any]] = []
    page_nodes: List[Dict[str, Any]] = []
    ws_refs: List[Dict[str, Any]] = []
    function_nodes: List[Dict[str, Any]] = []

    for ctx in iter_nodes_with_page_context(root):
        node_type = ctx["node_type"]
        node_type_l = ctx["node_type_l"]
        props = ctx["props"]
        current_page_id = ctx["page_id"]
        current_page_title = ctx["page_title"]

        if node_type_l == "page":
            page_nodes.append({"page_id": current_page_id, "page_title": current_page_title})

        if not isinstance(props, dict):
            continue

        node_id = str(props.get("id", "") or "").strip()
        label = label_from_properties(props)

        if node_id:
            id_nodes.append(
                {
                    "page_id": current_page_id,
                    "page_title": current_page_title,
                    "node_id": node_id,
                    "node_type": node_type,
                    "label": label,
                }
            )

        if node_type_l == "function" and node_id:
            function_nodes.append(
                {
                    "page_id": current_page_id,
                    "page_title": current_page_title,
                    "function_id": node_id,
                }
            )

        if node_type_l == "webservice":
            ws_nodes.append(
                {
                    "page_id": current_page_id,
                    "page_title": current_page_title,
                    "service_id": node_id,
                    "wsurl": str(props.get("_wsurl", "") or "").strip(),
                    "wstype": str(props.get("_wstype", "") or "").strip(),
                    "operationType": str(props.get("_operationType", "") or "").strip(),
                    "request": str(props.get("_request", "") or "").strip(),
                    "description": str(props.get("_description", "") or "").strip(),
                    "content_type": str(props.get("_contentType", "") or "").strip(),
                    "user_ws": str(props.get("_userWS", "") or "").strip(),
                    "pass_ws": str(props.get("_passWS", "") or "").strip(),
                }
            )

        if node_type_l not in GLOSSARY_IGNORE_TYPES and node_id:
            ui_nodes.append(
                {
                    "page_id": current_page_id,
                    "page_title": current_page_title,
                    "id": node_id,
                    "node_type": node_type,
                    "label": label,
                }
            )

        webservice_ref = str(props.get("_webService", "") or "").strip()
        if webservice_ref:
            ws_refs.append(
                {
                    "page_id": current_page_id,
                    "page_title": current_page_title,
                    "node_id": node_id or page_display(current_page_id, current_page_title),
                    "node_type": node_type,
                    "referenced_service_id": webservice_ref,
                }
            )

        for prop_name, prop_value in props.items():
            if isinstance(prop_value, str) and looks_like_script_text(prop_value):
                script_nodes.append(
                    {
                        "page_id": current_page_id,
                        "page_title": current_page_title,
                        "node_id": node_id or page_display(current_page_id, current_page_title),
                        "node_type": node_type,
                        "property_name": prop_name,
                        "script_text": prop_value,
                    }
                )

    return {
        "ui_nodes": ui_nodes,
        "ws_nodes": ws_nodes,
        "script_nodes": script_nodes,
        "id_nodes": id_nodes,
        "page_nodes": page_nodes,
        "ws_refs": ws_refs,
        "function_nodes": function_nodes,
    }


def traverse_collect(root: Any) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    artifacts = collect_page_artifacts(root)
    return artifacts["ui_nodes"], artifacts["ws_nodes"]


# ---------------------------
# Glossary matching helpers
# ---------------------------
NOISE_TOKENS = {
    "get",
    "post",
    "put",
    "delete",
    "ws",
    "webservice",
    "service",
    "old",
    "new",
    "v1",
    "v2",
    "v3",
    "tmp",
    "test",
}

ABBREV_MAP = {
    "num": "number",
    "numb": "number",
    "nbr": "number",
    "no": "number",
    "qty": "quantity",
    "subinv": "subinventory",
    "loc": "locator",
    "org": "organization",
}

# =========================
# Commit Validation helpers
# =========================

COMMIT_PATTERNS = [
    # flag ONLY setAutoCommit(false) (case-insensitive, whitespace tolerant)
    re.compile(r"\bsetAutoCommit\s*\(\s*false\s*\)", re.IGNORECASE),

    # flag ONLY commit() with no args (allowing whitespace)
    re.compile(r"\bcommit\s*\(\s*\)", re.IGNORECASE),
]

TRY_EXCEPT_RX = re.compile(r"\b(try|except)\b", re.IGNORECASE)


def _is_pos_commented(text: str, pos: int) -> bool:
    """Return True if character position `pos` is inside // or /* */ comment.
    Best-effort lexer (handles quotes and escapes reasonably).
    """
    in_block = False
    in_line = False
    in_str = None  # ' or "
    esc = False
    i = 0
    n = len(text)
    while i < n and i < pos:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        if in_line:
            if ch == "\n":
                in_line = False
            i += 1
            continue

        if in_str:
            if esc:
                esc = False
            elif ch == "\\":  # escape within string
                esc = True
            elif ch == in_str:
                in_str = None
            i += 1
            continue

        if in_block:
            if ch == "*" and nxt == "/":
                in_block = False
                i += 2
            else:
                i += 1
            continue

        # not in any comment/string
        if ch == "/" and nxt == "/":
            in_line = True
            i += 2
            continue
        if ch == "/" and nxt == "*":
            in_block = True
            i += 2
            continue
        if ch in ("'", '"'):
            in_str = ch
            i += 1
            continue

        i += 1

    return in_line or in_block


def collect_commit_validations(script_nodes: List[Dict[str, Any]], source_file: str = "") -> List[Dict[str, Any]]:
    """
    Return rows for the 'Commit Validation' sheet using already-collected script nodes.
    """
    rows: List[Dict[str, Any]] = []

    for script in script_nodes:
        script_text = script["script_text"]
        has_try_except = "Y" if TRY_EXCEPT_RX.search(script_text) else "N"

        page_col = page_display(script["page_id"], script["page_title"])
        id_col = script["node_id"] or "UNKNOWN_ID"
        action_col = str(script["property_name"])

        for rx in COMMIT_PATTERNS:
            for match in rx.finditer(script_text):
                rows.append(
                    {
                        "Source_File": source_file,
                        "Page": page_col,
                        "Page_Title": script["page_title"],
                        "ID": id_col,
                        "Action": action_col,
                        "Code": match.group(0),
                        "Commented": "Yes" if _is_pos_commented(script_text, match.start()) else "No",
                        "HAS_TRY_EXCEPT": has_try_except,
                    }
                )

    return rows


def split_camel(s: str) -> str:
    return re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)


def normalize_key(s: str) -> str:
    s = (s or "").strip()
    if not s:
        return ""
    s = split_camel(s)
    s = re.sub(r"[^A-Za-z0-9]+", "", s)
    return s.lower()


def tokenize(text: str) -> List[str]:
    text = (text or "").strip()
    if not text:
        return []
    text = split_camel(text)
    parts = re.split(r"[^A-Za-z0-9]+", text)
    out: List[str] = []
    for p in parts:
        if not p:
            continue
        t = p.lower()
        t = ABBREV_MAP.get(t, t)
        if t in NOISE_TOKENS:
            continue
        if len(t) >= 2:
            out.append(t)
    return out


def token_overlap_score(found_tokens: List[str], canon_tokens: List[str]) -> float:
    if not found_tokens or not canon_tokens:
        return 0.0
    fset = set(found_tokens)
    cset = set(canon_tokens)
    inter = len(fset & cset)
    if inter == 0:
        return 0.0
    return 100.0 * (inter / max(1, len(cset)))


BOILERPLATE_PATTERNS = [r"\bid in studio for\b", r"\bfield\b", r"\bbutton\b", r"\blov\b"]


def clean_desc(desc: str) -> str:
    d = (desc or "").strip().lower()
    for pat in BOILERPLATE_PATTERNS:
        d = re.sub(pat, " ", d)
    d = re.sub(r"\s+", " ", d).strip()
    return d


def build_tfidf(canon_profiles: Dict[str, str]) -> Tuple[Dict[str, Dict[str, float]], Dict[str, float]]:
    docs = {cid: tokenize(txt) for cid, txt in canon_profiles.items()}
    df = Counter()
    for toks in docs.values():
        for term in set(toks):
            df[term] += 1
    N = max(1, len(docs))
    idf = {t: math.log((N + 1) / (df_t + 1)) + 1.0 for t, df_t in df.items()}

    vecs: Dict[str, Dict[str, float]] = {}
    for cid, toks in docs.items():
        tf = Counter(toks)
        v: Dict[str, float] = {}
        for term, cnt in tf.items():
            v[term] = (cnt / max(1, len(toks))) * idf.get(term, 0.0)
        vecs[cid] = v
    return vecs, idf


def tfidf_vec(text: str, idf: Dict[str, float]) -> Dict[str, float]:
    toks = tokenize(text)
    tf = Counter(toks)
    v: Dict[str, float] = {}
    for term, cnt in tf.items():
        v[term] = (cnt / max(1, len(toks))) * idf.get(term, 0.0)
    return v


def cosine(a: Dict[str, float], b: Dict[str, float]) -> float:
    if not a or not b:
        return 0.0
    dot = 0.0
    for k, av in a.items():
        bv = b.get(k)
        if bv is not None:
            dot += av * bv
    na = math.sqrt(sum(x * x for x in a.values()))
    nb = math.sqrt(sum(x * x for x in b.values()))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def build_glossary_indexes(glossary_fields: Dict[str, Any]) -> Dict[str, Any]:
    glossary_ids = set(glossary_fields.keys())
    norm_map: Dict[str, List[str]] = defaultdict(list)
    alias_map: Dict[str, str] = {}
    canon_tokens: Dict[str, List[str]] = {}
    canon_profiles: Dict[str, str] = {}

    for cid, meta in glossary_fields.items():
        n = normalize_key(cid)
        if n:
            norm_map[n].append(cid)

        aliases = []
        if isinstance(meta, dict):
            aliases = meta.get("aliases", []) or []
        if isinstance(aliases, list):
            for a in aliases:
                if isinstance(a, str) and a.strip():
                    alias_map[normalize_key(a.strip())] = cid

        desc = ""
        if isinstance(meta, dict):
            desc = str(meta.get("primary_description", "") or "")
        desc = clean_desc(desc)

        canon_tokens[cid] = tokenize(cid)
        canon_profiles[cid] = f"{cid} {desc}".strip()

    tfidf_vectors, idf = build_tfidf(canon_profiles)

    return {
        "glossary_ids": glossary_ids,
        "norm_map": norm_map,
        "alias_map": alias_map,
        "canon_list": list(glossary_fields.keys()),
        "canon_tokens": canon_tokens,
        "tfidf_vectors": tfidf_vectors,
        "idf": idf,
    }


def classify_glossary(
    found_id: str,
    label: str,
    idx: Dict[str, Any],
    glossary_fields: Dict[str, Any],
    auto_threshold: float = 92.0,
    review_threshold: float = 80.0,
    collision_gap: float = 3.0,
    top_k: int = 3,
) -> Dict[str, Any]:
    glossary_ids: Set[str] = idx["glossary_ids"]
    norm_map: Dict[str, List[str]] = idx["norm_map"]
    alias_map: Dict[str, str] = idx["alias_map"]
    canon_list: List[str] = idx["canon_list"]
    canon_tokens: Dict[str, List[str]] = idx["canon_tokens"]
    tfidf_vectors: Dict[str, Dict[str, float]] = idx["tfidf_vectors"]
    idf: Dict[str, float] = idx["idf"]

    if not canon_list:
        return {
            "bucket": BUCKET_LOW,
            "associated_glossary_field": "",
            "confidence": 0.0,
            "top_1": "",
            "score_1": "",
            "top_2": "",
            "score_2": "",
            "top_3": "",
            "score_3": "",
            "collision": False,
            "reason": "Glossary contains no fields to match against.",
            "glossary_primary_description": "(No description in glossary)",
        }

    # 1) Exact match
    if found_id in glossary_ids:
        desc = str(glossary_fields.get(found_id, {}).get("primary_description", "") or "")
        return {
            "bucket": BUCKET_EXACT,
            "associated_glossary_field": found_id,
            "confidence": 100.0,
            "top_1": found_id,
            "score_1": 100.0,
            "top_2": "",
            "score_2": "",
            "top_3": "",
            "score_3": "",
            "collision": False,
            "reason": "Exact match in glossary",
            "glossary_primary_description": desc or "(No description in glossary)",
        }

    found_norm = normalize_key(found_id)

    # 2) Normalization exact match
    if found_norm in norm_map and norm_map[found_norm]:
        best = sorted(norm_map[found_norm])[0]
        desc = str(glossary_fields.get(best, {}).get("primary_description", "") or "")
        return {
            "bucket": BUCKET_HIGH,
            "associated_glossary_field": best,
            "confidence": 98.0,
            "top_1": best,
            "score_1": 98.0,
            "top_2": "",
            "score_2": "",
            "top_3": "",
            "score_3": "",
            "collision": False,
            "reason": "Normalization exact match to glossary canonical",
            "glossary_primary_description": desc or "(No description in glossary)",
        }

    # 3) Alias match
    if found_norm in alias_map:
        best = alias_map[found_norm]
        desc = str(glossary_fields.get(best, {}).get("primary_description", "") or "")
        return {
            "bucket": BUCKET_HIGH,
            "associated_glossary_field": best,
            "confidence": 97.0,
            "top_1": best,
            "score_1": 97.0,
            "top_2": "",
            "score_2": "",
            "top_3": "",
            "score_3": "",
            "collision": False,
            "reason": "Alias match (glossary aliases)",
            "glossary_primary_description": desc or "(No description in glossary)",
        }

    # 4) Score all candidates
    query_text = f"{found_id} {label}".strip()
    qvec = tfidf_vec(query_text, idf)
    found_tokens = tokenize(found_id) + tokenize(label)

    scored: List[Tuple[str, float, float, float, float]] = []
    for cid in canon_list:
        to = token_overlap_score(found_tokens, canon_tokens.get(cid, []))  # 0..100
        fz = float(fuzzy_ratio(found_norm, normalize_key(cid)))  # 0..100
        sem = cosine(qvec, tfidf_vectors.get(cid, {})) * 100.0  # 0..100
        combined = 0.45 * to + 0.45 * fz + 0.10 * sem
        scored.append((cid, combined, to, fz, sem))

    scored.sort(key=lambda x: (-x[1], x[0]))
    top = scored[:max(top_k, 3)]

    top1_id, top1_score, top1_to, top1_fz, top1_sem = top[0]
    top2_score = top[1][1] if len(top) > 1 else -999.0
    collision = (len(top) > 1) and ((top1_score - top2_score) < collision_gap)

    if top1_score >= auto_threshold and not collision:
        bucket = BUCKET_HIGH
    elif top1_score >= review_threshold:
        bucket = BUCKET_MED
    else:
        bucket = BUCKET_LOW

    desc = str(glossary_fields.get(top1_id, {}).get("primary_description", "") or "")
    reason = (
        f"Combined scoring (token+fuzzy+semantic). "
        f"TokenOverlap={top1_to:.0f}, Fuzzy={top1_fz:.0f}, Semantic={top1_sem:.0f}"
    )
    if collision:
        reason += f". Collision: top scores too close (gap<{collision_gap})."

    return {
        "bucket": bucket,
        "associated_glossary_field": top1_id,
        "confidence": round(float(top1_score), 2),
        "top_1": top[0][0],
        "score_1": round(float(top[0][1]), 2),
        "top_2": top[1][0] if len(top) > 1 else "",
        "score_2": round(float(top[1][1]), 2) if len(top) > 1 else "",
        "top_3": top[2][0] if len(top) > 2 else "",
        "score_3": round(float(top[2][1]), 2) if len(top) > 2 else "",
        "collision": bool(collision),
        "reason": reason,
        "glossary_primary_description": desc or "(No description in glossary)",
    }


# ---------------------------
# API: fields= checker helpers
# ---------------------------
def is_oracle_fusion_rest(wsurl: str) -> bool:
    return "/fscmrestapi/resources/" in (wsurl or "").lower()


def is_get_operation(operation_type: str) -> bool:
    op = (operation_type or "").strip().upper()
    return True if not op else (op == "GET")


def query_param_regex(param_name: str) -> re.Pattern[str]:
    return re.compile(rf"(?i)(?:^|[?&\s]){re.escape(param_name)}\s*=\s*([^&\r\n]+)")


def find_query_param(wsurl: str, req: str, param_name: str) -> Tuple[bool, str, str]:
    rx = query_param_regex(param_name)

    for source_name, text in (("request", req or ""), ("wsurl", wsurl or "")):
        match = rx.search(text)
        if match:
            return True, source_name, match.group(1).strip().strip("\"'")

    try:
        parsed = urlparse(wsurl)
        q = parse_qs(parsed.query)
        for key, values in q.items():
            if key.lower() == param_name.lower():
                value = values[0] if values else ""
                return True, "wsurl", str(value).strip()
    except Exception:
        pass
    return False, "", ""


def has_fields_projection(wsurl: str, req: str) -> Tuple[bool, str]:
    found, source, _ = find_query_param(wsurl, req, "fields")
    return found, source


def count_fields(wsurl: str, req: str) -> int:
    found, _, value = find_query_param(wsurl, req, "fields")
    if not found or not value:
        return 0
    parts = [part.strip() for part in value.split(",") if part.strip()]
    return len(parts)


def has_only_data_true(wsurl: str, req: str) -> Tuple[bool, str, str]:
    found, source, value = find_query_param(wsurl, req, "onlyData")
    if not found:
        return False, "", ""
    return value.lower() == "true", source, value


def find_limit_value(wsurl: str, req: str) -> Tuple[bool, str, str]:
    return find_query_param(wsurl, req, "limit")


def looks_like_lov_or_search_service(service_id: str, request: str, referenced_node_types: Set[str]) -> bool:
    if "lov" in (service_id or "").lower():
        return True
    if "LOV" in referenced_node_types:
        return True
    return " like " in f" {(request or '').lower()} "


def highest_severity(severities: Iterable[str]) -> str:
    best = ""
    best_rank = -1
    for severity in severities:
        rank = SEVERITY_RANK.get(severity, -1)
        if rank > best_rank:
            best = severity
            best_rank = rank
    return best


def build_api_findings(
    page_file: Path,
    ws_nodes: List[Dict[str, Any]],
    ws_refs: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []

    ref_node_types: Dict[Tuple[Tuple[str, str], str], Set[str]] = defaultdict(set)
    for ref in ws_refs:
        key = (page_scope(ref["page_id"], ref["page_title"]), ref["referenced_service_id"])
        ref_node_types[key].add(ref["node_type"])

    for service in ws_nodes:
        wsurl = service["wsurl"]
        wstype = service["wstype"]
        operation = service["operationType"]
        request = service["request"]

        if not is_oracle_fusion_rest(wsurl):
            continue
        if (wstype or "").strip() and (wstype or "").strip().upper() != "REST":
            continue
        if not is_get_operation(operation):
            continue

        scope = page_scope(service["page_id"], service["page_title"])
        referenced_types = ref_node_types.get((scope, service["service_id"]), set())

        has_fields, fields_source = has_fields_projection(wsurl, request)
        fields_count = count_fields(wsurl, request) if has_fields else 0
        has_only_data, only_data_source, only_data_value = has_only_data_true(wsurl, request)
        has_limit, limit_source, limit_value = find_limit_value(wsurl, request)

        flags: List[str] = []
        reasons: List[str] = []
        severities: List[str] = []

        if not has_fields:
            flags.append("MISSING_FIELDS")
            reasons.append("GET call to Fusion REST without fields= projection.")
            severities.append("HIGH")
        if not has_only_data:
            flags.append("MISSING_ONLYDATA")
            reasons.append("GET call does not request onlyData=true, which can return unnecessary wrapper payload.")
            severities.append("MEDIUM")
        if looks_like_lov_or_search_service(service["service_id"], request, referenced_types) and not has_limit:
            flags.append("MISSING_LIMIT")
            reasons.append("Search/LOV-style GET call has no explicit limit= value.")
            severities.append("MEDIUM")
        if has_fields and fields_count > 20:
            flags.append("WIDE_FIELDS")
            reasons.append("fields= projects a large number of attributes; review payload width.")
            severities.append("LOW")

        rows.append(
            {
                "page_file": page_file.name,
                "page_id": service["page_id"],
                "page_title": service["page_title"],
                "service_id": service["service_id"],
                "description": service["description"],
                "operation": (operation or "GET").upper() if (operation or "").strip() else "GET",
                "wsurl": wsurl,
                "request": request,
                "used_by_node_types": ", ".join(sorted(referenced_types)),
                "has_fields": bool(has_fields),
                "fields_found_in": fields_source,
                "fields_count": fields_count,
                "has_onlyData_true": bool(has_only_data),
                "onlyData_found_in": only_data_source,
                "onlyData_value": only_data_value,
                "has_limit": bool(has_limit),
                "limit_found_in": limit_source,
                "limit_value": limit_value,
                "flag": ", ".join(flags) if flags else "OK",
                "severity": highest_severity(severities),
                "reason": " ".join(reasons) if reasons else "Fusion GET call follows the configured checks.",
            }
        )

    return rows


def build_redundant_api_findings(page_file: Path, ws_nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    endpoint_groups: Dict[Tuple[Tuple[str, str], str], List[Dict[str, Any]]] = defaultdict(list)

    for service in ws_nodes:
        endpoint_path = normalize_wsurl_to_endpoint_key(service["wsurl"])
        if not endpoint_path:
            continue
        key = (page_scope(service["page_id"], service["page_title"]), endpoint_path)
        endpoint_groups[key].append(service)

    for (scope, endpoint_path), services in endpoint_groups.items():
        if len(services) <= 1:
            continue

        service_ids = [item["service_id"] for item in services if item["service_id"]]
        methods_seen = sorted(
            set([(item.get("operationType") or "").strip().upper() or "GET" for item in services])
        )
        sample_urls = sorted(set([item["wsurl"] for item in services if item["wsurl"]]))[:3]

        rows.append(
            {
                "page_file": page_file.name,
                "page_id": scope[0],
                "page_title": scope[1],
                "endpoint_path": endpoint_path,
                "count": len(services),
                "methods_seen": ", ".join(methods_seen),
                "service_ids_using_same_wsurl": ", ".join(service_ids),
                "example_wsurls": " | ".join(sample_urls),
                "notes": "Same endpoint (_wsurl path) used multiple times in this page. Review if it can be reused instead of duplicated.",
            }
        )

    return rows


def collect_structure_findings(page_file: Path, artifacts: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    id_groups: Dict[Tuple[Tuple[str, str], str], List[Dict[str, Any]]] = defaultdict(list)

    for node in artifacts["id_nodes"]:
        key = (page_scope(node["page_id"], node["page_title"]), node["node_id"])
        id_groups[key].append(node)

    for (scope, node_id), items in id_groups.items():
        if len(items) <= 1:
            continue
        node_types = sorted(set(item["node_type"] for item in items if item["node_type"]))
        labels = sorted(set(item["label"] for item in items if item["label"]))
        rows.append(
            {
                "Source_File": page_file.name,
                "Page": page_display(scope[0], scope[1]),
                "Page_Title": scope[1],
                "Node_ID": node_id,
                "Node_Type": ", ".join(node_types),
                "Finding": "DUPLICATE_ID",
                "Severity": "HIGH",
                "Details": f"ID appears {len(items)} times in the same page.",
                "Related_Values": " | ".join(labels),
            }
        )

    page_nodes = artifacts["page_nodes"]
    if not page_nodes:
        rows.append(
            {
                "Source_File": page_file.name,
                "Page": "UNKNOWN_PAGE",
                "Page_Title": "",
                "Node_ID": "",
                "Node_Type": "Page",
                "Finding": "NO_PAGE_NODES",
                "Severity": "HIGH",
                "Details": "No Page nodes were found in this JSON file.",
                "Related_Values": "",
            }
        )
    else:
        seen_pages: Set[Tuple[str, str]] = set()
        for page_node in page_nodes:
            scope = page_scope(page_node["page_id"], page_node["page_title"])
            if scope in seen_pages:
                continue
            seen_pages.add(scope)
            if not page_node["page_id"] or not page_node["page_title"]:
                rows.append(
                    {
                        "Source_File": page_file.name,
                        "Page": page_display(page_node["page_id"], page_node["page_title"]),
                        "Page_Title": page_node["page_title"],
                        "Node_ID": page_node["page_id"],
                        "Node_Type": "Page",
                        "Finding": "PAGE_METADATA_GAP",
                        "Severity": "MEDIUM",
                        "Details": "Page node is missing either id or title.",
                        "Related_Values": "",
                    }
                )

    return rows


def extract_service_refs_from_script(script_text: str, known_service_ids: Set[str]) -> Set[str]:
    if not known_service_ids:
        return set()
    method_pattern = "|".join(SERVICE_REF_METHODS)
    rx = re.compile(rf"\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(?:{method_pattern})\b")
    found = set()
    for match in rx.finditer(script_text or ""):
        identifier = match.group(1)
        if identifier in known_service_ids:
            found.add(identifier)
    return found


def extract_function_refs_from_script(script_text: str, known_function_ids: Set[str]) -> Set[str]:
    if not known_function_ids:
        return set()
    found = set()
    for match in FUNCTION_CALL_RX.finditer(script_text or ""):
        identifier = match.group(1)
        if identifier in known_function_ids:
            found.add(identifier)
    return found


def collect_reference_findings(page_file: Path, artifacts: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []

    services_by_scope: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    functions_by_scope: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    used_services_by_scope: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    used_functions_by_scope: Dict[Tuple[str, str], Set[str]] = defaultdict(set)

    for service in artifacts["ws_nodes"]:
        scope = page_scope(service["page_id"], service["page_title"])
        if service["service_id"]:
            services_by_scope[scope].add(service["service_id"])

    for fn in artifacts["function_nodes"]:
        scope = page_scope(fn["page_id"], fn["page_title"])
        if fn["function_id"]:
            functions_by_scope[scope].add(fn["function_id"])

    for ref in artifacts["ws_refs"]:
        scope = page_scope(ref["page_id"], ref["page_title"])
        referenced_id = ref["referenced_service_id"]
        if referenced_id in services_by_scope[scope]:
            used_services_by_scope[scope].add(referenced_id)
        else:
            rows.append(
                {
                    "Source_File": page_file.name,
                    "Page": page_display(ref["page_id"], ref["page_title"]),
                    "Page_Title": ref["page_title"],
                    "Node_ID": ref["node_id"],
                    "Node_Type": ref["node_type"],
                    "Finding": "MISSING_WEBSERVICE_REF",
                    "Severity": "HIGH",
                    "Details": f"_webService references '{referenced_id}', but no matching WebService ID exists in the same page.",
                    "Related_ID": referenced_id,
                }
            )

    for script in artifacts["script_nodes"]:
        scope = page_scope(script["page_id"], script["page_title"])
        used_services_by_scope[scope].update(
            extract_service_refs_from_script(script["script_text"], services_by_scope.get(scope, set()))
        )
        used_functions_by_scope[scope].update(
            extract_function_refs_from_script(script["script_text"], functions_by_scope.get(scope, set()))
        )

    for service in artifacts["ws_nodes"]:
        scope = page_scope(service["page_id"], service["page_title"])
        service_id = service["service_id"]
        if service_id and service_id not in used_services_by_scope[scope]:
            rows.append(
                {
                    "Source_File": page_file.name,
                    "Page": page_display(service["page_id"], service["page_title"]),
                    "Page_Title": service["page_title"],
                    "Node_ID": service_id,
                    "Node_Type": "WebService",
                    "Finding": "UNUSED_WEBSERVICE",
                    "Severity": "LOW",
                    "Details": "WebService is defined but not referenced by a component _webService property or known script usage.",
                    "Related_ID": "",
                }
            )

    for fn in artifacts["function_nodes"]:
        scope = page_scope(fn["page_id"], fn["page_title"])
        function_id = fn["function_id"]
        if function_id and function_id not in used_functions_by_scope[scope]:
            rows.append(
                {
                    "Source_File": page_file.name,
                    "Page": page_display(fn["page_id"], fn["page_title"]),
                    "Page_Title": fn["page_title"],
                    "Node_ID": function_id,
                    "Node_Type": "Function",
                    "Finding": "UNUSED_FUNCTION",
                    "Severity": "LOW",
                    "Details": "Function is defined but no `.call(...)` usage was detected in the same page.",
                    "Related_ID": "",
                }
            )

    return rows


def collect_script_findings(page_file: Path, script_nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    duplicate_groups: Dict[Tuple[Tuple[str, str], str, str], List[Dict[str, Any]]] = defaultdict(list)

    for script in script_nodes:
        script_text = script["script_text"]
        normalized = normalize_script_body(script_text)
        scope = page_scope(script["page_id"], script["page_title"])

        if normalized and len(normalized) >= 40:
            duplicate_groups[(scope, script["node_id"], normalized)].append(script)

        line_count = len(script_text.replace("\r\n", "\n").replace("\r", "\n").splitlines())
        char_count = len(script_text)
        if line_count >= 300 or char_count >= 15000:
            rows.append(
                {
                    "Source_File": page_file.name,
                    "Page": page_display(script["page_id"], script["page_title"]),
                    "Page_Title": script["page_title"],
                    "Node_ID": script["node_id"],
                    "Node_Type": script["node_type"],
                    "Property": script["property_name"],
                    "Finding": "LONG_INLINE_SCRIPT",
                    "Severity": "LOW",
                    "Details": f"Inline handler is large ({line_count} lines, {char_count} chars). Consider extracting or reusing logic.",
                }
            )

        for match in EMPTY_CATCH_RX.finditer(script_text):
            body = strip_comments(match.group(1)).strip()
            if not body:
                rows.append(
                    {
                        "Source_File": page_file.name,
                        "Page": page_display(script["page_id"], script["page_title"]),
                        "Page_Title": script["page_title"],
                        "Node_ID": script["node_id"],
                        "Node_Type": script["node_type"],
                        "Property": script["property_name"],
                        "Finding": "EMPTY_CATCH_BLOCK",
                        "Severity": "HIGH",
                        "Details": "Catch block is empty or comment-only, which can hide runtime failures.",
                    }
                )

    for (scope, node_id, _), items in duplicate_groups.items():
        properties = sorted(set(item["property_name"] for item in items))
        if len(properties) <= 1:
            continue
        rows.append(
            {
                "Source_File": page_file.name,
                "Page": page_display(scope[0], scope[1]),
                "Page_Title": scope[1],
                "Node_ID": node_id,
                "Node_Type": ", ".join(sorted(set(item["node_type"] for item in items))),
                "Property": ", ".join(properties),
                "Finding": "DUPLICATE_HANDLER_LOGIC",
                "Severity": "MEDIUM",
                "Details": "The same handler logic appears in multiple properties on the same node. Consider extracting a reusable function.",
            }
        )

    return rows


# ---------------------------
# Redundant APIs: normalize wsurl -> endpoint_path
# ---------------------------
def normalize_wsurl_to_endpoint_key(wsurl: str) -> str:
    """
    Normalize _wsurl so same endpoint counts as reused even if query params differ.

    - lowercase
    - remove query params (keep only path)
    - support ${ORACLE_FUSION_URL}/... by swapping base with https://dummy
    """
    u = (wsurl or "").strip()
    if not u:
        return ""
    u_low = u.lower()

    if u_low.startswith("${"):
        rb = u_low.find("}")
        if rb != -1:
            u_low = "https://dummy" + u_low[rb + 1 :]
        else:
            u_low = "https://dummy/" + u_low.lstrip("${")

    try:
        parsed = urlparse(u_low)
        path = parsed.path or ""
    except Exception:
        path = u_low.split("?", 1)[0]

    path = "/".join([p for p in path.split("/") if p])
    return "/" + path if path else ""


def is_dynamic_credential_value(value: str) -> bool:
    text = (value or "").strip()
    if not text:
        return True
    if PLACEHOLDER_ONLY_RX.match(text):
        return True
    if "${" in text:
        return True
    lowered = text.lower()
    if any(token in lowered for token in ("getsessionobject(", "getobject(", "system.getenv", "getenv(")):
        return True
    return False


def mask_secret(value: str) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    return f"<redacted len={len(text)}>"


def append_credential_row(
    rows: List[Dict[str, Any]],
    seen: Set[Tuple[str, ...]],
    *,
    page_file: Path,
    page_id: str,
    page_title: str,
    node_id: str,
    node_type: str,
    prop_name: str,
    finding: str,
    severity: str,
    details: str,
    matched_sample: str = "",
):
    key = (
        page_file.name,
        page_id,
        page_title,
        node_id,
        node_type,
        prop_name,
        finding,
        details,
        matched_sample,
    )
    if key in seen:
        return
    seen.add(key)
    rows.append(
        {
            "Source_File": page_file.name,
            "Page": page_display(page_id, page_title),
            "Page_Title": page_title,
            "Node_ID": node_id,
            "Node_Type": node_type,
            "Property": prop_name,
            "Finding": finding,
            "Severity": severity,
            "Details": details,
            "Matched_Sample": matched_sample,
        }
    )


def scan_text_for_hardcoded_credentials(
    *,
    page_file: Path,
    page_id: str,
    page_title: str,
    node_id: str,
    node_type: str,
    prop_name: str,
    text: str,
    seen: Set[Tuple[str, ...]],
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if not text:
        return rows

    auth_match = AUTH_HEADER_LITERAL_RX.search(text)
    if auth_match:
        auth_value = auth_match.group(1).strip()
        if not is_dynamic_credential_value(auth_value):
            finding = "HARDCODED_AUTH_HEADER"
            details = "Authorization header appears to contain a hardcoded literal credential."
            append_credential_row(
                rows,
                seen,
                page_file=page_file,
                page_id=page_id,
                page_title=page_title,
                node_id=node_id,
                node_type=node_type,
                prop_name=prop_name,
                finding=finding,
                severity="HIGH",
                details=details,
                matched_sample=mask_secret(auth_value),
            )

    for rx, finding, details in (
        (URL_WITH_CREDS_RX, "CREDENTIALS_IN_URL", "URL appears to include embedded username/password credentials."),
        (BASIC_TOKEN_RX, "HARDCODED_BASIC_TOKEN", "Basic auth token appears as a hardcoded literal."),
        (BEARER_TOKEN_RX, "HARDCODED_BEARER_TOKEN", "Bearer token appears as a hardcoded literal."),
    ):
        for match in rx.finditer(text):
            sample = match.group(0)
            append_credential_row(
                rows,
                seen,
                page_file=page_file,
                page_id=page_id,
                page_title=page_title,
                node_id=node_id,
                node_type=node_type,
                prop_name=prop_name,
                finding=finding,
                severity="HIGH",
                details=details,
                matched_sample=mask_secret(sample),
            )

    for match in SENSITIVE_KEY_VALUE_RX.finditer(text):
        raw_value = match.group(2).strip()
        if is_dynamic_credential_value(raw_value):
            continue
        append_credential_row(
            rows,
            seen,
            page_file=page_file,
            page_id=page_id,
            page_title=page_title,
            node_id=node_id,
            node_type=node_type,
            prop_name=prop_name,
            finding="HARDCODED_SECRET_LITERAL",
            severity="HIGH",
            details="Sensitive key appears to be assigned a hardcoded quoted value.",
            matched_sample=mask_secret(raw_value),
        )

    for match in SENSITIVE_SETTER_RX.finditer(text):
        key_name = match.group(1).strip()
        raw_value = match.group(2).strip()
        if is_dynamic_credential_value(raw_value):
            continue
        append_credential_row(
            rows,
            seen,
            page_file=page_file,
            page_id=page_id,
            page_title=page_title,
            node_id=node_id,
            node_type=node_type,
            prop_name=prop_name,
            finding="HARDCODED_SECRET_SETTER",
            severity="HIGH",
            details=f"Sensitive object/session key '{key_name}' appears to be assigned a hardcoded quoted value.",
            matched_sample=mask_secret(raw_value),
        )

    return rows


def collect_credential_findings(page_file: Path, artifacts: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    seen: Set[Tuple[str, ...]] = set()

    for service in artifacts["ws_nodes"]:
        node_id = service["service_id"] or page_display(service["page_id"], service["page_title"])
        for prop_name, label, value in (
            ("_userWS", "username", service["user_ws"]),
            ("_passWS", "password", service["pass_ws"]),
        ):
            if value and not is_dynamic_credential_value(value):
                append_credential_row(
                    rows,
                    seen,
                    page_file=page_file,
                    page_id=service["page_id"],
                    page_title=service["page_title"],
                    node_id=node_id,
                    node_type="WebService",
                    prop_name=prop_name,
                    finding=f"HARDCODED_WS_{label.upper()}",
                    severity="HIGH",
                    details=f"WebService {label} property appears to contain a hardcoded literal value.",
                    matched_sample=mask_secret(value),
                )

        for prop_name, value in (
            ("_wsurl", service["wsurl"]),
            ("_request", service["request"]),
        ):
            rows.extend(
                scan_text_for_hardcoded_credentials(
                    page_file=page_file,
                    page_id=service["page_id"],
                    page_title=service["page_title"],
                    node_id=node_id,
                    node_type="WebService",
                    prop_name=prop_name,
                    text=value,
                    seen=seen,
                )
            )

    for script in artifacts["script_nodes"]:
        rows.extend(
            scan_text_for_hardcoded_credentials(
                page_file=page_file,
                page_id=script["page_id"],
                page_title=script["page_title"],
                node_id=script["node_id"],
                node_type=script["node_type"],
                prop_name=script["property_name"],
                text=script["script_text"],
                seen=seen,
            )
        )

    return rows


def extract_called_service_counts(script_text: str, known_service_ids: Set[str]) -> Counter:
    counts: Counter = Counter()
    if not known_service_ids:
        return counts
    for match in CALL_WEBSERVICE_RX.finditer(script_text or ""):
        service_id = match.group(1)
        if service_id in known_service_ids:
            counts[service_id] += 1
    return counts


def collect_service_usage(artifacts: Dict[str, List[Dict[str, Any]]]) -> Dict[Tuple[Tuple[str, str], str], Dict[str, Any]]:
    usage: Dict[Tuple[Tuple[str, str], str], Dict[str, Any]] = defaultdict(
        lambda: {
            "component_refs": set(),
            "handler_refs": set(),
            "handler_entries": [],
            "total_calls": 0,
        }
    )
    services_by_scope: Dict[Tuple[str, str], Set[str]] = defaultdict(set)

    for service in artifacts["ws_nodes"]:
        scope = page_scope(service["page_id"], service["page_title"])
        if service["service_id"]:
            services_by_scope[scope].add(service["service_id"])

    for ref in artifacts["ws_refs"]:
        scope = page_scope(ref["page_id"], ref["page_title"])
        service_id = ref["referenced_service_id"]
        key = (scope, service_id)
        usage[key]["component_refs"].add(f"{ref['node_id']}[{ref['node_type']}]")

    for script in artifacts["script_nodes"]:
        scope = page_scope(script["page_id"], script["page_title"])
        counts = extract_called_service_counts(script["script_text"], services_by_scope.get(scope, set()))
        for service_id, count in counts.items():
            key = (scope, service_id)
            handler_ref = f"{script['node_id']}.{script['property_name']}"
            usage[key]["handler_refs"].add(handler_ref)
            usage[key]["handler_entries"].append(
                {
                    "node_id": script["node_id"],
                    "property_name": script["property_name"],
                    "handler_ref": handler_ref,
                    "count": count,
                }
            )
            usage[key]["total_calls"] += count

    return usage


def likely_duplicate_action_group(node_ids: Set[str]) -> str:
    upper_ids = {node_id.upper() for node_id in node_ids if node_id}
    for pair in KNOWN_DUPLICATE_ACTION_PAIRS:
        if pair.issubset(upper_ids):
            return " + ".join(sorted(pair))

    for left, right in combinations(sorted(upper_ids), 2):
        if left.endswith("_NEXT") and left[:-5] == right:
            return f"{right} + {left}"
        if right.endswith("_NEXT") and right[:-5] == left:
            return f"{left} + {right}"

    return ""


def summarize_service_call_pattern(info: Dict[str, Any]) -> Dict[str, Any]:
    same_node_props: Dict[str, Set[str]] = defaultdict(set)
    click_nodes: Set[str] = set()
    click_handler_refs: Set[str] = set()
    per_handler_repeat_refs: List[str] = []

    for entry in info.get("handler_entries", []):
        same_node_props[entry["node_id"]].add(entry["property_name"])
        if entry["property_name"] == "_onClick":
            click_nodes.add(entry["node_id"])
            click_handler_refs.add(entry["handler_ref"])
        if entry["count"] > 1:
            per_handler_repeat_refs.append(f"{entry['handler_ref']} x{entry['count']}")

    exit_keypress_nodes = sorted(
        node_id
        for node_id, props in same_node_props.items()
        if "_onExit" in props and "_onKeyPress" in props
    )

    return {
        "same_node_props": same_node_props,
        "click_nodes": click_nodes,
        "click_handler_refs": click_handler_refs,
        "per_handler_repeat_refs": per_handler_repeat_refs,
        "exit_keypress_nodes": exit_keypress_nodes,
        "duplicate_action_group": likely_duplicate_action_group(click_nodes),
    }


def collect_duplicate_call_risk_findings(
    page_file: Path,
    artifacts: Dict[str, List[Dict[str, Any]]],
    usage: Dict[Tuple[Tuple[str, str], str], Dict[str, Any]] | None = None,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    usage = usage or collect_service_usage(artifacts)

    for (scope, service_id), info in usage.items():
        handler_entries = info["handler_entries"]
        if not handler_entries:
            continue

        pattern = summarize_service_call_pattern(info)
        per_handler_repeat_refs = pattern["per_handler_repeat_refs"]
        click_nodes = pattern["click_nodes"]
        click_handler_refs = pattern["click_handler_refs"]
        exit_keypress_nodes = pattern["exit_keypress_nodes"]
        duplicate_action_group = pattern["duplicate_action_group"]

        if per_handler_repeat_refs:
            rows.append(
                {
                    "Source_File": page_file.name,
                    "Page": page_display(scope[0], scope[1]),
                    "Page_Title": scope[1],
                    "Service_ID": service_id,
                    "Risk_Type": "MULTIPLE_CALLS_IN_SINGLE_HANDLER",
                    "Severity": "HIGH",
                    "Handler_Refs": sample_join(per_handler_repeat_refs, limit=10),
                    "Call_Count": info["total_calls"],
                    "Details": "The same service is called more than once inside a single handler. Review whether the extra call is required, because it can multiply request volume and latency.",
                }
            )

        if exit_keypress_nodes:
            rows.append(
                {
                    "Source_File": page_file.name,
                    "Page": page_display(scope[0], scope[1]),
                    "Page_Title": scope[1],
                    "Service_ID": service_id,
                    "Risk_Type": "EXIT_KEYPRESS_DOUBLE_CALL",
                    "Severity": "HIGH",
                    "Handler_Refs": sample_join(
                        [f"{node}._onExit" for node in exit_keypress_nodes]
                        + [f"{node}._onKeyPress" for node in exit_keypress_nodes],
                        limit=12,
                    ),
                    "Call_Count": info["total_calls"],
                    "Details": "The same service is triggered from both _onExit and _onKeyPress on the same field(s). That is a common source of accidental duplicate API traffic.",
                }
            )

        if duplicate_action_group:
            rows.append(
                {
                    "Source_File": page_file.name,
                    "Page": page_display(scope[0], scope[1]),
                    "Page_Title": scope[1],
                    "Service_ID": service_id,
                    "Risk_Type": "MIRRORED_CLICK_HANDLERS",
                    "Severity": "MEDIUM",
                    "Handler_Refs": sample_join(click_handler_refs, limit=12),
                    "Call_Count": info["total_calls"],
                    "Details": f"The same service is called from mirrored click actions ({duplicate_action_group}). Review whether both paths need a live call or can share a single submission flow.",
                }
            )
        elif len(click_handler_refs) >= 2:
            rows.append(
                {
                    "Source_File": page_file.name,
                    "Page": page_display(scope[0], scope[1]),
                    "Page_Title": scope[1],
                    "Service_ID": service_id,
                    "Risk_Type": "MULTI_CLICK_HANDLER_CALL",
                    "Severity": "LOW",
                    "Handler_Refs": sample_join(click_handler_refs, limit=12),
                    "Call_Count": info["total_calls"],
                    "Details": "The same service is called from multiple click handlers in the page. Review whether those actions are mutually exclusive or causing redundant requests.",
                }
            )

    return rows


def split_finding_flags(flag_text: str) -> List[str]:
    return [part.strip() for part in str(flag_text or "").split(",") if part.strip() and part.strip() != "OK"]


def network_hotspot_level(score: int) -> str:
    if score >= 10:
        return "HIGH"
    if score >= 5:
        return "MEDIUM"
    return "LOW"


def collect_network_cost_hotspots(
    page_file: Path,
    artifacts: Dict[str, List[Dict[str, Any]]],
    api_rows: List[Dict[str, Any]],
    usage: Dict[Tuple[Tuple[str, str], str], Dict[str, Any]] | None = None,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    usage = usage or collect_service_usage(artifacts)
    api_index = {
        (page_scope(row["page_id"], row["page_title"]), row["service_id"]): row
        for row in api_rows
        if row.get("service_id")
    }
    endpoint_counts: Counter = Counter()

    for service in artifacts["ws_nodes"]:
        endpoint_path = normalize_wsurl_to_endpoint_key(service["wsurl"])
        if endpoint_path:
            endpoint_counts[(page_scope(service["page_id"], service["page_title"]), endpoint_path)] += 1

    for service in artifacts["ws_nodes"]:
        service_id = service["service_id"]
        if not service_id:
            continue

        scope = page_scope(service["page_id"], service["page_title"])
        key = (scope, service_id)
        usage_info = usage.get(
            key,
            {
                "component_refs": set(),
                "handler_refs": set(),
                "handler_entries": [],
                "total_calls": 0,
            },
        )
        pattern = summarize_service_call_pattern(usage_info)
        endpoint_path = normalize_wsurl_to_endpoint_key(service["wsurl"])
        endpoint_dup_count = endpoint_counts.get((scope, endpoint_path), 0) if endpoint_path else 0
        api_row = api_index.get(key)
        api_flags = split_finding_flags(api_row["flag"] if api_row else "")

        score = 0
        detail_bits: List[str] = []
        flag_weights = {
            "MISSING_FIELDS": 6,
            "MISSING_ONLYDATA": 3,
            "MISSING_LIMIT": 3,
            "WIDE_FIELDS": 1,
        }
        for flag in api_flags:
            weight = flag_weights.get(flag, 0)
            if weight:
                score += weight
        if api_flags:
            detail_bits.append(f"GET shaping flags: {', '.join(api_flags)}")

        if endpoint_dup_count > 1:
            score += 2 * (endpoint_dup_count - 1)
            detail_bits.append(f"Endpoint path is duplicated across {endpoint_dup_count} services in the same page.")

        if pattern["per_handler_repeat_refs"]:
            score += 4
            detail_bits.append(f"Repeated calls inside handlers: {sample_join(pattern['per_handler_repeat_refs'], limit=6)}.")

        if pattern["exit_keypress_nodes"]:
            score += 4
            detail_bits.append(
                f"Triggered from both _onExit and _onKeyPress on: {sample_join(pattern['exit_keypress_nodes'], limit=6)}."
            )

        if pattern["duplicate_action_group"]:
            score += 2
            detail_bits.append(f"Mirrored click actions share this service: {pattern['duplicate_action_group']}.")
        elif len(pattern["click_handler_refs"]) >= 2:
            score += 1
            detail_bits.append(
                f"Shared across multiple click handlers: {sample_join(pattern['click_handler_refs'], limit=6)}."
            )

        if not score:
            continue

        component_ref_count = len(usage_info["component_refs"])
        handler_ref_count = len(usage_info["handler_refs"])
        total_call_count = usage_info["total_calls"]
        operation = (service.get("operationType") or "GET").upper() if (service.get("operationType") or "").strip() else "GET"
        details = " ".join(detail_bits)
        details += " Prioritize shared services, narrower GET projections, and single submission paths to reduce request count and payload size."

        rows.append(
            {
                "Source_File": page_file.name,
                "Page": page_display(scope[0], scope[1]),
                "Page_Title": scope[1],
                "Service_ID": service_id,
                "Operation": operation,
                "Endpoint_Path": endpoint_path,
                "Hotspot_Level": network_hotspot_level(score),
                "Network_Score": score,
                "Component_Refs": component_ref_count,
                "Handler_Refs": handler_ref_count,
                "Total_Call_Count": total_call_count,
                "API_Flags": ", ".join(api_flags) if api_flags else "OK",
                "Details": details,
            }
        )

    return rows


def extract_placeholder_names(text: str) -> List[str]:
    return sorted({match.strip() for match in PLACEHOLDER_RX.findall(text or "") if match.strip()})


def is_runtime_placeholder(name: str) -> bool:
    upper = (name or "").strip().upper()
    if not upper:
        return False
    if upper in KNOWN_RUNTIME_EXACT:
        return True
    return any(upper.startswith(prefix) for prefix in KNOWN_RUNTIME_PREFIXES)


def sample_join(values: Iterable[str], limit: int = 8) -> str:
    items = sorted({value for value in values if value})
    if not items:
        return ""
    if len(items) > limit:
        return ", ".join(items[:limit]) + f" (+{len(items) - limit} more)"
    return ", ".join(items)


def collect_defined_keys_by_scope(
    artifacts: Dict[str, List[Dict[str, Any]]],
) -> Tuple[Dict[Tuple[str, str], Set[str]], Dict[Tuple[str, str], Dict[str, Set[str]]]]:
    keys_by_scope: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    refs_by_scope: Dict[Tuple[str, str], Dict[str, Set[str]]] = defaultdict(lambda: defaultdict(set))

    for node in artifacts["ui_nodes"]:
        scope = page_scope(node["page_id"], node["page_title"])
        key_name = node["id"]
        if not key_name:
            continue
        keys_by_scope[scope].add(key_name)
        refs_by_scope[scope][key_name].add(f"component:{key_name}")

    for script in artifacts["script_nodes"]:
        scope = page_scope(script["page_id"], script["page_title"])
        source_ref = f"{script['node_id']}.{script['property_name']}"
        for rx in (OBJECT_SETTER_RX, MAP_PUT_RX):
            for match in rx.finditer(script["script_text"]):
                key_name = match.group(1).strip()
                if not key_name or not re.fullmatch(r"[A-Z0-9_]+", key_name):
                    continue
                keys_by_scope[scope].add(key_name)
                refs_by_scope[scope][key_name].add(source_ref)

    return keys_by_scope, refs_by_scope


def collect_placeholder_dependency_findings(page_file: Path, artifacts: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    keys_by_scope, refs_by_scope = collect_defined_keys_by_scope(artifacts)

    groups: Dict[Tuple[Tuple[str, str], str], Dict[str, Set[str]]] = defaultdict(
        lambda: {
            "services": set(),
            "properties": set(),
            "source_types": set(),
            "source_refs": set(),
        }
    )

    for service in artifacts["ws_nodes"]:
        scope = page_scope(service["page_id"], service["page_title"])
        for prop_name, text in (("_wsurl", service["wsurl"]), ("_request", service["request"])):
            for placeholder in extract_placeholder_names(text):
                entry = groups[(scope, placeholder)]
                entry["services"].add(service["service_id"] or "(no service id)")
                entry["properties"].add(prop_name)

                if placeholder in keys_by_scope.get(scope, set()):
                    entry["source_types"].add("LOCAL_COMPONENT_OR_OBJECT")
                    entry["source_refs"].update(refs_by_scope.get(scope, {}).get(placeholder, set()))
                elif is_runtime_placeholder(placeholder):
                    entry["source_types"].add("RUNTIME_CONTEXT")
                else:
                    entry["source_types"].add("UNKNOWN")

    for (scope, placeholder), entry in groups.items():
        if "UNKNOWN" not in entry["source_types"]:
            continue

        severity = "HIGH" if len(entry["services"]) >= 2 or "_wsurl" in entry["properties"] else "MEDIUM"
        rows.append(
            {
                "Source_File": page_file.name,
                "Page": page_display(scope[0], scope[1]),
                "Page_Title": scope[1],
                "Placeholder": placeholder,
                "Used_By_Services": sample_join(entry["services"]),
                "Used_In": ", ".join(sorted(entry["properties"])),
                "Detected_Sources": ", ".join(sorted(entry["source_types"])),
                "Example_Source_Refs": sample_join(entry["source_refs"]),
                "Severity": severity,
                "Details": "Placeholder is used by an API definition but no matching local component/object setter or known runtime source was detected. Review request assembly to avoid failed calls or unnecessary retries.",
            }
        )

    return rows


def script_uses_raw_response_for_service(script_text: str, service_id: str) -> bool:
    return bool(re.search(rf"\b{re.escape(service_id)}\s*\.\s*getRawResponse\s*\(", script_text))


def script_has_response_code_guard(script_text: str, service_id: str) -> bool:
    return bool(re.search(rf"\b{re.escape(service_id)}\s*\.\s*getResponseCode\s*\(", script_text))


def array_var_has_length_guard(script_text: str, array_var: str) -> bool:
    return bool(
        re.search(rf"\b{re.escape(array_var)}\s*\.\s*length\s*\(", script_text)
        or re.search(rf"\b{re.escape(array_var)}\s*!=\s*null", script_text)
    )


def collect_response_guard_findings(page_file: Path, artifacts: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    seen: Set[Tuple[str, ...]] = set()
    services_by_scope: Dict[Tuple[str, str], Set[str]] = defaultdict(set)

    for service in artifacts["ws_nodes"]:
        scope = page_scope(service["page_id"], service["page_title"])
        if service["service_id"]:
            services_by_scope[scope].add(service["service_id"])

    for script in artifacts["script_nodes"]:
        scope = page_scope(script["page_id"], script["page_title"])
        script_text = script["script_text"]
        node_key = (
            page_file.name,
            script["page_id"],
            script["page_title"],
            script["node_id"],
            script["node_type"],
            script["property_name"],
        )

        for service_id in sorted(extract_service_refs_from_script(script_text, services_by_scope.get(scope, set()))):
            if script_uses_raw_response_for_service(script_text, service_id) and not script_has_response_code_guard(
                script_text, service_id
            ):
                key = node_key + (service_id, "RAW_RESPONSE_WITHOUT_STATUS_GUARD")
                if key not in seen:
                    seen.add(key)
                    rows.append(
                        {
                            "Source_File": page_file.name,
                            "Page": page_display(script["page_id"], script["page_title"]),
                            "Page_Title": script["page_title"],
                            "Node_ID": script["node_id"],
                            "Node_Type": script["node_type"],
                            "Property": script["property_name"],
                            "Related_Service": service_id,
                            "Finding": "RAW_RESPONSE_WITHOUT_STATUS_GUARD",
                            "Severity": "MEDIUM",
                            "Details": "Script reads raw API response without checking the service response code in the same handler. Guarding the status code can prevent brittle parsing and avoid extra retry traffic after failed calls.",
                        }
                    )

        for match in JSON_ARRAY_ASSIGN_RX.finditer(script_text):
            array_var = match.group(1)
            array_key = match.group(2)
            indexed = re.search(
                rf"\b{re.escape(array_var)}\s*\.\s*get(?:JSONObject|JSONArray|String|Int|Long|Double|Boolean)?\s*\(\s*0\b",
                script_text,
                re.IGNORECASE,
            )
            if indexed and not array_var_has_length_guard(script_text, array_var):
                key = node_key + (array_var, "ARRAY_ITEMS_WITHOUT_LENGTH_GUARD")
                if key not in seen:
                    seen.add(key)
                    rows.append(
                        {
                            "Source_File": page_file.name,
                            "Page": page_display(script["page_id"], script["page_title"]),
                            "Page_Title": script["page_title"],
                            "Node_ID": script["node_id"],
                            "Node_Type": script["node_type"],
                            "Property": script["property_name"],
                            "Related_Service": "",
                            "Finding": "ARRAY_ITEMS_WITHOUT_LENGTH_GUARD",
                            "Severity": "HIGH",
                            "Details": f"JSONArray variable '{array_var}' sourced from '{array_key}' is indexed at 0 without a visible length() guard.",
                        }
                    )

        for match in JSON_ARRAY_DIRECT_INDEX_RX.finditer(script_text):
            array_key = match.group(1)
            key = node_key + (array_key, "DIRECT_ARRAY_INDEX_WITHOUT_LENGTH_GUARD")
            if key not in seen:
                seen.add(key)
                rows.append(
                    {
                        "Source_File": page_file.name,
                        "Page": page_display(script["page_id"], script["page_title"]),
                        "Page_Title": script["page_title"],
                        "Node_ID": script["node_id"],
                        "Node_Type": script["node_type"],
                        "Property": script["property_name"],
                        "Related_Service": "",
                        "Finding": "DIRECT_ARRAY_INDEX_WITHOUT_LENGTH_GUARD",
                        "Severity": "HIGH",
                        "Details": f"JSONArray '{array_key}' is indexed directly at 0 without a visible length() guard.",
                    }
                )

    return rows


def mirror_property_group(prop_name: str) -> str:
    lower = (prop_name or "").lower()
    if lower in {"_onexit", "_onkeypress"}:
        return "input_navigation"
    if lower == "_onclick":
        return "click"
    if lower == "_onresponsereceived":
        return "response"
    return lower


def mirror_normalize_script(text: str) -> str:
    body = normalize_script_body(text)
    body = re.sub(r'"[^"\n]*"', '""', body)
    body = re.sub(r"'[^'\n]*'", "''", body)
    body = re.sub(r"\b\d+\b", "0", body)
    body = re.sub(r"\s+", " ", body).strip()
    return body


def mirror_tokens(text: str) -> List[str]:
    found = re.findall(r"[A-Za-z_]{3,}", text.lower())
    return sorted({tok for tok in found if tok not in MIRROR_STOPWORDS})


def collect_mirror_handler_findings(page_file: Path, artifacts: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    exact_groups: Dict[Tuple[Tuple[str, str], str, str], List[Dict[str, Any]]] = defaultdict(list)
    buckets: Dict[Tuple[Tuple[str, str], str, int, Tuple[str, ...]], List[Dict[str, Any]]] = defaultdict(list)
    seen_pairs: Set[Tuple[str, ...]] = set()

    services_by_scope: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    for service in artifacts["ws_nodes"]:
        scope = page_scope(service["page_id"], service["page_title"])
        if service["service_id"]:
            services_by_scope[scope].add(service["service_id"])

    entries: List[Dict[str, Any]] = []
    for script in artifacts["script_nodes"]:
        scope = page_scope(script["page_id"], script["page_title"])
        normalized = mirror_normalize_script(script["script_text"])
        if len(normalized) < 80:
            continue
        tokens = mirror_tokens(normalized)
        entry = {
            "page_id": script["page_id"],
            "page_title": script["page_title"],
            "scope": scope,
            "node_ref": f"{script['node_id']}.{script['property_name']}",
            "node_id": script["node_id"],
            "property_name": script["property_name"],
            "property_group": mirror_property_group(script["property_name"]),
            "normalized": normalized,
            "tokens": tokens,
            "service_refs": extract_service_refs_from_script(
                script["script_text"],
                services_by_scope.get(scope, set()),
            ),
        }
        entries.append(entry)
        exact_groups[(scope, entry["property_group"], normalized)].append(entry)
        buckets[(scope, entry["property_group"], len(normalized) // 300, tuple(tokens[:6]))].append(entry)

    for (scope, _group, _normalized), group_entries in exact_groups.items():
        unique_refs = sorted({entry["node_ref"] for entry in group_entries})
        if len(unique_refs) <= 1:
            continue
        shared_services = set(group_entries[0]["service_refs"])
        for entry in group_entries[1:]:
            shared_services &= entry["service_refs"]
        group_key = tuple(unique_refs)
        if group_key in seen_pairs:
            continue
        seen_pairs.add(group_key)
        node_refs = " | ".join(unique_refs)
        details = "Different nodes contain the exact same handler logic. Consider extracting a shared function."
        if shared_services:
            details += f" Shared API calls: {sample_join(shared_services)}. Reusing a function can keep request behavior consistent and avoid accidental duplicate call patterns."
        rows.append(
            {
                "Source_File": page_file.name,
                "Page": page_display(scope[0], scope[1]),
                "Page_Title": scope[1],
                "Finding": "MIRROR_HANDLER_EXACT",
                "Severity": "MEDIUM",
                "Node_Refs": node_refs,
                "Similarity": 100,
                "Shared_Service_IDs": sample_join(shared_services),
                "Details": details,
            }
        )

    for (_scope, _group, _len_bucket, _token_bucket), bucket_entries in buckets.items():
        if len(bucket_entries) < 2:
            continue
        if len(bucket_entries) > 18:
            continue
        for left, right in combinations(bucket_entries, 2):
            if left["node_ref"] == right["node_ref"]:
                continue
            if left["node_id"] == right["node_id"]:
                continue
            if abs(len(left["normalized"]) - len(right["normalized"])) > 400:
                continue
            pair_key = tuple(sorted([left["node_ref"], right["node_ref"]]))
            if pair_key in seen_pairs:
                continue
            similarity = fuzzy_ratio(left["normalized"], right["normalized"])
            if similarity < 93:
                continue
            seen_pairs.add(pair_key)
            shared_services = sorted(left["service_refs"] & right["service_refs"])
            details = "Handlers are highly similar across different nodes. Consider consolidating the logic into a shared helper."
            if shared_services:
                details += f" Shared API calls: {sample_join(shared_services)}. Centralizing the flow can keep request counts, headers, and projections aligned."
            rows.append(
                {
                    "Source_File": page_file.name,
                    "Page": page_display(left["page_id"], left["page_title"]),
                    "Page_Title": left["page_title"],
                    "Finding": "MIRROR_HANDLER_NEAR_DUPLICATE",
                    "Severity": "LOW",
                    "Node_Refs": f"{left['node_ref']} | {right['node_ref']}",
                    "Similarity": similarity,
                    "Shared_Service_IDs": sample_join(shared_services),
                    "Details": details,
                }
            )

    return rows


def normalize_variant_group_key(stem: str) -> str:
    parts = [part for part in stem.split("_") if part]
    if not parts:
        return stem

    while parts:
        upper = parts[-1].upper()
        if len(parts) >= 2 and parts[-2].upper() == "TEMP" and parts[-1].upper() == "BACKUP":
            parts = parts[:-2]
            continue
        if re.fullmatch(r"V\d+", upper):
            parts.pop()
            continue
        if re.fullmatch(r"BKP\d*", upper):
            parts.pop()
            continue
        if upper in VARIANT_SUFFIX_TOKENS:
            parts.pop()
            continue
        break

    return "_".join(parts) or stem


def summarize_api_flags(api_rows: List[Dict[str, Any]]) -> Counter:
    counter: Counter = Counter()
    for row in api_rows:
        for flag in [part.strip() for part in str(row.get("flag", "")).split(",") if part.strip() and part.strip() != "OK"]:
            counter[flag] += 1
    return counter


def build_variant_file_summary(
    page_file: Path,
    artifacts: Dict[str, List[Dict[str, Any]]],
    api_rows: List[Dict[str, Any]],
) -> Dict[str, Any]:
    page_labels = sorted({page_display(page["page_id"], page["page_title"]) for page in artifacts["page_nodes"]})
    return {
        "file_name": page_file.name,
        "file_stem": page_file.stem,
        "variant_group": normalize_variant_group_key(page_file.stem),
        "page_labels": page_labels,
        "ui_ids": {node["id"] for node in artifacts["ui_nodes"] if node["id"]},
        "ws_ids": {service["service_id"] for service in artifacts["ws_nodes"] if service["service_id"]},
        "endpoint_keys": {
            key
            for key in (normalize_wsurl_to_endpoint_key(service["wsurl"]) for service in artifacts["ws_nodes"])
            if key
        },
        "api_flags": summarize_api_flags(api_rows),
    }


def build_variant_network_note(left: Dict[str, Any], right: Dict[str, Any]) -> str:
    left_score = (
        len(left["endpoint_keys"])
        + len(left["ws_ids"])
        + 3 * left["api_flags"].get("MISSING_FIELDS", 0)
        + 2 * left["api_flags"].get("MISSING_ONLYDATA", 0)
        + 2 * left["api_flags"].get("MISSING_LIMIT", 0)
    )
    right_score = (
        len(right["endpoint_keys"])
        + len(right["ws_ids"])
        + 3 * right["api_flags"].get("MISSING_FIELDS", 0)
        + 2 * right["api_flags"].get("MISSING_ONLYDATA", 0)
        + 2 * right["api_flags"].get("MISSING_LIMIT", 0)
    )
    if left_score == right_score:
        return "No clear network-load winner from the current heuristic."
    if left_score < right_score:
        return f"{left['file_name']} looks lighter on API/network usage based on fewer endpoints/services and stronger GET shaping."
    return f"{right['file_name']} looks lighter on API/network usage based on fewer endpoints/services and stronger GET shaping."


def build_page_variant_diff_rows(file_summaries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    grouped: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    for summary in file_summaries:
        grouped[summary["variant_group"]].append(summary)

    for group_name, items in grouped.items():
        if len(items) <= 1:
            continue
        for left, right in combinations(sorted(items, key=lambda item: item["file_name"]), 2):
            ui_only_left = sorted(left["ui_ids"] - right["ui_ids"])
            ui_only_right = sorted(right["ui_ids"] - left["ui_ids"])
            ws_only_left = sorted(left["ws_ids"] - right["ws_ids"])
            ws_only_right = sorted(right["ws_ids"] - left["ws_ids"])
            endpoint_only_left = sorted(left["endpoint_keys"] - right["endpoint_keys"])
            endpoint_only_right = sorted(right["endpoint_keys"] - left["endpoint_keys"])

            flag_deltas = []
            all_flags = sorted(set(left["api_flags"]) | set(right["api_flags"]))
            for flag in all_flags:
                if left["api_flags"].get(flag, 0) != right["api_flags"].get(flag, 0):
                    flag_deltas.append(f"{flag}: {left['api_flags'].get(flag, 0)} vs {right['api_flags'].get(flag, 0)}")

            if not any((ui_only_left, ui_only_right, ws_only_left, ws_only_right, endpoint_only_left, endpoint_only_right, flag_deltas)):
                finding = "IDENTICAL_VARIANTS"
                severity = "LOW"
                details = "Variants are identical based on component IDs, webservices, endpoints, and current API findings."
            else:
                finding = "VARIANT_DRIFT"
                severity = "MEDIUM"
                details = "Variants differ in UI, API definitions, or API-efficiency findings. Review before keeping both versions active."

            rows.append(
                {
                    "Variant_Group": group_name,
                    "File_A": left["file_name"],
                    "File_B": right["file_name"],
                    "Pages_A": sample_join(left["page_labels"], limit=3),
                    "Pages_B": sample_join(right["page_labels"], limit=3),
                    "Finding": finding,
                    "Severity": severity,
                    "UI_Only_In_A": sample_join(ui_only_left),
                    "UI_Only_In_B": sample_join(ui_only_right),
                    "WS_Only_In_A": sample_join(ws_only_left),
                    "WS_Only_In_B": sample_join(ws_only_right),
                    "Endpoint_Only_In_A": sample_join(endpoint_only_left, limit=5),
                    "Endpoint_Only_In_B": sample_join(endpoint_only_right, limit=5),
                    "API_Flag_Delta": " | ".join(flag_deltas),
                    "Network_Note": build_variant_network_note(left, right),
                    "Details": details,
                }
            )

    return rows


def build_dataframe(rows: List[Dict[str, Any]], columns: List[str]):
    if pd is None:
        raise RuntimeError("pandas is not available")
    return pd.DataFrame(rows, columns=columns)


# ---------------------------
# Main
# ---------------------------
def main(argv: Sequence[str] | None = None) -> int:
    if pd is None:
        print(
            f"[ERROR] pandas is not available in this Python environment: {PANDAS_IMPORT_ERROR}",
            file=sys.stderr,
        )
        return 2

    glossary_in, flexi_in, out_in = resolve_cli_or_prompt_inputs(argv)

    glossary_path = Path(glossary_in)
    if not glossary_path.exists() or not glossary_path.is_file():
        print(f"[ERROR] Glossary file not found: {glossary_path}", file=sys.stderr)
        return 2

    flexi_files = expand_inputs(flexi_in)
    if not flexi_files:
        print("[ERROR] No Flexi JSON files found from the input provided.", file=sys.stderr)
        return 2

    out_path = Path(out_in) if out_in else Path("flexi_review_toolkit.xlsx")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() != ".xlsx":
        out_path = out_path.with_suffix(".xlsx")

    # Load glossary + build indexes once
    glossary = load_json(glossary_path)
    if not isinstance(glossary, dict) or "fields" not in glossary or not isinstance(glossary["fields"], dict):
        print("[ERROR] Glossary JSON must contain a top-level 'fields' object/dict.", file=sys.stderr)
        return 2
    glossary_fields: Dict[str, Any] = glossary["fields"]
    gidx = build_glossary_indexes(glossary_fields)

    glossary_rows: List[Dict[str, Any]] = []
    api_rows: List[Dict[str, Any]] = []
    redundant_rows: List[Dict[str, Any]] = []
    commit_rows: List[Dict[str, Any]] = []
    structure_rows: List[Dict[str, Any]] = []
    reference_rows: List[Dict[str, Any]] = []
    script_rows: List[Dict[str, Any]] = []
    credential_rows: List[Dict[str, Any]] = []
    response_guard_rows: List[Dict[str, Any]] = []
    placeholder_rows: List[Dict[str, Any]] = []
    mirror_handler_rows: List[Dict[str, Any]] = []
    duplicate_call_rows: List[Dict[str, Any]] = []
    network_hotspot_rows: List[Dict[str, Any]] = []
    file_summaries: List[Dict[str, Any]] = []

    for page_file in flexi_files:
        try:
            root = load_json(page_file)
        except Exception as e:
            print(f"[WARN] Failed to read JSON: {page_file} ({e})", file=sys.stderr)
            continue

        artifacts = collect_page_artifacts(root)
        ui_nodes = artifacts["ui_nodes"]
        ws_nodes = artifacts["ws_nodes"]
        script_nodes = artifacts["script_nodes"]

        # ---------------------------
        # 0) Commit Validation
        # ---------------------------
        commit_rows.extend(collect_commit_validations(script_nodes, source_file=page_file.name))
        structure_rows.extend(collect_structure_findings(page_file, artifacts))
        reference_rows.extend(collect_reference_findings(page_file, artifacts))
        script_rows.extend(collect_script_findings(page_file, script_nodes))
        credential_rows.extend(collect_credential_findings(page_file, artifacts))
        response_guard_rows.extend(collect_response_guard_findings(page_file, artifacts))
        placeholder_rows.extend(collect_placeholder_dependency_findings(page_file, artifacts))
        mirror_handler_rows.extend(collect_mirror_handler_findings(page_file, artifacts))
        service_usage = collect_service_usage(artifacts)
        duplicate_call_rows.extend(collect_duplicate_call_risk_findings(page_file, artifacts, usage=service_usage))

        # ---------------------------
        # 1) Glossary_Report
        # ---------------------------
        agg = defaultdict(lambda: {"count": 0, "node_types": set(), "labels": set()})
        for n in ui_nodes:
            key = (n["page_id"], n["page_title"], n["id"])
            a = agg[key]
            a["count"] += 1
            if n.get("node_type"):
                a["node_types"].add(n["node_type"])
            if n.get("label"):
                a["labels"].add(n["label"])

        for (page_id, page_title, fid), data in agg.items():
            node_types = ", ".join(sorted(data["node_types"])) if data["node_types"] else ""
            labels = " | ".join(sorted(data["labels"])) if data["labels"] else ""

            cls = classify_glossary(
                found_id=fid,
                label=labels,
                idx=gidx,
                glossary_fields=glossary_fields,
            )

            glossary_rows.append(
                {
                    "page_file": page_file.name,
                    "page_id": page_id,
                    "page_title": page_title,
                    "found_id": fid,
                    "occurrences": data["count"],
                    "node_types": node_types,
                    "labels": labels,
                    "bucket": cls["bucket"],
                    "associated_glossary_field": cls["associated_glossary_field"],
                    "confidence": cls["confidence"],
                    "top_1": cls["top_1"],
                    "score_1": cls["score_1"],
                    "top_2": cls["top_2"],
                    "score_2": cls["score_2"],
                    "top_3": cls["top_3"],
                    "score_3": cls["score_3"],
                    "collision": cls["collision"],
                    "reason": cls["reason"],
                    "glossary_primary_description": cls["glossary_primary_description"],
                }
            )

        # ---------------------------
        # 2) API_Findings (Fusion GET missing fields=)
        # ---------------------------
        page_api_rows = build_api_findings(page_file, ws_nodes, artifacts["ws_refs"])
        api_rows.extend(page_api_rows)
        network_hotspot_rows.extend(
            collect_network_cost_hotspots(page_file, artifacts, page_api_rows, usage=service_usage)
        )

        # ---------------------------
        # 3) Redundant APIs (same endpoint path used multiple times in same page)
        # ---------------------------
        redundant_rows.extend(build_redundant_api_findings(page_file, ws_nodes))
        file_summaries.append(build_variant_file_summary(page_file, artifacts, page_api_rows))

    variant_diff_rows = build_page_variant_diff_rows(file_summaries)

    # ---------------------------
    # DataFrames + write output
    # ---------------------------
    glossary_columns = [
        "page_file",
        "page_id",
        "page_title",
        "found_id",
        "occurrences",
        "node_types",
        "labels",
        "bucket",
        "associated_glossary_field",
        "confidence",
        "top_1",
        "score_1",
        "top_2",
        "score_2",
        "top_3",
        "score_3",
        "collision",
        "reason",
        "glossary_primary_description",
    ]
    api_columns = [
        "page_file",
        "page_id",
        "page_title",
        "service_id",
        "description",
        "operation",
        "wsurl",
        "request",
        "used_by_node_types",
        "has_fields",
        "fields_found_in",
        "fields_count",
        "has_onlyData_true",
        "onlyData_found_in",
        "onlyData_value",
        "has_limit",
        "limit_found_in",
        "limit_value",
        "flag",
        "severity",
        "reason",
    ]
    redundant_columns = [
        "page_file",
        "page_id",
        "page_title",
        "endpoint_path",
        "count",
        "methods_seen",
        "service_ids_using_same_wsurl",
        "example_wsurls",
        "notes",
    ]
    commit_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "ID",
        "Action",
        "Code",
        "Commented",
        "HAS_TRY_EXCEPT",
    ]
    structure_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "Node_ID",
        "Node_Type",
        "Finding",
        "Severity",
        "Details",
        "Related_Values",
    ]
    reference_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "Node_ID",
        "Node_Type",
        "Finding",
        "Severity",
        "Details",
        "Related_ID",
    ]
    script_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "Node_ID",
        "Node_Type",
        "Property",
        "Finding",
        "Severity",
        "Details",
    ]
    credential_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "Node_ID",
        "Node_Type",
        "Property",
        "Finding",
        "Severity",
        "Details",
        "Matched_Sample",
    ]
    response_guard_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "Node_ID",
        "Node_Type",
        "Property",
        "Related_Service",
        "Finding",
        "Severity",
        "Details",
    ]
    placeholder_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "Placeholder",
        "Used_By_Services",
        "Used_In",
        "Detected_Sources",
        "Example_Source_Refs",
        "Severity",
        "Details",
    ]
    variant_diff_columns = [
        "Variant_Group",
        "File_A",
        "File_B",
        "Pages_A",
        "Pages_B",
        "Finding",
        "Severity",
        "UI_Only_In_A",
        "UI_Only_In_B",
        "WS_Only_In_A",
        "WS_Only_In_B",
        "Endpoint_Only_In_A",
        "Endpoint_Only_In_B",
        "API_Flag_Delta",
        "Network_Note",
        "Details",
    ]
    mirror_handler_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "Finding",
        "Severity",
        "Node_Refs",
        "Similarity",
        "Shared_Service_IDs",
        "Details",
    ]
    duplicate_call_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "Service_ID",
        "Risk_Type",
        "Severity",
        "Handler_Refs",
        "Call_Count",
        "Details",
    ]
    network_hotspot_columns = [
        "Source_File",
        "Page",
        "Page_Title",
        "Service_ID",
        "Operation",
        "Endpoint_Path",
        "Hotspot_Level",
        "Network_Score",
        "Component_Refs",
        "Handler_Refs",
        "Total_Call_Count",
        "API_Flags",
        "Details",
    ]

    df_glossary = build_dataframe(glossary_rows, glossary_columns)
    df_api = build_dataframe(api_rows, api_columns)
    df_redundant = build_dataframe(redundant_rows, redundant_columns)
    df_commit = build_dataframe(commit_rows, commit_columns)
    df_structure = build_dataframe(structure_rows, structure_columns)
    df_reference = build_dataframe(reference_rows, reference_columns)
    df_script = build_dataframe(script_rows, script_columns)
    df_credential = build_dataframe(credential_rows, credential_columns)
    df_response_guard = build_dataframe(response_guard_rows, response_guard_columns)
    df_placeholder = build_dataframe(placeholder_rows, placeholder_columns)
    df_variant_diff = build_dataframe(variant_diff_rows, variant_diff_columns)
    df_mirror_handler = build_dataframe(mirror_handler_rows, mirror_handler_columns)
    df_duplicate_call = build_dataframe(duplicate_call_rows, duplicate_call_columns)
    df_network_hotspot = build_dataframe(network_hotspot_rows, network_hotspot_columns)

    # Helpful sorting (optional, but makes Excel easier)
    if not df_glossary.empty:
        bucket_rank = {BUCKET_LOW: 0, BUCKET_MED: 1, BUCKET_HIGH: 2, BUCKET_EXACT: 3}
        df_glossary["__rank"] = df_glossary["bucket"].map(bucket_rank).fillna(9).astype(int)
        df_glossary = df_glossary.sort_values(by=["__rank", "confidence"], ascending=[True, False]).drop(columns="__rank")

    if not df_api.empty:
        api_rank = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "": 3}
        df_api["__rank"] = df_api["severity"].map(api_rank).fillna(9).astype(int)
        df_api = df_api.sort_values(by=["__rank", "page_file", "page_id", "service_id"], ascending=[True, True, True, True]).drop(columns="__rank")

    if not df_redundant.empty:
        df_redundant = df_redundant.sort_values(by=["page_file", "page_id", "count", "endpoint_path"], ascending=[True, True, False, True])

    if not df_commit.empty:
        commit_sort_cols = [col for col in ("Source_File", "Page", "ID", "Action") if col in df_commit.columns]
        df_commit = df_commit.sort_values(by=commit_sort_cols, ascending=[True] * len(commit_sort_cols))

    for df in (
        df_structure,
        df_reference,
        df_script,
        df_credential,
        df_response_guard,
        df_placeholder,
    ):
        if not df.empty:
            df["__rank"] = df["Severity"].map({"HIGH": 0, "MEDIUM": 1, "LOW": 2}).fillna(9).astype(int)
            sort_cols = ["__rank"]
            for col in ("Source_File", "Page", "Node_ID", "Placeholder", "Finding"):
                if col in df.columns:
                    sort_cols.append(col)
            ascending = [True] * len(sort_cols)
            df.sort_values(by=sort_cols, ascending=ascending, inplace=True)
            df.drop(columns="__rank", inplace=True)

    if not df_variant_diff.empty:
        df_variant_diff["__rank"] = df_variant_diff["Severity"].map({"HIGH": 0, "MEDIUM": 1, "LOW": 2}).fillna(9).astype(int)
        df_variant_diff = df_variant_diff.sort_values(
            by=["__rank", "Variant_Group", "File_A", "File_B"],
            ascending=[True, True, True, True],
        ).drop(columns="__rank")

    if not df_mirror_handler.empty:
        df_mirror_handler["__rank"] = df_mirror_handler["Severity"].map({"HIGH": 0, "MEDIUM": 1, "LOW": 2}).fillna(9).astype(int)
        df_mirror_handler = df_mirror_handler.sort_values(
            by=["__rank", "Source_File", "Page", "Similarity"],
            ascending=[True, True, True, False],
        ).drop(columns="__rank")

    if not df_duplicate_call.empty:
        df_duplicate_call["__rank"] = df_duplicate_call["Severity"].map({"HIGH": 0, "MEDIUM": 1, "LOW": 2}).fillna(9).astype(int)
        df_duplicate_call = df_duplicate_call.sort_values(
            by=["__rank", "Source_File", "Page", "Service_ID", "Risk_Type"],
            ascending=[True, True, True, True, True],
        ).drop(columns="__rank")

    if not df_network_hotspot.empty:
        df_network_hotspot["__rank"] = df_network_hotspot["Hotspot_Level"].map({"HIGH": 0, "MEDIUM": 1, "LOW": 2}).fillna(9).astype(int)
        df_network_hotspot = df_network_hotspot.sort_values(
            by=["__rank", "Network_Score", "Source_File", "Page", "Service_ID"],
            ascending=[True, False, True, True, True],
        ).drop(columns="__rank")

    try:
        with pd.ExcelWriter(out_path, engine="openpyxl") as xw:
            df_glossary.to_excel(xw, index=False, sheet_name="Glossary_Report")
            df_api.to_excel(xw, index=False, sheet_name="API_Findings")
            df_redundant.to_excel(xw, index=False, sheet_name="Redundant APIs")
            df_commit.to_excel(xw, index=False, sheet_name="Commit Validation")
            df_structure.to_excel(xw, index=False, sheet_name="Structure Findings")
            df_reference.to_excel(xw, index=False, sheet_name="Reference Findings")
            df_script.to_excel(xw, index=False, sheet_name="Script Findings")
            df_credential.to_excel(xw, index=False, sheet_name="Credential Findings")
            df_response_guard.to_excel(xw, index=False, sheet_name="Response Guard Findings")
            df_placeholder.to_excel(xw, index=False, sheet_name="Placeholder Dependency Findings")
            df_variant_diff.to_excel(xw, index=False, sheet_name="Page Variant Diff Report")
            df_mirror_handler.to_excel(xw, index=False, sheet_name="Mirror Handler Findings")
            df_duplicate_call.to_excel(xw, index=False, sheet_name="Duplicate Call Risk")
            df_network_hotspot.to_excel(xw, index=False, sheet_name="Network Cost Hotspots")
    except ImportError as exc:
        print(f"[ERROR] Excel writer dependency missing: {exc}. Install openpyxl.", file=sys.stderr)
        return 2

    print(f"Excel report written: {out_path.resolve()}")
    print(f"Pages scanned: {len(flexi_files)}")
    print(f"Glossary rows: {len(df_glossary)}")
    print(f"API findings rows: {len(df_api)}")
    print(f"Redundant API groups: {len(df_redundant)}")
    print(f"Commit validation rows: {len(df_commit)}")
    print(f"Structure findings: {len(df_structure)}")
    print(f"Reference findings: {len(df_reference)}")
    print(f"Script findings: {len(df_script)}")
    print(f"Credential findings: {len(df_credential)}")
    print(f"Response guard findings: {len(df_response_guard)}")
    print(f"Placeholder dependency findings: {len(df_placeholder)}")
    print(f"Page variant diff rows: {len(df_variant_diff)}")
    print(f"Mirror handler findings: {len(df_mirror_handler)}")
    print(f"Duplicate call risk findings: {len(df_duplicate_call)}")
    print(f"Network cost hotspots: {len(df_network_hotspot)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
