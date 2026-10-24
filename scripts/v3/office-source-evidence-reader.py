"""Bounded OOXML source evidence; standard library only, no layout inference."""
import hashlib
import base64
import io
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from html.parser import HTMLParser

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def local(tag):
    return tag.rsplit("}", 1)[-1]


def paths(root):
    result = {}
    def walk(node, path):
        result[node] = path
        counts = {}
        for child in node:
            name = local(child.tag)
            counts[name] = counts.get(name, 0) + 1
            walk(child, path + "/" + name + "[" + str(counts[name]) + "]")
    walk(root, "/" + local(root.tag) + "[1]")
    return result


def text(node, namespace):
    values = []
    for item in node.iter():
        if item.tag == "{" + namespace + "}t":
            values.append(item.text or "")
        elif namespace == W and item.tag == "{" + W + "}tab":
            values.append("\t")
        elif namespace == W and item.tag in ("{" + W + "}br", "{" + W + "}cr"):
            values.append("\n")
    return "".join(values)


def read_source(source, kind, scope):
    raw = Path(source).read_bytes()
    parts = []
    records = []
    raw_parts = []
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        def part(name):
            if name.startswith("/") or ".." in name.split("/") or archive.namelist().count(name) != 1:
                raise ValueError("INVALID_PART_PATH")
            limit = scope.get('max_xml_bytes')
            info = archive.getinfo(name)
            if limit and sum(p['byte_length'] for p in parts) + info.file_size > limit:
                raise ValueError('XML_BYTE_LIMIT_EXCEEDED')
            data = archive.read(name)
            if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
                raise ValueError("UNSUPPORTED_XML_DECLARATION")
            if not any(p["path"] == name for p in parts):
                parts.append({"path": name, "sha256": sha(data), "byte_length": len(data)})
                raw_parts.append({'path': name, 'sha256': sha(data), 'byte_length': len(data), 'xml': data.decode('utf-8'), 'locator_root': '/' + local(ET.fromstring(data).tag) + '[1]'})
            return ET.fromstring(data)

        def relations(name, base):
            root = part(name)
            result = {}
            for rel in root:
                if rel.get("TargetMode") == "External":
                    if scope.get('real_pilot'):
                        records.append({'id': name + '#' + rel.get('Id', ''), 'kind': 'unsupported', 'locator': {'part': name, 'relationship_id': rel.get('Id')}, 'physical_page': None, 'evidence_origin': 'source_only', 'feature': 'external_relationship', 'target': rel.get('Target'), 'status': 'unsupported'})
                    continue
                target = rel.get("Target", "")
                target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(base, target))
                result[rel.get("Id")] = {"part": target, "type": rel.get("Type")}
            return result

        def add(kind, name, path, **fields):
            record = {"id": name + "#" + path, "kind": kind,
                      "locator": {"part": name, "xml_path": path}, "physical_page": None,
                      "evidence_origin": "source_only", **fields}
            records.append(record)
            if len(records) > scope.get('max_source_records', 100000):
                raise ValueError('SOURCE_RECORD_LIMIT_EXCEEDED')
            return record

        if kind == "docx":
            name = "word/document.xml"
            root = part(name)
            if scope.get('real_pilot'):
                body = root.find('{' + W + '}body')
                titles = [n for n in body if local(n.tag) == 'p' and text(n, W).strip()]
                tables = [n for n in body if local(n.tag) == 'tbl']
                if len(titles) != 1 or len(tables) != 1 or len(tables[0].findall('{' + W + '}tr')) != 5 or any(len(r.findall('{' + W + '}tc')) != 2 for r in tables[0].findall('{' + W + '}tr')):
                    raise ValueError('DOCX_BODY_SCOPE_MISMATCH')
            node_paths = paths(root)
            rels = relations("word/_rels/document.xml.rels", "word")
            referenced = set()
            footnote_rel = next((v for v in rels.values() if v["type"].endswith("/footnotes")), None)
            for node in root.iter():
                tag = local(node.tag)
                if tag in ("p", "tbl", "tr", "tc") and node.tag.startswith("{" + W + "}"):
                    add({"p": "paragraph", "tbl": "table", "tr": "row", "tc": "cell"}[tag], name,
                        node_paths[node], text=text(node, W) if tag in ("p", "tc") else None)
                elif node.tag == "{" + W + "}footnoteReference":
                    fid = node.get("{" + W + "}id")
                    referenced.add(fid)
                    add("footnote_reference", name, node_paths[node], footnote_id=fid,
                        definition_part=footnote_rel["part"] if footnote_rel else None)
                elif node.tag == "{" + W + "}br":
                    add("layout_break", name, node_paths[node], break_type=node.get("{" + W + "}type", "textWrapping"))
                elif tag in ("fldChar", "instrText", "ins", "del", "drawing", "pict", "altChunk"):
                    add("unsupported", name, node_paths[node], feature=tag)
                elif scope.get('real_pilot') and tag in ('gridSpan', 'vMerge'):
                    add('unsupported', name, node_paths[node], feature=tag, attributes=dict(node.attrib), status='unsupported')
                if scope.get('real_pilot') and tag == 'tbl' and node is not tables[0]:
                    add('unsupported', name, node_paths[node], feature='nested_table', status='unsupported')
            if referenced and not footnote_rel:
                raise ValueError("FOOTNOTE_RELATIONSHIP_MISSING")
            if footnote_rel and (referenced or not scope.get('real_pilot')):
                fn = part(footnote_rel["part"])
                fp = paths(fn)
                defined = set()
                for node in fn:
                    fid = node.get("{" + W + "}id")
                    ftype = node.get("{" + W + "}type", "normal")
                    if fid in referenced or ftype != "normal":
                        rec = add("footnote" if ftype == "normal" else "footnote_separator", footnote_rel["part"], fp[node],
                                  footnote_id=fid, footnote_type=ftype, text=text(node, W))
                        defined.add(fid)
                        for ref in records:
                            if ref["kind"] == "footnote_reference" and ref["footnote_id"] == fid:
                                ref["definition_locator"] = rec["locator"]
                if not referenced.issubset(defined):
                    raise ValueError("FOOTNOTE_DEFINITION_MISSING")
        elif kind == "xlsx":
            root = part("xl/workbook.xml")
            rels = relations("xl/_rels/workbook.xml.rels", "xl")
            if scope.get('real_pilot') and len(root.find('{' + S + '}sheets')) != 1:
                raise ValueError('SHEET_COUNT_MISMATCH')
            styles = None
            if scope.get('real_pilot'):
                target = next((r['part'] for r in rels.values() if r['type'].endswith('/styles')), None)
                if target:
                    styles = part(target)
            strings = None
            for selection in scope["ranges"]:
                sheets = root.find("{" + S + "}sheets")
                sheet = list(sheets)[selection["sheet_index"]]
                if sheet.get("name") != selection["sheet_name"]:
                    raise ValueError("SHEET_SELECTION_MISMATCH")
                name = rels[sheet.get("{" + R + "}id")]["part"]
                ws = part(name)
                xp = paths(ws)
                cell_nodes = {n.get("r"): n for n in ws.iter("{" + S + "}c")}
                merges = [n.get("ref") for n in ws.iter("{" + S + "}mergeCell")]
                def coordinate(address):
                    match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", address)
                    if not match:
                        raise ValueError("INVALID_COORDINATE")
                    column = 0
                    for letter in match[1]:
                        column = column * 26 + ord(letter) - 64
                    return int(match[2]), column
                def address(row, col):
                    letters = ""
                    while col:
                        col, rem = divmod(col - 1, 26)
                        letters = chr(65 + rem) + letters
                    return letters + str(row)
                ends = selection["range"].split(":")
                start, end = coordinate(ends[0]), coordinate(ends[-1])
                for row in range(start[0], end[0] + 1):
                    for col in range(start[1], end[1] + 1):
                        addr = address(row, col)
                        node = cell_nodes.get(addr)
                        v = node.find("{" + S + "}v") if node is not None else None
                        f = node.find("{" + S + "}f") if node is not None else None
                        typ = node.get("t") if node is not None else None
                        raw_value = v.text if v is not None else None
                        value_text = raw_value
                        unresolved = False
                        if typ == "inlineStr":
                            value_text = text(node, S)
                        elif typ == "s":
                            if strings is None:
                                target = next((r["part"] for r in rels.values() if r["type"].endswith("/sharedStrings")), None)
                                if not target:
                                    raise ValueError("SHARED_STRINGS_MISSING")
                                strings = [text(n, S) for n in part(target)]
                            value_text = strings[int(raw_value)]
                        elif typ not in (None, "n", "b", "e", "str", "d"):
                            unresolved = True
                        state = "unserialized" if node is None else "formula_cached" if f is not None and v is not None else "formula_uncached" if f is not None else "error" if typ == "e" else "explicit_empty" if v is None and not value_text else "value"
                        if f is not None and f.get("t") in ("shared", "array", "dataTable"):
                            unresolved = True
                        membership = []
                        for merge in merges:
                            bounds = merge.split(":")
                            low, high = coordinate(bounds[0]), coordinate(bounds[-1])
                            if low[0] <= row <= high[0] and low[1] <= col <= high[1]:
                                membership.append(merge)
                        add("workbook_cell", name, xp[node] if node is not None else "/worksheet[1]/sheetData[1]/unserialized(" + addr + ")",
                            sheet={"index": selection["sheet_index"], "sheet_id": sheet.get("sheetId"), "name": sheet.get("name"), "visibility": sheet.get("state", "visible")},
                            address=addr, row=row, column=col, serialized=node is not None, xml_type=typ,
                            raw_value=raw_value, text=value_text, state=state,
                            formula={"present": f is not None, "text": f.text if f is not None else None, "attributes": dict(f.attrib) if f is not None else {}},
                            cache={"element_present": v is not None, "raw_value": raw_value}, merges=membership, unresolved=unresolved)
                        if scope.get('real_pilot'):
                            records[-1]['style_index'] = node.get('s') if node is not None else None
                            records[-1]['number_format_interpretation'] = 'not_rendered'
        else:
            raise ValueError("UNSUPPORTED_FORMAT")
    result = {"format": kind, "source": {"sha256": sha(raw), "byte_length": len(raw)}, "scope": scope, "parts": parts, "records": records}
    if scope.get('real_pilot'):
        result['raw_parts'] = raw_parts
    return result


