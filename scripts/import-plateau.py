#!/usr/bin/env python3
"""Build Fluxity's bounded, flat-ground Shibuya scene from pinned PLATEAU CityGML.

python3 -m venv /tmp/fluxity-plateau-venv
/tmp/fluxity-plateau-venv/bin/pip install -r scripts/requirements-plateau.txt
/tmp/fluxity-plateau-venv/bin/python scripts/import-plateau.py --download \
    --layout data/shibuya/layout.json

Raw XML stays in /tmp. --download is explicit; subsequent builds work offline.
The source CityGML uses EPSG:6697 (latitude, longitude, orthometric height).
Only horizontal coordinates are projected: EPSG:6668 -> EPSG:6677 (JGD2011 IX).
The app's right-handed axes are east/up/south, in meters. Absolute ground heights
are normalized per building because the simulation intentionally uses one floor.
"""
from __future__ import annotations

import argparse
from array import array
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

import mapbox_earcut
import numpy as np
from pyproj import Transformer
from PIL import Image
from shapely import make_valid
from shapely.geometry import GeometryCollection, Point, Polygon, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
BASE = ('https://assets.cms.plateau.reearth.io/assets/fd/'
        '21cbf7-ee57-42bb-a445-ea9c46f8c1b3/13113_shibuya-ku_pref_2025_citygml_1_op')
SOURCES = [
    ("53393585", "bldg", 93256591), ("53393586", "bldg", 81500744),
    ("53393595", "bldg", 86969338), ("53393596", "bldg", 102300141),
    ("53393585", "tran", 10143334), ("53393586", "tran", 14463793),
    ("53393595", "tran", 13335102), ("53393596", "tran", 21792533),
]
# Hash the fetched XML, not the catalog's sometimes stale fileSize field.
SOURCE_SHA256 = {
    '53393585-bldg': 'b15701cede323e2e8aafb6c0ce651f2211b1c050a6f7354c73a50bf54572f7cb',
    '53393586-bldg': '7e3bc860ec6404e4c3b131fbcabf42e74f91b695809aa79c868306d9e7b1fc14',
    '53393595-bldg': 'f510af46f1548f584f257a85796e3e0afcf504490974163757f12b06b3aa4ec9',
    '53393596-bldg': '88dab9e2cc41dc75b37a83ca3ad78dfa0eb1f081b918af56fc79851c80150724',
    '53393585-tran': '8457ce05ff6aab157e36bb614582478ae8d0b0db320e0a95e6552d6ac7108921',
    '53393586-tran': '18b8b0c1afb307546073c6b0910bba171a5aea82e9cac06215e1a6be7bd3746b',
    '53393595-tran': 'a74cc75aa06a9a57dd2d9ecae644267779eb6ac1e2ca43dc53f04eb6b2fa86ee',
    '53393596-tran': 'ad04f9b05a29140988178b84987e9ff7aae0fac36279fc79640db9e45a6cc317',
}
NS = {
    'gml': 'http://www.opengis.net/gml',
    'core': 'http://www.opengis.net/citygml/2.0',
    'bldg': 'http://www.opengis.net/citygml/building/2.0',
    'tran': 'http://www.opengis.net/citygml/transportation/2.0',
    'xlink': 'http://www.w3.org/1999/xlink',
    'app': 'http://www.opengis.net/citygml/appearance/2.0',
}
GML_ID = '{' + NS['gml'] + '}id'
HREF = '{' + NS['xlink'] + '}href'
LAT, LON = 35.6595, 139.7005
PROJECT = Transformer.from_crs('EPSG:6668', 'EPSG:6677', always_xy=True)
ORIGIN_E, ORIGIN_N = PROJECT.transform(LON, LAT)
RENDER = box(-250, -250, 250, 250)
SIMULATION = box(-125, -125, 125, 125)
MIN_TRIANGLE_CROSS = 1e-6  # Twice the area in square meters, after float32 packing.


def polygons(geometry):
    """Yield polygons only (invalid source surfaces can repair to collections)."""
    if geometry.is_empty:
        return
    if geometry.geom_type == 'Polygon':
        yield geometry
    elif hasattr(geometry, 'geoms'):
        for part in geometry.geoms:
            yield from polygons(part)


def clean(geometry):
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    return unary_union([p for p in polygons(geometry) if p.area > 1e-5])


def union(items):
    return clean(unary_union(items)) if items else GeometryCollection()


def json_polygons(geometry):
    result = []
    for polygon in sorted(polygons(geometry), key=lambda p: (*p.bounds, p.area)):
        rings = [polygon.exterior, *polygon.interiors]
        result.append({'rings': [[{'x': round(x, 4), 'z': round(z, 4)}
                                  for x, z in list(r.coords)[:-1]] for r in rings]})
    return result


def from_json(items):
    return union([Polygon([(p['x'], p['z']) for p in item['rings'][0]],
                          [[(p['x'], p['z']) for p in ring]
                           for ring in item['rings'][1:]]) for item in items])


