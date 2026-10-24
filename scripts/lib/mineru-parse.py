"""Save MinerU results and its public content-list projection for APA consumers."""

import argparse
import json
from pathlib import Path


def main():
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument('source', type=Path)
    arguments.add_argument('output', type=Path)
    arguments.add_argument('--tier', choices=['flash', 'basic', 'standard', 'advanced'], default='standard')
    arguments.add_argument('--pages', default='all')
    args = arguments.parse_args()

    from mineru.parser import ParseResult, parse
    from mineru.parser.writer import FileBasedDataWriter
    from mineru.render import render_content_list

    result = parse(args.source, tier=args.tier, page_range=args.pages)
    result.save(FileBasedDataWriter(str(args.output)))
    # save() externalizes assets on a copy; use that copy so image paths match
    # the saved files, while retaining original zero-based source page indexes.
    saved = ParseResult.from_json((args.output / 'middle_json.json').read_text(encoding='utf-8'))
    content = render_content_list(saved.middle_json)
    with (args.output / 'content_list.json').open('x', encoding='utf-8') as stream:
        json.dump(content, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


if __name__ == '__main__':
    main()