def read_whole_paper_source(source, scope):
    """Explicit complete OOXML parts, never a conversion, formula evaluator or network client."""
    if scope.get('profile') != 'whole-paper-source-1.0' or scope.get('format') not in ('docx', 'xlsx'):
        raise ValueError('WHOLE_PAPER_SOURCE_SCOPE_INVALID')
    selected = scope.get('parts')
    if not isinstance(selected, list) or not selected or len(selected) != len(set(selected)):
        raise ValueError('WHOLE_PAPER_PART_SCOPE_INVALID')
    limit = scope.get('max_xml_bytes', 32 * 1024 * 1024)
    if not isinstance(limit, int) or not 0 < limit <= 32 * 1024 * 1024:
        raise ValueError('WHOLE_PAPER_XML_LIMIT')
    raw = Path(source).read_bytes()
    records, parts, raw_parts, roots = [], [], [], {}
    coverage = {'complete_selected_parts': True, 'sheets': [], 'uninterpreted_parts': []}
    with zipfile.ZipFile(io.BytesIO(raw)) as package:
        names = package.namelist()
        if len(names) != len(set(names)):
            raise ValueError('WHOLE_PAPER_DUPLICATE_PART')
        total = 0
        for name in selected:
            if not isinstance(name, str) or name.startswith('/') or '\\' in name or ':' in name or '..' in name.split('/') or not name.endswith(('.xml', '.rels')):
                raise ValueError('WHOLE_PAPER_PART_PATH_INVALID')
            info = package.getinfo(name)
            total += info.file_size
            if total > limit:
                raise ValueError('WHOLE_PAPER_XML_LIMIT')
        for name in selected:
            data = package.read(name)
            # Decode before screening as XML declarations may be UTF-16 encoded.
            decoded = data.decode('utf-16') if data.startswith((b'\xff\xfe', b'\xfe\xff')) else data.decode('utf-8-sig')
            if re.search(r'<!\s*(DOCTYPE|ENTITY)\b', decoded, re.I):
                raise ValueError('WHOLE_PAPER_XML_DECLARATION')
            roots[name] = ET.fromstring(decoded)
            parts.append({'path': name, 'sha256': sha(data), 'byte_length': len(data)})
            raw_parts.append({'path': name, 'sha256': sha(data), 'byte_length': len(data), 'xml': decoded, 'encoding': 'utf-16' if data.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8', 'raw_base64': base64.b64encode(data).decode('ascii')})

        def add(kind, name, locator, **fields):
            rec = {'id': name + '#' + locator, 'kind': kind, 'locator': {'part': name, 'part_sha256': next(p['sha256'] for p in parts if p['path'] == name), 'xml_path': locator}, 'physical_page': None, 'evidence_origin': 'source_only', **fields}
            records.append(rec)
            return rec

        def relationships(name, base):
            found = {}
            for rel in roots.get(name, []):
                rid, target = rel.get('Id'), rel.get('Target', '')
                if not rid or rid in found:
                    raise ValueError('WHOLE_PAPER_RELATIONSHIP_INVALID')
                if rel.get('TargetMode') == 'External':
                    found[rid] = None
                    add('external_relationship', name, '/Relationships/Relationship[@Id="' + rid + '"]', target=target, relation_type=rel.get('Type'), status='not_followed', text=None)
                    continue
                if ':' in target or '\\' in target:
                    raise ValueError('WHOLE_PAPER_RELATIONSHIP_INVALID')
                resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(base, target))
                if resolved.startswith('../') or resolved == '..' or resolved not in names:
                    raise ValueError('WHOLE_PAPER_RELATIONSHIP_INVALID')
                found[rid] = resolved
            return found

        if scope['format'] == 'docx':
            if 'word/document.xml' not in roots:
                raise ValueError('WHOLE_PAPER_DOCUMENT_PART_MISSING')
            for name, doc in roots.items():
                if name.endswith('.rels'):
                    base = posixpath.dirname(posixpath.dirname(name))
                    relationships(name, base)
                    continue
                if name.startswith('word/') and local(doc.tag) in ('document', 'footnotes', 'endnotes', 'comments', 'hdr', 'ftr'):
                    node_paths = paths(doc)
                    parent = {child: node for node in doc.iter() for child in node}
                    for node in doc.iter():
                        tag = local(node.tag)
                        if node.tag == '{' + W + '}' + tag and tag in ('p', 'tbl', 'tr', 'tc', 'footnote', 'endnote', 'comment'):
                            chain, cursor = [], parent.get(node)
                            while cursor is not None:
                                if local(cursor.tag) in ('tbl', 'tr', 'tc'):
                                    chain.append(node_paths[cursor])
                                cursor = parent.get(cursor)
                            own_text = text(node, W) if tag in ('p', 'footnote', 'endnote', 'comment') else '\n'.join(text(p, W) for p in node if local(p.tag) == 'p') if tag == 'tc' else None
                            rec = add({'p': 'paragraph', 'tbl': 'table', 'tr': 'row', 'tc': 'cell'}.get(tag, tag), name, node_paths[node], text=own_text, ancestry=list(reversed(chain)), attributes=dict(node.attrib))
                            if tag in ('tbl', 'tr', 'tc'):
                                rec['structure'] = {'direct_children': [local(c.tag) for c in node], 'properties': [{'name': local(p.tag), 'attributes': dict(p.attrib)} for p in node.iter() if local(p.tag) in ('gridSpan', 'vMerge', 'gridCol') and (tag == 'tc' or parent.get(p) in list(node))]}
                        elif tag in ('footnoteReference', 'endnoteReference', 'commentReference', 'hyperlink', 'fldChar', 'instrText', 'drawing', 'pict', 'altChunk', 'ins', 'del', 'oMath'):
                            add('feature', name, node_paths[node], feature=tag, attributes=dict(node.attrib), text=text(node, W) if tag == 'instrText' else None, status='source_recorded_not_interpreted')
                elif name not in ('[Content_Types].xml',):
                    coverage['uninterpreted_parts'].append(name)
        else:
            if 'xl/workbook.xml' not in roots or 'xl/_rels/workbook.xml.rels' not in roots:
                raise ValueError('WHOLE_PAPER_WORKBOOK_PART_MISSING')
            rels = relationships('xl/_rels/workbook.xml.rels', 'xl')
            sheet_nodes = list(roots['xl/workbook.xml'].find('{' + S + '}sheets'))
            selections = scope.get('sheets', [])
            if len(selections) != len(sheet_nodes) or sorted(s['index'] for s in selections) != list(range(len(sheet_nodes))):
                raise ValueError('WHOLE_PAPER_SHEET_SCOPE_INCOMPLETE')
            strings_name = next((v for v in rels.values() if v and v.endswith('/sharedStrings.xml')), None)
            strings = list(roots[strings_name]) if strings_name in roots else None
            def point(addr):
                match = re.fullmatch(r'([A-Z]+)([1-9][0-9]*)', addr)
                if not match:
                    raise ValueError('WHOLE_PAPER_CELL_COORDINATE_INVALID')
                col = 0
                for letter in match[1]:
                    col = col * 26 + ord(letter) - 64
                return int(match[2]), col
            def bounds(ref):
                ends = ref.split(':')
                if len(ends) not in (1, 2):
                    raise ValueError('WHOLE_PAPER_RANGE_INVALID')
                lo, hi = point(ends[0]), point(ends[-1])
                if lo[0] > hi[0] or lo[1] > hi[1]:
                    raise ValueError('WHOLE_PAPER_RANGE_INVALID')
                return lo, hi
            used_parts = {'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', strings_name}
            for selected_sheet in selections:
                index = selected_sheet['index']
                sheet = sheet_nodes[index]
                if sheet.get('name') != selected_sheet['name']:
                    raise ValueError('WHOLE_PAPER_SHEET_IDENTITY_MISMATCH')
                name = rels.get(sheet.get('{' + R + '}id'))
                if name not in roots:
                    raise ValueError('WHOLE_PAPER_SHEET_PART_MISSING')
                used_parts.add(name)
                ws, allowed = roots[name], bounds(selected_sheet['range'])
                xp = paths(ws)
                merges = [m.get('ref') for m in ws.iter('{' + S + '}mergeCell')]
                merge_bounds = [(m, bounds(m)) for m in merges]
                for _, (lo, hi) in merge_bounds:
                    if not (allowed[0][0] <= lo[0] <= hi[0] <= allowed[1][0] and allowed[0][1] <= lo[1] <= hi[1] <= allowed[1][1]):
                        raise ValueError('WHOLE_PAPER_MERGE_OUTSIDE_SCOPE')
                seen = set()
                for node in ws.iter('{' + S + '}c'):
                    addr = node.get('r', '')
                    row, col = point(addr)
                    if addr in seen or not (allowed[0][0] <= row <= allowed[1][0] and allowed[0][1] <= col <= allowed[1][1]):
                        raise ValueError('WHOLE_PAPER_CELL_SCOPE_MISMATCH')
                    seen.add(addr)
                    v, form = node.find('{' + S + '}v'), node.find('{' + S + '}f')
                    typ, raw_value = node.get('t', 'n'), v.text if v is not None else None
                    value = raw_value
                    if typ == 's':
                        if strings is None or raw_value is None or not re.fullmatch(r'\d+', raw_value) or int(raw_value) >= len(strings):
                            raise ValueError('WHOLE_PAPER_SHARED_STRING_MISSING')
                        value = text(strings[int(raw_value)], S)
                    elif typ == 'inlineStr':
                        value = text(node, S)
                    membership = [m for m, (lo, hi) in merge_bounds if lo[0] <= row <= hi[0] and lo[1] <= col <= hi[1]]
                    if len(membership) > 1:
                        raise ValueError('WHOLE_PAPER_MERGE_OVERLAP')
                    covered = bool(membership and (row, col) != bounds(membership[0])[0])
                    state = 'merged_covered' if covered else 'formula_uncached' if form is not None and v is None else 'formula_cached' if form is not None else 'error' if typ == 'e' else 'value' if v is not None or typ == 'inlineStr' else 'format_only'
                    add('workbook_cell', name, xp[node], sheet={'index': index, 'name': sheet.get('name'), 'sheet_id': sheet.get('sheetId'), 'visibility': sheet.get('state', 'visible')}, address=addr, row=row, column=col, state=state, xml_type=typ, raw_value=raw_value, text=value, serialized=True, merges=membership, formula={'present': form is not None, 'text': form.text if form is not None else None, 'attributes': dict(form.attrib) if form is not None else {}}, cache={'element_present': v is not None, 'raw_value': raw_value}, unresolved=typ not in ('n', 's', 'inlineStr', 'b', 'e', 'str', 'd') or form is not None and form.get('t') in ('shared', 'array', 'dataTable'), style_index=node.get('s'))
                coverage['sheets'].append({'index': index, 'name': sheet.get('name'), 'range': selected_sheet['range'], 'serialized_cells': len(seen), 'merged_ranges': merges, 'unserialized_not_assumed_blank': True})
            coverage['uninterpreted_parts'] = [n for n in selected if n not in used_parts]
    return {'format': scope['format'], 'source': {'sha256': sha(raw), 'byte_length': len(raw)}, 'scope': scope, 'parts': parts, 'raw_parts': raw_parts, 'records': records, 'coverage': coverage, 'read_accounting': {'xml_bytes': sum(p['byte_length'] for p in parts), 'source_bytes': len(raw)}, 'scientific_verification': False}


class TableUnits(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.units = []
        self.active = None
        self.index = 0

    def handle_starttag(self, tag, attrs):
        if tag == "p":
            if self.active is not None:
                raise ValueError("UNSUPPORTED_NESTED_PARAGRAPH")
            self.index += 1
            self.active = {"html_node_path": "p[" + str(self.index) + "]", "text": ""}
        elif tag == "br" and self.active is not None:
            self.active["text"] += "\n"

    def handle_data(self, data):
        if self.active is not None:
            self.active["text"] += data

    def handle_endtag(self, tag):
        if tag == "p" and self.active is not None:
            self.units.append(self.active)
            self.active = None


class TableStructure(HTMLParser):
    """Strict cached table hierarchy; never renders or expands spans."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.counts = {}
        self.table = None
        self.unsupported = False

    def handle_starttag(self, tag, attrs):
        if tag not in ('table', 'tr', 'td', 'th', 'p', 'strong', 'b', 'em', 'i', 'span', 'br'):
            raise ValueError('OFFICE_HTML_UNSUPPORTED')
        parent = self.stack[-1] if self.stack else None
        if tag == 'tr' and (not parent or parent['tag'] != 'table') or tag in ('td', 'th') and (not parent or parent['tag'] != 'tr') or tag == 'p' and (not parent or parent['tag'] not in ('td', 'th')):
            raise ValueError('OFFICE_HTML_MALFORMED')
        if len(dict(attrs)) != len(attrs):
            raise ValueError('OFFICE_HTML_DUPLICATE_ATTRIBUTE')
        key = (parent['path'] if parent else '') + '/' + tag
        self.counts[key] = self.counts.get(key, 0) + 1
        node = {'tag': tag, 'path': key + '[' + str(self.counts[key]) + ']', 'parent_path': parent['path'] if parent else None, 'attrs': dict(attrs), 'text': ''}
        if tag == 'table':
            if self.table:
                raise ValueError('OFFICE_HTML_MULTIPLE_TABLES')
            node['rows'] = []
            self.table = node
        elif tag == 'tr':
            node['cells'] = []
            parent['rows'].append(node)
        elif tag in ('td', 'th'):
            node['paragraphs'] = []
            parent['cells'].append(node)
            if 'rowspan' in node['attrs'] or 'colspan' in node['attrs']:
                self.unsupported = True
        elif tag == 'p':
            parent['paragraphs'].append(node)
        elif tag == 'br':
            for p in reversed(self.stack):
                if p['tag'] == 'p':
                    p['text'] += '\n'
                    break
            return
        self.stack.append(node)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1]['tag'] != tag:
            raise ValueError('OFFICE_HTML_MALFORMED')
        self.stack.pop()

    def handle_data(self, data):
        for p in reversed(self.stack):
            if p['tag'] == 'p':
                p['text'] += data
                return
        if data.strip():
            raise ValueError('OFFICE_HTML_TEXT_OUTSIDE_PARAGRAPH')

    def result(self):
        if self.stack or not self.table:
            raise ValueError('OFFICE_HTML_MALFORMED')
        for row in self.table['rows']:
            for cell in row['cells']:
                cell['text'] = ''.join(p['text'] for p in cell['paragraphs'])
        return {'table_path': self.table['path'], 'attrs': self.table['attrs'], 'rows': self.table['rows'], 'unsupported': self.unsupported}


if __name__ == "__main__":
    try:
        if sys.argv[1] == '--whole-paper-source':
            source, scope_path = sys.argv[2:]
            result = read_whole_paper_source(source, json.loads(Path(scope_path).read_text(encoding='utf-8')))
        elif sys.argv[1] == '--archive-member':
            source, inventory, selected = sys.argv[2:]
            expected = json.loads(Path(inventory).read_text(encoding='utf-8'))
            with zipfile.ZipFile(source) as archive:
                actual = [{'name': i.filename, 'bytes': i.file_size, 'crc': i.CRC, 'office_lock_file': '/~$' in i.filename} for i in archive.infolist() if not i.is_dir()]
                if actual != expected:
                    raise ValueError('ARCHIVE_INVENTORY_MISMATCH')
                selection = json.loads(selected)
                result = {'inventory': actual, 'members': []}
                for item in selection:
                    info = archive.getinfo(item['member_path'])
                    if info.file_size != item['registered_bytes']:
                        raise ValueError('MEMBER_LENGTH_MISMATCH')
                    data = archive.read(info)
                    if sha(data) != item['registered_sha256']:
                        raise ValueError('MEMBER_HASH_MISMATCH')
                    result['members'].append({'format': item['format'], 'member_path': item['member_path'], 'sha256': sha(data), 'byte_length': len(data), 'base64': base64.b64encode(data).decode('ascii')})
        elif sys.argv[1:] == ['--html-structure']:
            result = []
            for html in json.load(sys.stdin):
                if len(html.encode('utf-8')) > 524288:
                    raise ValueError('OFFICE_HTML_LIMIT')
                parser = TableStructure()
                parser.feed(html)
                parser.close()
                result.append(parser.result())
        elif sys.argv[1:] == ["--html-units"]:
            result = []
            for table in json.load(sys.stdin):
                parser = TableUnits()
                parser.feed(table)
                parser.close()
                if parser.active is not None:
                    raise ValueError("INCOMPLETE_HTML_PARAGRAPH")
                result.append(parser.units)
        else:
            source, kind, scope = sys.argv[1:]
            result = read_source(source, kind, json.loads(scope))
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=True), file=sys.stderr)
        sys.exit(1)
