"""Geospatial conversion invariants; no downloads or full source dataset required."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
from shapely.geometry import Polygon

spec = importlib.util.spec_from_file_location('plateau', Path(__file__).with_name('import-plateau.py'))
plateau = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plateau)


def triangle_area(mesh):
    vertices = np.asarray(mesh.vertices).reshape((-1, 10))[:, :3]
    triangles = vertices[np.asarray(mesh.indices).reshape((-1, 3))]
    return np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0],
                                   triangles[:, 2] - triangles[:, 0]), axis=1).sum() / 2


class ConversionTests(unittest.TestCase):
    def test_shibuya_crossing_maneuvers_reproduce_committed_polygons(self):
        root = Path(__file__).resolve().parent.parent
        layout = json.loads((root / 'data/shibuya/layout.json').read_text())
        data = json.loads((root / 'src/scenarios/data/shibuya-map.json').read_text())
        actual = plateau.crossing_maneuvers(layout['crosswalks'], data)
        self.assertEqual(actual, data['crossingManeuvers'])

    def test_crossing_margin_stops_at_missing_carriageway(self):
        mark = {'from': {'x': 0, 'z': 0}, 'to': {'x': 10, 'z': 0}, 'width': 2}
        paint = plateau.crossing_polygon(mark)
        road = plateau.box(0, -3, 10, 3).difference(plateau.box(2, 1, 4, 2))
        data = {'walkable': plateau.json_polygons(paint), 'roads': plateau.json_polygons(road)}
        surface = plateau.from_json(plateau.crossing_maneuvers([mark], data))
        self.assertTrue(surface.covers(plateau.Point(5, 1.75)))
        self.assertFalse(surface.covers(plateau.Point(5, 1.81)))
        self.assertFalse(surface.covers(plateau.Point(3, 1.2)))

    def test_latitude_longitude_height_axes_and_meter_scale(self):
        ring = ET.fromstring(f'''<gml:LinearRing xmlns:gml="{plateau.NS['gml']}">
          <gml:posList>35.6595 139.7005 15 35.6595 139.7006 15
          35.6596 139.7005 16 35.6595 139.7005 15</gml:posList></gml:LinearRing>''')
        points = plateau.project_ring(ring)
        np.testing.assert_allclose(points[0], [0, 15, 0], atol=1e-7)
        self.assertAlmostEqual(points[1, 0], 9.05, delta=.05)  # East is +x.
        self.assertAlmostEqual(points[2, 2], -11.10, delta=.05)  # North is -z.
        self.assertEqual(points[2, 1], 16)  # Orthometric height is not projected.
        self.assertEqual(len(points), 3)  # Closed ring endpoint is not duplicated.

    def test_shibuya_hikarie_retains_source_dimensions_in_shipped_mesh(self):
        # Real LOD2 vertices from tile 53393596, building bldg_9ad5b600-360f-4627-8a89-fca39aad5576.
        # West and east ground points, then a highest roof vertex. Elevations are relative to sea level.
        ring = ET.fromstring(f'''<gml:LinearRing xmlns:gml="{plateau.NS['gml']}"><gml:posList>
          35.65908975340395 139.70293654153244 17.11
          35.65940914166302 139.70438874851553 17.11
          35.65910463387202 139.70321041490345 202.0
        </gml:posList></gml:LinearRing>''')
        expected = plateau.project_ring(ring)
        expected[:, 1] -= 17.11
        root = Path(__file__).resolve().parents[1]
        directory = root / 'public/data/shibuya'
        vertices = np.fromfile(directory / 'vertices.bin', dtype='<f4').reshape(-1, 10)
        indices = np.fromfile(directory / 'indices.bin', dtype='<u4')
        mesh = vertices[np.unique(indices), :3]
        actual = np.array([mesh[np.argmin(np.linalg.norm(mesh - point, axis=1))] for point in expected])
        np.testing.assert_allclose(actual, expected, rtol=0, atol=0.00005)
        # Horizontal distance in plane rectangular zone IX and vertical relief, both in meters.
        self.assertAlmostEqual(np.linalg.norm(actual[1] - actual[0]), 136.175, places=3)
        self.assertAlmostEqual(actual[2, 1] - actual[0, 1], 184.89, places=3)

    def test_concave_ground_polygon_preserves_hole_and_area(self):
        shape = Polygon([(0, 0), (6, 0), (6, 2), (3, 2), (3, 6), (0, 6)],
                        [[(.5, .5), (.5, 1.5), (1.5, 1.5), (1.5, .5)]])
        mesh = plateau.Mesh()
        mesh.surface(shape, 0, [.4, .5, .6])
        mesh.validate()
        self.assertAlmostEqual(triangle_area(mesh), 23, places=5)
        vertices = np.asarray(mesh.vertices).reshape((-1, 10))
        np.testing.assert_allclose(vertices[:, 4], 1)  # Ground faces upward.

    def test_vertical_wall_with_window_hole(self):
        mesh = plateau.Mesh()
        outer = np.array([[0, 0, 2], [6, 0, 2], [6, 6, 2], [0, 6, 2]], dtype=float)
        hole = np.array([[2, 2, 2], [2, 4, 2], [4, 4, 2], [4, 2, 2]], dtype=float)
        mesh.add([outer, hole], [.4, .5, .6])
        mesh.validate()
        self.assertAlmostEqual(triangle_area(mesh), 32, places=5)

    def test_lod2_xlinks_deduplicate_and_exclude_lod1(self):
        building = ET.fromstring(f'''<bldg:Building xmlns:bldg="{plateau.NS['bldg']}"
          xmlns:gml="{plateau.NS['gml']}" xmlns:xlink="{plateau.NS['xlink']}">
          <bldg:lod1Solid><gml:Polygon gml:id="lod1"/></bldg:lod1Solid>
          <bldg:lod2Solid><gml:Solid><gml:exterior><gml:CompositeSurface>
            <gml:surfaceMember xlink:href="#roof"/>
          </gml:CompositeSurface></gml:exterior></gml:Solid></bldg:lod2Solid>
          <bldg:boundedBy><bldg:RoofSurface><bldg:lod2MultiSurface>
            <gml:Polygon gml:id="roof"><gml:exterior><gml:LinearRing>
              <gml:posList>35.6595 139.7005 20 35.6595 139.7006 20
              35.6596 139.7005 20 35.6595 139.7005 20</gml:posList>
            </gml:LinearRing></gml:exterior></gml:Polygon>
          </bldg:lod2MultiSurface></bldg:RoofSurface></bldg:boundedBy>
        </bldg:Building>''')
        selected = plateau.selected_polygons(building, 2)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0][0], 'roof')
        self.assertEqual(selected[0][2], 'RoofSurface')
        self.assertEqual(len(selected[0][1][0]), 3)

    def test_reversed_solid_gets_outward_normals_and_winding(self):
        faces = [
            [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
            [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
            [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
            [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
            [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
            [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
        ]
        mesh = plateau.Mesh()
        for face in faces:
            mesh.add([np.array(face[::-1], dtype=float)], [.4, .5, .6])
        mesh.orient_building(0, 0)
        mesh.validate()
        self.assertEqual(mesh.reversed_buildings, 1)
        vertices = np.asarray(mesh.vertices).reshape((-1, 10))
        self.assertTrue((np.einsum('ij,ij->i', vertices[:, :3] - .5, vertices[:, 3:6]) > 0).all())

    def test_navigation_polygon_roundtrip_keeps_obstacle_holes(self):
        sidewalk = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        building = Polygon([(4, 4), (6, 4), (6, 6), (4, 6)])
        walkable = plateau.clean(sidewalk.difference(building))
        restored = plateau.from_json(plateau.json_polygons(walkable))
        self.assertAlmostEqual(restored.area, 96)
        self.assertEqual(restored.intersection(building).area, 0)
        self.assertEqual(len(restored.interiors), 1)

    def test_uvs_follow_closed_ring_and_duplicate_vertex_cleanup(self):
        polygon = ET.fromstring(f'''<gml:Polygon xmlns:gml="{plateau.NS['gml']}">
          <gml:exterior><gml:LinearRing gml:id="outer"><gml:posList>
            35.6595 139.7005 15 35.6595 139.7006 15 35.6595 139.7006 15
            35.6596 139.7005 15 35.6595 139.7005 15
          </gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>''')
        ring = plateau.ring_elements(polygon)[0]
        points, kept = plateau.project_ring_with_indices(ring)
        np.testing.assert_array_equal(kept, [0, 1, 3])
        self.assertEqual(len(points), 3)
        appearance = {'rings': {'outer': np.array([
            [.125, .25], [.875, .25], [.875, .25], [.125, .75], [.125, .25],
        ])}}
        uvs = plateau.polygon_uvs(polygon, appearance)
        # V flips exactly once; removing position indices 2 and 4 removes their UVs.
        np.testing.assert_array_equal(uvs[0], [[.125, .75], [.875, .75], [.125, .25]])

    def test_texture_ring_ids_keep_hole_uvs_in_vertex_order(self):
        polygon = ET.fromstring(f'''<gml:Polygon xmlns:gml="{plateau.NS['gml']}">
          <gml:exterior><gml:LinearRing gml:id="outside"><gml:posList>
            35.6595 139.7005 5 35.6595 139.7009 5 35.6599 139.7009 5
            35.6599 139.7005 5 35.6595 139.7005 5
          </gml:posList></gml:LinearRing></gml:exterior>
          <gml:interior><gml:LinearRing gml:id="window"><gml:posList>
            35.6596 139.7006 5 35.6598 139.7006 5 35.6598 139.7008 5
            35.6596 139.7008 5 35.6596 139.7006 5
          </gml:posList></gml:LinearRing></gml:interior></gml:Polygon>''')
        # Deliberately put the hole first: references, not dictionary order, bind UVs.
        appearance = {'rings': {
            'window': np.array([[.25, .25], [.25, .75], [.75, .75], [.75, .25], [.25, .25]]),
            'outside': np.array([[0., 0.], [1., 0.], [1., 1.], [0., 1.], [0., 0.]]),
        }}
        rings = plateau.polygon_rings(polygon)
        uvs = plateau.polygon_uvs(polygon, appearance)
        mesh = plateau.Mesh()
        mesh.add(rings, [.4, .5, .6], appearance=(uvs, 7))
        mesh.validate()
        actual = np.asarray(mesh.appearance).reshape((-1, 3))
        np.testing.assert_array_equal(actual[:, :2], [
            [0., 1.], [1., 1.], [1., 0.], [0., 0.],
            [.25, .75], [.25, .25], [.75, .25], [.75, .75],
        ])
        np.testing.assert_array_equal(actual[:, 2], np.full(8, 7))
        self.assertEqual(len(mesh.vertices) // 10, len(actual))

    def test_triangle_winding_change_preserves_position_uv_pairs(self):
        points = np.array([[0., 0., 0.], [0., 0., 2.], [2., 0., 0.]])
        uvs = np.array([[.125, .25], [.875, .25], [.125, .75]])
        mesh = plateau.Mesh()
        # This forces the source +y face to be rendered with a -y normal/winding.
        mesh.add([points], [.4, .5, .6], normal_hint=np.array([0., -1., 0.]),
                 appearance=([uvs], 3))
        mesh.validate()
        actual_uvs = np.asarray(mesh.appearance).reshape((-1, 3))
        actual_positions = np.asarray(mesh.vertices).reshape((-1, 10))[:, :3]
        np.testing.assert_array_equal(actual_positions, points)
        np.testing.assert_array_equal(actual_uvs[:, :2], uvs)
        for index in mesh.indices:
            np.testing.assert_array_equal(actual_uvs[index, :2], uvs[index])

    def test_solid_orientation_fix_keeps_vertex_uvs_and_image_ids(self):
        faces = [
            [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
            [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
            [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
            [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
            [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
            [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
        ]
        mesh = plateau.Mesh()
        for image_id, face in enumerate(faces):
            points = np.array(face[::-1], dtype=float)
            uv = points[:, (0, 2)] * .5 + points[:, (1, 1)] * .25
            mesh.add([points], [.4, .5, .6], appearance=([uv], image_id))
        before = mesh.appearance.tobytes()
        before_positions = np.asarray(mesh.vertices).reshape((-1, 10))[:, :3].copy()
        mesh.orient_building(0, 0)
        mesh.validate()
        self.assertEqual(mesh.reversed_buildings, 1)
        self.assertEqual(mesh.appearance.tobytes(), before)
        np.testing.assert_array_equal(np.asarray(mesh.vertices).reshape((-1, 10))[:, :3], before_positions)

    def test_untextured_surfaces_use_negative_page_sentinel(self):
        mesh = plateau.Mesh()
        mesh.surface(Polygon([(0, 0), (4, 0), (4, 4), (0, 4)]), 0, [.4, .5, .6], 4)
        mesh.validate()
        appearance = np.asarray(mesh.appearance).reshape((-1, 3))
        np.testing.assert_array_equal(appearance, np.tile([0., 0., -1.], (4, 1)))

    def test_missing_uv_ring_is_rejected_instead_of_using_another_ring(self):
        polygon = ET.fromstring(f'''<gml:Polygon xmlns:gml="{plateau.NS['gml']}">
          <gml:exterior><gml:LinearRing gml:id="expected"><gml:posList>
            35.6595 139.7005 15 35.6595 139.7006 15
            35.6596 139.7005 15 35.6595 139.7005 15
          </gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>''')
        with self.assertRaisesRegex(ValueError, 'expected'):
            plateau.polygon_uvs(polygon, {'rings': {'unrelated': np.array([[0., 0.]] * 4)}})

    def test_cached_photo_hash_must_match_recorded_source_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            uri = 'test_mesh/facade.jpg'
            image_path = cache / uri
            image_path.parent.mkdir()
            Image.new('RGB', (4, 3), (120, 150, 180)).save(image_path, 'JPEG')
            image_bytes = image_path.read_bytes()
            checksum = hashlib.sha256(image_bytes).hexdigest()
            request = {'imageURI': uri, 'id': 0, 'distance': 12.5}
            previous = {'appearanceSources': [{'imageURI': uri, 'sha256': '0' * 64}]}
            atlas = plateau.TextureAtlas(cache, download=False, previous_manifest=previous)
            with patch('urllib.request.urlopen', side_effect=AssertionError('Network is forbidden in this test')):
                with self.assertRaisesRegex(ValueError, 'Texture source hash changed'):
                    atlas.fetch(request)
                previous['appearanceSources'][0]['sha256'] = checksum
                verified = plateau.TextureAtlas(cache, download=False, previous_manifest=previous).fetch(request)
            self.assertEqual((verified['width'], verified['height']), (4, 3))
            self.assertEqual(verified['bytes'], len(image_bytes))
            self.assertEqual(verified['sha256'], checksum)
            self.assertEqual(verified['path'], image_path)


if __name__ == '__main__':
    unittest.main()