def project_ring_with_indices(ring):
    pos = ring.find('.//gml:posList', NS)
    if pos is None:
        values = [float(v) for p in ring.findall('.//gml:pos', NS)
                  for v in (p.text or '').split()]
    else:
        values = [float(v) for v in (pos.text or '').split()]
    if len(values) % 3:
        raise ValueError('Expected EPSG:6697 three-dimensional coordinates')
    points = np.asarray(values, dtype=np.float64).reshape((-1, 3))
    if len(points) < 3:
        return np.empty((0, 3)), np.empty(0, dtype=np.int64)
    east, north = PROJECT.transform(points[:, 1], points[:, 0])
    result = np.column_stack((east - ORIGIN_E, points[:, 2], ORIGIN_N - north))
    # Closed rings and consecutive duplicate vertices are redundant for earcut.
    kept = np.flatnonzero(np.r_[True, np.any(np.abs(np.diff(result, axis=0)) > 1e-8, axis=1)])
    result = result[kept]
    if len(result) > 1 and np.linalg.norm(result[0] - result[-1]) < 1e-8:
        result = result[:-1]
        kept = kept[:-1]
    return result, kept


def project_ring(ring):
    return project_ring_with_indices(ring)[0]


def ring_elements(element):
    exterior = element.find('gml:exterior/gml:LinearRing', NS)
    return ([exterior] + element.findall('gml:interior/gml:LinearRing', NS)
            if exterior is not None else [])


def polygon_rings(element):
    result = [project_ring(r) for r in ring_elements(element)]
    return [r for r in result if len(r) >= 3]


def read_appearances(path):
    """Read referenced images/UVs without loading source raster data or geometry."""
    result = {}
    for event, element in ET.iterparse(path, events=('start', 'end')):
        name = localname(element.tag)
        if event == 'start' and name == 'cityObjectMember':
            break  # These pinned files store global Appearance before buildings.
        if event == 'end' and name == 'ParameterizedTexture':
            uri = element.findtext('app:imageURI', namespaces=NS)
            if not uri or uri.startswith('/') or '..' in Path(uri).parts or '://' in uri:
                raise ValueError(f'Expected a safe relative imageURI, got {uri}')
            for target in element.findall('app:target', NS):
                identifier = target.get('uri', '').lstrip('#')
                rings = {}
                for coordinates in target.findall('.//app:textureCoordinates', NS):
                    values = np.asarray([float(v) for v in (coordinates.text or '').split()], dtype=np.float64)
                    if len(values) % 2 or not np.isfinite(values).all():
                        raise ValueError(f'Invalid UV coordinates for {identifier}')
                    rings[coordinates.get('ring', '').lstrip('#')] = values.reshape((-1, 2))
                if identifier in result and result[identifier]['imageURI'] != uri:
                    raise ValueError(f'Multiple image mappings for {identifier}')
                result[identifier] = {'imageURI': uri, 'rings': rings}
            element.clear()
    return result


def polygon_uvs(polygon, appearance):
    """Apply the geometry's exact retained indices to each exterior/interior UV ring."""
    result = []
    for element in ring_elements(polygon):
        points, kept = project_ring_with_indices(element)
        if len(points) < 3:
            continue
        ring_id = element.get(GML_ID)
        uv = appearance['rings'].get(ring_id)
        if uv is None or len(uv) <= int(kept.max()):
            raise ValueError(f'Missing/short texture coordinates for ring {ring_id}')
        uv = uv[kept].copy()
        if (uv < -1e-5).any() or (uv > 1 + 1e-5).any():
            raise ValueError(f'Texture UV outside source image for {ring_id}')
        uv = np.clip(uv, 0, 1)
        uv[:, 1] = 1 - uv[:, 1]  # CityGML bottom-left -> image/GPU top-left.
        result.append(uv)
    return result


def horizontal_polygon(rings):
    if not rings:
        return GeometryCollection()
    return clean(Polygon(rings[0][:, (0, 2)], [r[:, (0, 2)] for r in rings[1:]]))


def localname(tag):
    return tag.rsplit('}', 1)[-1]


def features(path):
    """Streaming XML: retain a single cityObjectMember, discard appearance data."""
    for _, element in ET.iterparse(path, events=('end',)):
        name = localname(element.tag)
        if name == 'appearanceMember':
            element.clear()
        elif name == 'cityObjectMember':
            yield element
            element.clear()


def selected_polygons(building, lod):
    indexed = {p.get(GML_ID): p for p in building.findall('.//gml:Polygon', NS)
               if p.get(GML_ID)}
    selected = {}
    for name in (f'lod{lod}Solid', f'lod{lod}MultiSurface', f'lod{lod}Geometry'):
        for geometry in building.findall('.//bldg:' + name, NS):
            for p in geometry.findall('.//gml:Polygon', NS):
                selected[p.get(GML_ID, str(id(p)))] = p
            for ref in geometry.iter():
                href = ref.get(HREF)
                if href and href.startswith('#'):
                    p = indexed.get(href[1:])
                    if p is None:
                        raise ValueError(f'Unresolved polygon reference {href}')
                    selected[href[1:]] = p
    # Semantic ownership supplies colors; geometry selection prevents LOD mixing.
    kinds = {}
    for name in ('GroundSurface', 'RoofSurface', 'WallSurface'):
        for surface in building.findall('.//bldg:' + name, NS):
            for polygon in surface.findall('.//gml:Polygon', NS):
                kinds[polygon.get(GML_ID)] = name
    return [(key, polygon_rings(polygon), kinds.get(key, 'WallSurface'), polygon)
            for key, polygon in selected.items()]


