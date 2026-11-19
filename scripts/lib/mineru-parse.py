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
    arguments.add_argument('--read-only-input', action='store_true')
    args = arguments.parse_args()

    from mineru.parser import ParseResult, parse
    from mineru.parser.writer import DataWriter, FileBasedDataWriter
    from mineru.render import render_content_list

    result = parse(args.source, tier=args.tier, page_range=args.pages)
    if args.read_only_input:
        output = args.output.absolute()
        if output.resolve() != output:
            raise ValueError(f'Refusing an aliased MinerU output directory: {output}')
        output.mkdir(parents=True)

        class ExclusiveDataWriter(DataWriter):
            def write(self, path, data):
                target = output / path
                if (not target.resolve().is_relative_to(output) or target.suffix.lower() == '.pdf'
                        or data.startswith(b'%PDF-')):
                    raise ValueError(f'Refusing an invalid MinerU output target: {target}')
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as stream:
                    stream.write(data)

        writer = ExclusiveDataWriter()
    else:
        writer = FileBasedDataWriter(str(args.output))
    result.save(writer)
    # save() externalizes assets on a copy; use that copy so image paths match
    # the saved files, while retaining original zero-based source page indexes.
    saved = ParseResult.from_json((args.output / 'middle_json.json').read_text(encoding='utf-8'))
    content = render_content_list(saved.middle_json)
    with (args.output / 'content_list.json').open('x', encoding='utf-8') as stream:
        json.dump(content, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


if __name__ == '__main__':
    main()
