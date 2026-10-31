"""Extract explicitly selected source images; read a JSON request from stdin."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path


def fingerprint(data):
    return {'sha256': 'sha256:' + hashlib.sha256(data).hexdigest(), 'byte_length': len(data)}


def extract(request):
    source = Path(request['source_path']).resolve(strict=True)
    root = Path(request['resources_root']).resolve(strict=True)
    if not source.is_file() or not root.is_dir():
        raise ValueError('invalid source or output directory')
    parent = {'path': str(source), **fingerprint(source.read_bytes())}
    records = []
    names = set()
    for item in request['items']:
        name = item['filename']
        if not name or Path(name).name != name or name in names:
            raise ValueError('invalid or duplicate output name')
        names.add(name)
        target = root / name
        if target.exists() or target.is_symlink():
            raise ValueError('output already exists')
        locator = item['locator']
        if locator['kind'] == 'docx-figure' and source.suffix.lower() == '.docx':
            media = item['media']
            if not media.startswith('word/media/') or '..' in media.split('/'):
                raise ValueError('invalid DOCX media')
            with zipfile.ZipFile(source) as doc:
                data = doc.read(media)
        elif locator['kind'] == 'pdf-page' and source.suffix.lower() == '.pdf':
            import fitz
            with fitz.open(source) as pdf:
                page = locator['page']
                if not isinstance(page, int) or page < 1 or page > len(pdf):
                    raise ValueError('page out of range')
                page_obj = pdf[page - 1]
                rect = fitz.Rect(item['rect']) if 'rect' in item else page_obj.rect
                if rect.is_empty or rect.is_infinite or not page_obj.rect.contains(rect):
                    raise ValueError('crop outside page')
                data = page_obj.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect, alpha=False).tobytes('png')
        else:
            raise ValueError('source and locator mismatch')
        with target.open('xb') as file:
            file.write(data)
        records.append({'id': item['id'], 'source_id': request['source_id'], 'locator': locator,
                        'source_path': str(target), 'path': item['path'], **fingerprint(data), 'parent': parent})
    return {'version': 'reading-resources-1.0', 'resources': records}


if __name__ == '__main__':
    try:
        print(json.dumps(extract(json.load(sys.stdin)), ensure_ascii=False))
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