class Mesh:
    def __init__(self):
        self.vertices = array('f')
        self.indices = array('I')
        self.appearance = array('f')  # Separate 12-byte UV + image/page buffer.
        self.skipped_degenerate = 0
        self.reversed_buildings = 0
        self.maximum_planarity_error = 0.0

    def add(self, rings, color, material=0, normal_hint=None, appearance=None):
        if not rings or len(rings[0]) < 3:
            return
        outer = rings[0]
        normal = np.sum(np.cross(outer, np.roll(outer, -1, axis=0)), axis=0)
        length = np.linalg.norm(normal)
        if length < 1e-9:
            self.skipped_degenerate += 1
            return
        normal /= length
        if normal_hint is not None and np.dot(normal, normal_hint) < 0:
            normal = -normal
        points = np.vstack(rings)
        self.maximum_planarity_error = max(self.maximum_planarity_error,
                                           float(np.max(np.abs((points - outer[0]) @ normal))))
        # Project onto the dominant plane; this supports vertical/concave walls.
        axis = int(np.argmax(np.abs(normal)))
        flat = np.delete(points, axis, axis=1)
        ends = np.cumsum([len(r) for r in rings], dtype=np.uint32)
        indices = mapbox_earcut.triangulate_float64(flat, ends).reshape((-1, 3))
        if len(indices) == 0:
            raise ValueError('Non-degenerate polygon could not be triangulated')
        start = len(self.vertices) // 10
        for point in points:
            self.vertices.extend([*point, *normal, *color, float(material)])
        if appearance is None:
            self.appearance.extend([0., 0., -1.] * len(points))
        else:
            uv_rings, image_id = appearance
            if [len(r) for r in uv_rings] != [len(r) for r in rings]:
                raise ValueError('UV rings do not match retained geometry vertices')
            for u, v in np.vstack(uv_rings):
                self.appearance.extend([float(u), float(v), float(image_id)])
        packed_points = points.astype(np.float32).astype(np.float64)
        for a, b, c in indices:
            cross = np.cross(packed_points[b] - packed_points[a], packed_points[c] - packed_points[a])
            if np.linalg.norm(cross) <= MIN_TRIANGLE_CROSS:
                self.skipped_degenerate += 1
                continue
            if np.dot(cross, normal) < 0:
                b, c = c, b
            self.indices.extend([start + int(a), start + int(b), start + int(c)])

    def surface(self, geometry, height, color, material=0):
        for polygon in polygons(geometry):
            rings = [np.array([[x, height, z] for x, z in list(r.coords)[:-1]], dtype=np.float64)
                     for r in (polygon.exterior, *polygon.interiors)]
            self.add(rings, color, material, normal_hint=np.array([0., 1., 0.]))

    def orient_building(self, vertex_start, index_start):
        """Keep the original solid topology, correcting overall handedness once."""
        vertices = np.frombuffer(self.vertices, dtype=np.float32).reshape((-1, 10))
        indices = np.frombuffer(self.indices, dtype=np.uint32)[index_start:].reshape((-1, 3))
        if not len(indices):
            return
        triangles = vertices[indices, :3].astype(np.float64)
        volume = float(np.einsum('ij,ij->i', triangles[:, 0],
                                 np.cross(triangles[:, 1], triangles[:, 2])).sum() / 6)
        if volume < 0:
            indices[:, [1, 2]] = indices[:, [2, 1]]
            vertices[vertex_start:, 3:6] *= -1
            self.reversed_buildings += 1

    def validate(self):
        v = np.frombuffer(self.vertices, dtype=np.float32).reshape((-1, 10))
        ix = np.frombuffer(self.indices, dtype=np.uint32).reshape((-1, 3))
        assert len(v) and len(ix), 'Empty imported mesh'
        assert np.isfinite(v).all(), 'Nonfinite vertex data'
        assert int(ix.max()) < len(v), 'Index outside vertex buffer'
        assert np.allclose(np.linalg.norm(v[:, 3:6], axis=1), 1, atol=1e-5), 'Invalid normals'
        assert v[:, 1].min() >= -0.002, 'Building extends below normalized ground'
        triangles = v[ix, :3].astype(np.float64)
        crosses = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
        assert (np.linalg.norm(crosses, axis=1) > MIN_TRIANGLE_CROSS).all(), 'Degenerate float32 triangle'
        assert (np.einsum('ij,ij->i', crosses, v[ix[:, 0], 3:6]) > 0).all(), 'Backwards winding'
        return {'vertexCount': len(v), 'triangles': len(ix),
                'heightRangeMeters': [float(v[:, 1].min()), float(v[:, 1].max())],
                'skippedDegenerateTriangles': self.skipped_degenerate,
                'orientationCorrections': self.reversed_buildings,
                'maximumSourcePolygonPlanarityErrorMeters': round(self.maximum_planarity_error, 6)}


