"""Render declared PDF regions without changing the source or reconstructing figures."""
import argparse
import hashlib
import json
from pathlib import Path

import fitz


def render_regions(source, regions, output_root):
    source = Path(source).resolve(strict=True)
    output_root = Path(output_root).resolve()
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    records = []
    prepared = []
    with fitz.open(source) as document:
        destinations = set()
        for region in regions:
            page_number = region['page']
            if not isinstance(page_number, int) or not 1 <= page_number <= len(document):
                raise ValueError('PDF_REGION_PAGE_INVALID')
            page = document[page_number - 1]
            box = fitz.Rect(region['bbox'])
            if box.is_empty or box.is_infinite or not page.rect.contains(box):
                raise ValueError('PDF_REGION_BOUNDS_INVALID')
            rotation = region.get('rotation', 0)
            dpi = region.get('dpi', 200)
            if rotation not in (0, 90, 180, 270) or not isinstance(dpi, int) or not 72 <= dpi <= 600:
                raise ValueError('PDF_REGION_RENDER_INVALID')
            target = (output_root / region['path']).resolve()
            if not target.is_relative_to(output_root) or target == output_root or target.suffix.lower() != '.png':
                raise ValueError('PDF_REGION_PATH_INVALID')
            if str(target).casefold() in destinations or target.exists():
                raise ValueError('PDF_REGION_TARGET_EXISTS')
            destinations.add(str(target).casefold())
            prepared.append((region, page, box, target, dpi, rotation))
        for region, page, box, target, dpi, rotation in prepared:
            matrix = fitz.Matrix(dpi / 72, dpi / 72).prerotate(rotation)
            image = page.get_pixmap(matrix=matrix, clip=box, alpha=False)
            data = image.tobytes('png')
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as handle:
                handle.write(data)
            records.append({
                'id': region['id'], 'path': region['path'],
                'source_path': str(source), 'source_sha256': source_hash,
                'page': region['page'], 'bbox': list(box), 'rotation': rotation,
                'dpi': dpi, 'width': image.width, 'height': image.height,
                'sha256': hashlib.sha256(data).hexdigest(), 'byte_length': len(data),
            })
    return records


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', help='JSON with source_pdf, output_root, regions')
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding='utf-8-sig'))
    print(json.dumps(render_regions(manifest['source_pdf'], manifest['regions'], manifest['output_root']), ensure_ascii=False, indent=2))
