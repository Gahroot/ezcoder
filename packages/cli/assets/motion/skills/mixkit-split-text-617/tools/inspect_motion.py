"""Read the bundled animation evidence without loading it all into an agent's context.
Python standard library only. No writes, network, dependency loading, or rendering.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def load_manifest(root: Path) -> dict:
    path = root / 'data' / 'manifest.json'
    if path.stat().st_size > 65536:
        raise ValueError('Manifest exceeds 64 KiB')
    data = json.loads(path.read_text(encoding='utf-8'))
    if data.get('schema_version') != 1 or not isinstance(data.get('compositions'), list):
        raise ValueError('Unsupported manifest')
    return data


def load_comp(root: Path, manifest: dict, comp_id: int) -> dict:
    entry = next((c for c in manifest['compositions'] if c['id'] == comp_id), None)
    if entry is None:
        raise ValueError(f'Unknown composition ID: {comp_id}')
    path = (root / 'data' / 'compositions' / f'comp-{comp_id}.json').resolve()
    if not path.is_relative_to(root) or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('Composition path or size is not allowed')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != entry['sha256']:
        raise ValueError(f'Composition {comp_id} failed its integrity check')
    comp = json.loads(raw)
    if comp['id'] != comp_id or len(comp['layers']) != entry['layer_count']:
        raise ValueError('Composition identity/count mismatch')
    return comp


def walk(nodes: list, ancestors: tuple = (), depth: int = 0):
    if depth > 32:
        raise ValueError('Property nesting exceeds the inspection limit')
    for ordinal, node in enumerate(nodes):
        path = ancestors + (f"{ordinal}:{node['match_name']} ({node['name']})",)
        yield path, node
        yield from walk(node.get('children', []), path, depth + 1)


def layer_summary(layer: dict) -> dict:
    return {k: v for k, v in layer.items() if k != 'properties'}


def verify(root: Path, manifest: dict) -> dict:
    comps = [load_comp(root, manifest, c['id']) for c in manifest['compositions']]
    ids = {c['id'] for c in comps}
    if len(ids) != len(comps):
        raise ValueError('Duplicate composition IDs')
    totals = {'compositions': len(comps), 'layers': 0, 'stored_properties': 0, 'synthetic_properties': 0}
    for comp in comps:
        layer_ids = {l['id'] for l in comp['layers']}
        if len(layer_ids) != len(comp['layers']):
            raise ValueError('Duplicate layer IDs')
        totals['layers'] += len(comp['layers'])
        for layer in comp['layers']:
            source = layer.get('source')
            if source and source['type'] == 'CompItem' and source['id'] not in ids:
                raise ValueError('Missing source composition')
            for link in ('parent', 'track_matte_layer'):
                ref = layer.get(link)
                if ref and ref['id'] not in layer_ids:
                    raise ValueError(f'Missing linked layer: {link}')
            for _, prop in walk(layer['properties']):
                if 'binary_chunk_synthetic' in prop:
                    key = 'synthetic_properties' if prop['binary_chunk_synthetic'] else 'stored_properties'
                    totals[key] += 1
    for key, actual in totals.items():
        if actual != manifest['expected_counts'][key]:
            raise ValueError(f'Evidence count mismatch: {key}')
    return {'integrity': 'PASS', 'counts': totals, 'full_video_reconstruction_verified': False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list', help='List compositions, dynamic slots and evidence scope')
    sub.add_parser('verify', help='Check data integrity and links; does not render or validate motion')
    for name in ('layers', 'keys'):
        p = sub.add_parser(name)
        p.add_argument('composition', type=int)
    prop_parser = sub.add_parser('property')
    prop_parser.add_argument('composition', type=int)
    prop_parser.add_argument('layer', type=int)
    prop_parser.add_argument('match_name')
    prop_parser.add_argument('--include-defaults', action='store_true', help='Also show explicitly labelled parser-synthesized defaults')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    try:
        manifest = load_manifest(root)
        if args.command == 'list':
            result = manifest
        elif args.command == 'verify':
            result = verify(root, manifest)
        else:
            comp = load_comp(root, manifest, args.composition)
            if args.command == 'layers':
                result = {k: v for k, v in comp.items() if k != 'layers'}
                result['layers'] = [layer_summary(l) for l in comp['layers']]
            else:
                matches = []
                if args.command == 'property' and not any(l['id'] == args.layer for l in comp['layers']):
                    raise ValueError(f'Unknown layer ID: {args.layer}')
                for layer in comp['layers']:
                    if args.command == 'property' and layer['id'] != args.layer:
                        continue
                    for path, prop in walk(layer['properties']):
                        if args.command == 'property':
                            selected = prop['match_name'] == args.match_name and (args.include_defaults or not prop.get('binary_chunk_synthetic', False))
                        else:
                            selected = bool(prop.get('keyframes')) and prop['match_name'] != 'ADBE Marker'
                        if selected:
                            matches.append({'layer_id': layer['id'], 'layer_name': layer['name'], 'indexed_path': list(path), 'property': prop})
                if args.command == 'property' and not matches:
                    raise ValueError('No stored property matched that exact name; use --include-defaults to inspect labelled parser defaults')
                result = matches
        print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f'Inspection failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