class TextureAtlas:
    SIZE = 2048
    PADDING = 8
    MAX_PAGES = 5

    def __init__(self, cache, download, previous_manifest):
        self.cache, self.download = cache, download
        self.requests, self.image_ids = [], {}
        self.expected = {r['imageURI']: r['sha256']
                         for r in previous_manifest.get('appearanceSources', [])}

    def register(self, appearance, distance):
        uri = appearance['imageURI']
        if uri in self.image_ids:
            image_id = self.image_ids[uri]
            self.requests[image_id]['distance'] = min(distance, self.requests[image_id]['distance'])
            return image_id
        image_id = len(self.requests)
        self.image_ids[uri] = image_id
        self.requests.append({'imageURI': uri, 'distance': float(distance), 'id': image_id})
        return image_id

    def fetch(self, request):
        uri = request['imageURI']
        path = self.cache / uri
        url = f'{BASE}/udx/bldg/{uri}'
        if not path.exists():
            if not self.download:
                raise ValueError(f'Missing texture {path}; use --download')
            path.parent.mkdir(parents=True, exist_ok=True)
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(url, timeout=40) as response:
                        data = response.read()
                    part = path.with_suffix('.part')
                    part.write_bytes(data)
                    part.replace(path)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(.5 * (attempt + 1))
        checksum = digest(path)
        if uri in self.expected and checksum != self.expected[uri]:
            raise ValueError(f'Texture source hash changed: {uri}; review upstream changes first')
        with Image.open(path) as image:
            width, height = image.size
            image.verify()
        return {**request, 'path': path, 'url': url, 'width': width, 'height': height,
                'bytes': path.stat().st_size, 'sha256': checksum}

    def pack(self, records, quality_step):
        rectangles = []
        for record in records:
            distance = record['distance']
            if distance <= 75:
                cap = max(256, int(768 * .98 ** quality_step))
            elif distance <= 150:
                cap = max(96, int(256 * .93 ** quality_step))
            else:
                cap = max(48, int(128 * .82 ** quality_step))
            scale = min(1., cap / max(record['width'], record['height']))
            width = max(1, int(round(record['width'] * scale)))
            height = max(1, int(round(record['height'] * scale)))
            rectangles.append({**record, 'packedWidth': width, 'packedHeight': height})
        rectangles.sort(key=lambda r: (-r['packedHeight'], -r['packedWidth'], r['imageURI']))
        pages = []
        placements = {}
        for rectangle in rectangles:
            width = rectangle['packedWidth'] + 2 * self.PADDING
            height = rectangle['packedHeight'] + 2 * self.PADDING
            placed = False
            for page_id, shelves in enumerate(pages):
                for shelf in shelves:
                    if height <= shelf['height'] and shelf['x'] + width <= self.SIZE:
                        placements[rectangle['id']] = {**rectangle, 'page': page_id,
                                                       'x': shelf['x'], 'y': shelf['y']}
                        shelf['x'] += width
                        placed = True
                        break
                if placed:
                    break
                y = sum(s['height'] for s in shelves)
                if y + height <= self.SIZE:
                    shelves.append({'x': width, 'y': y, 'height': height})
                    placements[rectangle['id']] = {**rectangle, 'page': page_id, 'x': 0, 'y': y}
                    placed = True
                    break
            if not placed:
                pages.append([{'x': width, 'y': 0, 'height': height}])
                placements[rectangle['id']] = {**rectangle, 'page': len(pages) - 1, 'x': 0, 'y': 0}
        return placements, len(pages)

    def paste(self, page, image, x, y):
        width, height = image.size
        pad = self.PADDING
        page.paste(image, (x + pad, y + pad))
        # Edge extrusion protects source edges during bilinear/mip sampling.
        page.paste(image.crop((0, 0, width, 1)).resize((width, pad)), (x + pad, y))
        page.paste(image.crop((0, height - 1, width, height)).resize((width, pad)), (x + pad, y + pad + height))
        page.paste(image.crop((0, 0, 1, height)).resize((pad, height)), (x, y + pad))
        page.paste(image.crop((width - 1, 0, width, height)).resize((pad, height)), (x + pad + width, y + pad))
        for cx, cy, px, py in [(0, 0, x, y), (width - 1, 0, x + pad + width, y),
                               (0, height - 1, x, y + pad + height),
                               (width - 1, height - 1, x + pad + width, y + pad + height)]:
            page.paste(Image.new('RGB', (pad, pad), image.getpixel((cx, cy))), (px, py))

    def create(self, mesh, output):
        if not self.requests:
            raise ValueError('No photo textures selected')
        print(f'Checking {len(self.requests)} source photographs', flush=True)
        with ThreadPoolExecutor(max_workers=8) as pool:
            records = list(pool.map(self.fetch, self.requests))
        for step in range(30):
            placements, page_count = self.pack(records, step)
            if page_count <= self.MAX_PAGES:
                break
        else:
            raise ValueError('Textures exceed the atlas GPU memory budget')
        print(f'Packing {len(records)} images into {page_count} x {self.SIZE}² pages (quality step {step})', flush=True)
        output.mkdir(parents=True, exist_ok=True)
        atlas_paths = []
        for page_id in range(page_count):
            page = Image.new('RGB', (self.SIZE, self.SIZE), (190, 194, 198))
            for placement in placements.values():
                if placement['page'] != page_id:
                    continue
                with Image.open(placement['path']) as original:
                    image = original.convert('RGB').resize((placement['packedWidth'], placement['packedHeight']),
                                                           Image.Resampling.LANCZOS)
                self.paste(page, image, placement['x'], placement['y'])
            path = output / f'atlas-{page_id}.jpg'
            page.save(path, 'JPEG', quality=90, subsampling=0, optimize=True)
            atlas_paths.append({'path': f'data/shibuya/{path.name}', 'sha256': digest(path)})
        coordinates = np.frombuffer(mesh.appearance, dtype=np.float32).reshape((-1, 3))
        textured = coordinates[:, 2] >= 0
        image_ids = coordinates[textured, 2].astype(np.int64)
        mapping = np.array([[placements[i]['x'] + self.PADDING, placements[i]['y'] + self.PADDING,
                             placements[i]['packedWidth'], placements[i]['packedHeight'], placements[i]['page']]
                            for i in range(len(records))], dtype=np.float64)[image_ids]
        coordinates[textured, 0] = (mapping[:, 0] + coordinates[textured, 0] * mapping[:, 2]) / self.SIZE
        coordinates[textured, 1] = (mapping[:, 1] + coordinates[textured, 1] * mapping[:, 3]) / self.SIZE
        coordinates[textured, 2] = mapping[:, 4]
        assert len(coordinates) == len(mesh.vertices) // 10
        assert np.isfinite(coordinates).all()
        assert ((coordinates[textured, :2] >= 0) & (coordinates[textured, :2] <= 1)).all()
        assert (coordinates[textured, 2] < page_count).all()
        path = output / 'appearance.bin'
        path.write_bytes(coordinates.astype('<f4', copy=False).tobytes())
        mip_pixels = sum(max(1, self.SIZE >> level) ** 2 for level in range(int(math.log2(self.SIZE)) + 1))
        summary = {'images': len(records), 'sourceBytes': sum(r['bytes'] for r in records),
                   'sourcePixels': sum(r['width'] * r['height'] for r in records),
                   'atlasPages': page_count, 'atlasWidth': self.SIZE, 'atlasHeight': self.SIZE,
                   'atlasBytes': sum((output / Path(a['path']).name).stat().st_size for a in atlas_paths),
                   'gpuTextureBytesWithMipmaps': mip_pixels * 4 * page_count,
                   'coordinateBytes': path.stat().st_size, 'texturedVertices': int(textured.sum()),
                   'paddingPixels': self.PADDING, 'qualityStep': step,
                   'packedPixels': sum(p['packedWidth'] * p['packedHeight'] for p in placements.values())}
        provenance = []
        for r in sorted(records, key=lambda r: r['imageURI']):
            p = placements[r['id']]
            provenance.append({k: r[k] for k in ('imageURI', 'url', 'width', 'height', 'bytes', 'sha256')})
            provenance[-1]['atlas'] = {'page': p['page'], 'x': p['x'] + self.PADDING,
                                      'y': p['y'] + self.PADDING, 'width': p['packedWidth'], 'height': p['packedHeight']}
        return ({'coordinates': 'data/shibuya/appearance.bin', 'coordinateSha256': digest(path),
                 'width': self.SIZE, 'height': self.SIZE, 'atlases': atlas_paths}, summary, provenance)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda: f.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def load_sources(cache, download):
    records = []
    for mesh, kind, size in SOURCES:
        path = cache / f'fluxity-{mesh}-{kind}.gml'
        url = f'{BASE}/udx/{kind}/{mesh}_{kind}_6697_op.gml'
        if not path.exists() or path.stat().st_size != size:
            if not download:
                raise SystemExit(f'Missing or incomplete {path}; run with --download')
            print(f'Downloading {kind} {mesh}', flush=True)
            part = path.with_suffix('.part')
            urllib.request.urlretrieve(url, part)
            if part.stat().st_size != size:
                raise ValueError(f'Unexpected download size for {url}')
            part.replace(path)
        records.append({'mesh': mesh, 'kind': kind, 'url': url, 'bytes': size,
                        'sha256': digest(path), 'path': path})
        if records[-1]['sha256'] != SOURCE_SHA256[f'{mesh}-{kind}']:
            raise ValueError(f'Source hash changed: {path}; review the upstream update before rebuilding')
    return records


