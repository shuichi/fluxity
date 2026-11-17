"""Geospatial conversion invariants; no downloads or full source dataset required."""
import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

import numpy as np
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


if __name__ == '__main__':
    unittest.main()