def buildings(sources, mesh, textures=None):
    footprints, records, seen = [], [], set()
    for source in sources:
        if source['kind'] != 'bldg':
            continue
        print(f"Reading buildings {source['mesh']}", flush=True)
        appearances = read_appearances(source['path']) if textures is not None else {}
        for member in features(source['path']):
            building = member.find('bldg:Building', NS)
            if building is None:
                continue
            identifier = building.get(GML_ID)
            if identifier in seen:
                continue
            seen.add(identifier)
            selected = selected_polygons(building, 2)
            lod = 2
            if not selected:
                selected, lod = selected_polygons(building, 1), 1
            if not selected:
                continue
            ground_rings = [rings for _, rings, kind, _ in selected if kind == 'GroundSurface']
            footprint = union([horizontal_polygon(rings) for rings in ground_rings])
            if footprint.is_empty:
                for name in ('lod0FootPrint', 'lod0RoofEdge'):
                    footprint = union([horizontal_polygon(polygon_rings(p))
                                       for p in building.findall(f'.//bldg:{name}//gml:Polygon', NS)])
                    if not footprint.is_empty:
                        break
            if footprint.is_empty:
                footprint = union([horizontal_polygon(rings) for _, rings, _, _ in selected])
            if footprint.is_empty or not footprint.intersects(RENDER):
                continue
            all_points = np.vstack([r for _, rings, _, _ in selected for r in rings])
            # Include installations if their base is lower than GroundSurface. This
            # prevents tiny negative geometry while keeping one vertical translation.
            base_height = float(all_points[:, 1].min())
            vertex_start, index_start = len(mesh.vertices) // 10, len(mesh.indices)
            tint = int(hashlib.sha256(identifier.encode()).hexdigest()[:2], 16) / 255
            distance = footprint.distance(Point(0, 0))
            textured_polygons = 0
            for polygon_id, rings, kind, element in selected:
                normalized = [r - np.array([0., base_height, 0.]) for r in rings]
                color = ([0.39, 0.43, 0.46] if kind == 'RoofSurface' else
                         [0.50 + tint * .13, 0.52 + tint * .10, 0.54 + tint * .07])
                appearance = appearances.get(polygon_id)
                vertex_appearance = None
                if appearance is not None:
                    uv_rings = polygon_uvs(element, appearance)
                    image_id = textures.register(appearance, distance)
                    vertex_appearance = (uv_rings, image_id)
                    textured_polygons += 1
                mesh.add(normalized, color, appearance=vertex_appearance)
            mesh.orient_building(vertex_start, index_start)
            footprints.append(footprint)
            years = sorted({e.text for e in building.iter() if localname(e.tag) == 'surveyYear'})
            records.append({'id': identifier, 'lod': lod,
                            'baseHeightMeters': round(base_height, 4),
                            'creationDate': building.findtext('core:creationDate', namespaces=NS),
                            'surveyYearAttributes': years,
                            'selectedPolygons': len(selected), 'texturedPolygons': textured_polygons})
    return union(footprints), records


def roads(sources):
    surfaces = {'road': [], 'sidewalk': [], 'island': []}
    counts, seen = Counter(), set()
    for source in sources:
        if source['kind'] != 'tran':
            continue
        print(f"Reading roads {source['mesh']}", flush=True)
        for member in features(source['path']):
            road = member.find('tran:Road', NS)
            if road is None:
                continue
            areas = road.findall('.//tran:TrafficArea', NS) + road.findall('.//tran:AuxiliaryTrafficArea', NS)
            has_lod2 = False
            for area in areas:
                function = area.findtext('tran:function', namespaces=NS)
                category = {'1000': 'road', '1020': 'road', '2000': 'sidewalk', '3000': 'island'}.get(function)
                candidates = area.findall('.//tran:lod2MultiSurface//gml:Polygon', NS)
                has_lod2 |= bool(candidates)
                if category is None:
                    continue
                for p in candidates:
                    identifier = p.get(GML_ID)
                    if identifier in seen:
                        continue
                    seen.add(identifier)
                    shape = horizontal_polygon(polygon_rings(p))
                    if shape.intersects(RENDER):
                        surfaces[category].append(clean(shape.intersection(RENDER)))
                        counts[function] += 1
            if not has_lod2:
                for p in road.findall('.//tran:lod1MultiSurface//gml:Polygon', NS):
                    identifier = p.get(GML_ID)
                    if identifier in seen:
                        continue
                    seen.add(identifier)
                    shape = horizontal_polygon(polygon_rings(p))
                    if shape.intersects(RENDER):
                        surfaces['road'].append(clean(shape.intersection(RENDER)))
                        counts['lod1Fallback'] += 1
    return {key: union(value) for key, value in surfaces.items()}, dict(counts)


def crossing_polygon(crossing):
    a, b = crossing['from'], crossing['to']
    dx, dz = b['x'] - a['x'], b['z'] - a['z']
    length = math.hypot(dx, dz)
    if length <= 0 or crossing['width'] <= 0:
        raise ValueError('Invalid crossing dimensions')
    nx, nz = -dz / length * crossing['width'] / 2, dx / length * crossing['width'] / 2
    return Polygon([(a['x'] + nx, a['z'] + nz), (b['x'] + nx, b['z'] + nz),
                    (b['x'] - nx, b['z'] - nz), (a['x'] - nx, a['z'] - nz)])


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=Path('/tmp/fluxity-plateau-source'))
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--texture-cache', type=Path, default=Path('/tmp/fluxity-plateau-textures'))
    parser.add_argument('--layout', type=Path, default=ROOT / 'data/shibuya/layout.json')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'public/data/shibuya')
    parser.add_argument('--map-output', type=Path, default=ROOT / 'src/scenarios/data/shibuya-map.json')
    parser.add_argument('--polygons-only', action='store_true', help='Export calibration polygons; still validates building geometry')
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    sources = load_sources(args.cache_dir, args.download)
    layout = json.loads(args.layout.read_text()) if args.layout.exists() else {}
    previous_path = args.output_dir / 'manifest.json'
    if not previous_path.exists():
        # A clean output directory still verifies against the repository's
        # checked-in source-photo hashes, instead of silently losing the lock.
        previous_path = ROOT / 'public/data/shibuya/manifest.json'
    previous_manifest = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    textures = None if args.polygons_only else TextureAtlas(args.texture_cache, args.download, previous_manifest)
    mesh = Mesh()
    footprints, building_records = buildings(sources, mesh, textures)
    raw, road_counts = roads(sources)
    corrections = from_json(layout.get('pedestrianAreas', []))
    blocked = clean(from_json(layout.get('blockedAreas', [])).difference(footprints).intersection(RENDER))
    exclusion = union([footprints, raw['island'], blocked])
    sidewalks = clean(union([raw['sidewalk'], corrections]).difference(exclusion).intersection(RENDER))
    islands = clean(raw['island'].difference(union([footprints, blocked])))
    road = clean(raw['road'].difference(union([sidewalks, footprints, blocked, islands])))
    crossings = union([crossing_polygon(c) for c in layout.get('crosswalks', [])])
    walkable = clean(union([sidewalks, crossings]).difference(exclusion).intersection(SIMULATION))
    navigation_sidewalks = clean(sidewalks.intersection(SIMULATION))
    calibration = {'origin': {'latitude': LAT, 'longitude': LON},
                   'sidewalks': json_polygons(sidewalks), 'roads': json_polygons(road),
                   'islands': json_polygons(raw['island']), 'buildingFootprints': json_polygons(footprints),
                   'crosswalks': layout.get('crosswalks', [])}
    write_json(Path('/tmp/fluxity-shibuya-polygons.json'), calibration)
    # Ground materials tile the plane without overlapping it. Millimeter offsets
    # on a full-size ground quad cause depth fighting in an overview camera.
    background = clean(RENDER.difference(union([road, sidewalks, islands, blocked, footprints])))
    mesh.surface(background, 0, [0.29, 0.33, 0.35])
    mesh.surface(sidewalks, 0, [0.61, 0.64, 0.64], 4)
    mesh.surface(islands, 0, [0.38, 0.43, 0.40])
    mesh.surface(blocked, .018, [0.27, 0.39, 0.29])
    stripe_shapes = []
    for crossing in layout.get('crosswalks', []):
        a, b = crossing['from'], crossing['to']
        dx, dz = b['x'] - a['x'], b['z'] - a['z']
        length = math.hypot(dx, dz)
        for distance in np.arange(0, length, 1.15):
            end = min(float(distance) + .52, length)
            stripe = {'from': {'x': a['x'] + dx * distance / length, 'z': a['z'] + dz * distance / length},
                      'to': {'x': a['x'] + dx * end / length, 'z': a['z'] + dz * end / length},
                      'width': crossing['width']}
            stripe_shapes.append(crossing_polygon(stripe))
    paint = clean(union(stripe_shapes).intersection(road))
    # Painted stripes also tile the road plane. A tiny overlay height loses
    # depth precision in Overview and causes holes even when asphalt is clean.
    asphalt = clean(road.difference(paint))
    assert asphalt.intersection(paint).area < 1e-6, 'Paint overlaps asphalt'
    mesh.surface(asphalt, 0, [0.16, 0.19, 0.22])
    mesh.surface(paint, 0, [.90, .91, .88], 2)
    validation = mesh.validate()
    lod_counts = Counter(b['lod'] for b in building_records)
    statistics = {'buildings': len(building_records), 'lod2Buildings': lod_counts[2],
                  'lod1Buildings': lod_counts[1], 'triangles': validation['triangles']}
    data = {'schemaVersion': 1,
            'origin': {'latitude': LAT, 'longitude': LON, 'crs': 'EPSG:6697'},
            'renderBounds': {'minX': -250, 'maxX': 250, 'minZ': -250, 'maxZ': 250},
            'sidewalks': json_polygons(navigation_sidewalks), 'walkable': json_polygons(walkable),
            'roads': json_polygons(road), 'buildingFootprints': json_polygons(footprints),
            'mesh': {'vertices': 'data/shibuya/vertices.bin', 'indices': 'data/shibuya/indices.bin',
                     'vertexCount': len(mesh.vertices) // 10, 'indexCount': len(mesh.indices)},
            'statistics': statistics}
    assert walkable.difference(SIMULATION).area < 1e-6
    assert walkable.intersection(footprints).area < 1e-6
    assert walkable.is_valid and sidewalks.is_valid and road.is_valid
    if not args.polygons_only:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        if sys.byteorder != 'little':
            mesh.vertices.byteswap()
            mesh.indices.byteswap()
        vertices_path, indices_path = args.output_dir / 'vertices.bin', args.output_dir / 'indices.bin'
        vertices_path.write_bytes(mesh.vertices.tobytes())
        indices_path.write_bytes(mesh.indices.tobytes())
        vertex_hash, index_hash = digest(vertices_path), digest(indices_path)
        # The compiled navigation geometry and fetched mesh must belong to the
        # same import even when a browser cache straddles a static deployment.
        data['mesh']['vertexSha256'] = vertex_hash
        data['mesh']['indexSha256'] = index_hash
        appearance, appearance_summary, appearance_sources = textures.create(mesh, args.output_dir)
        appearance_summary['texturedBuildings'] = sum(b['texturedPolygons'] > 0 for b in building_records)
        appearance_summary['selectedBuildings'] = len(building_records)
        appearance_summary['texturedPolygons'] = sum(b['texturedPolygons'] for b in building_records)
        appearance_summary['selectedPolygons'] = sum(b['selectedPolygons'] for b in building_records)
        data['appearance'] = appearance
        write_json(args.map_output, data)
        manifest = {
            'schemaVersion': 1, 'dataset': '3D都市モデル（Project PLATEAU）渋谷区（2025年度）',
            'datasetUrl': 'https://www.geospatial.jp/ckan/dataset/plateau-13113-shibuya-ku-2025',
            'standardProductSpecification': '5.0', 'license': 'CC-BY-4.0',
            'licenseUrl': 'https://www.mlit.go.jp/plateau/site-policy/',
            'attribution': '3D都市モデル（Project PLATEAU）渋谷区（2025年度）を加工して作成',
            'processing': ['500m square crop; intersecting buildings retained whole',
                           'LOD2 geometry preferred, LOD1 fallback explicitly counted',
                           'Per-building minimum geometry height subtracted; roads flattened',
                           'Source photo UVs retained, V flipped to top-left image coordinates',
                           'Distance-prioritized photo resizing and padded 2048px JPEG atlases',
                           'Semantic road polygons unioned; untextured surfaces retain material colors',
                           'Pedestrian calibration and crossing overlays from layout.json'],
            'limitations': ['Single ground floor; not a surveyed present-day reconstruction',
                            'Edition year is not geometry acquisition year',
                            'Source sidewalk polygons include planting; curated blockedAreas may refine them',
                            'Signals, pedestrian demand and speeds are demo settings'],
            'coordinateTransform': {'source': 'EPSG:6697 latitude,longitude,orthometricHeight',
                                    'horizontal': 'EPSG:6668 -> EPSG:6677, always_xy=True',
                                    'originLatitude': LAT, 'originLongitude': LON,
                                    'originEasting': ORIGIN_E, 'originNorthing': ORIGIN_N,
                                    'axes': 'x=easting-originEasting; z=originNorthing-northing; y=height-buildingMinimumHeight',
                                    'units': 'meters'},
            'layout': {'file': str(args.layout.relative_to(ROOT)) if args.layout.is_relative_to(ROOT) else args.layout.name,
                       'sha256': digest(args.layout) if args.layout.exists() else None,
                       'referenceSources': layout.get('calibrationSources', layout.get('referenceSources', []))},
            'sources': [{k: v for k, v in source.items() if k != 'path'} for source in sources],
            'mesh': {'vertexStrideBytes': 40, 'vertexLayout': 'float32 position3,normal3,color3,material1',
                     'indexFormat': 'uint32', 'byteOrder': 'little',
                     'vertices': {'bytes': vertices_path.stat().st_size, 'sha256': vertex_hash},
                     'indices': {'bytes': indices_path.stat().st_size, 'sha256': index_hash}},
            'statistics': statistics, 'validation': validation, 'roadFunctionCounts': road_counts,
            'buildingSourceMetadata': building_records,
            'appearance': appearance, 'appearanceSummary': appearance_summary,
            'appearanceSources': appearance_sources,
        }
        write_json(args.output_dir / 'manifest.json', manifest)
        print(json.dumps({'appearance': appearance_summary}, indent=2))
    print(json.dumps({'statistics': statistics, 'validation': validation,
                      'roadFunctionCounts': road_counts, 'sidewalkArea': navigation_sidewalks.area,
                      'walkableArea': walkable.area, 'calibration': '/tmp/fluxity-shibuya-polygons.json'}, indent=2))


if __name__ == '__main__':
    main()
