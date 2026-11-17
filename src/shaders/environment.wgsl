struct Scene {
  viewProjection: mat4x4<f32>, camera: vec4<f32>, sun: vec4<f32>, settings: vec4<f32>, fog: vec4<f32>,
};
@group(0) @binding(0) var<uniform> scene: Scene;
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec4<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec4<f32>,
  @location(2) world: vec3<f32>,
};
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = scene.viewProjection * vec4<f32>(input.position, 1.0);
  output.normal = input.normal;
  output.color = input.color;
  output.world = input.position;
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  var color = input.color.rgb;
  // Derivatives must be evaluated uniformly, before material-dependent branches.
  let antialias = max(fwidth(input.world.xz), vec2<f32>(0.008));
  let material = input.color.a;
  let roadDistance = min(abs(input.world.x), abs(input.world.z));
  let scramble = scene.settings.z > 0.5;
  var emissive = 0.0;
  let mappedPaving = material > 3.5 && material < 4.5;
  if (((material > 0.5 && material < 1.5) || mappedPaving) && input.normal.y > 0.9) {
    let tile = abs(fract(input.world.xz / 3.0 - 0.5) - 0.5) * 3.0;
    let line = 1.0 - smoothstep(vec2<f32>(0.017), vec2<f32>(0.017) + antialias, tile);
    color *= 1.0 - max(line.x, line.y) * 0.10;
    let checker = f32((i32(floor(input.world.x / 3.0)) + i32(floor(input.world.z / 3.0))) & 1);
    color *= 0.987 + checker * 0.013;
    if (scramble && !mappedPaving) {
      let road = 1.0 - smoothstep(scene.settings.z - 0.06, scene.settings.z + 0.06, roadDistance);
      color = mix(color, vec3<f32>(0.22,0.26,0.27), road);
      let edge = 1.0 - smoothstep(0.03, 0.21, abs(roadDistance - scene.settings.z));
      color = mix(color, vec3<f32>(0.83,0.85,0.78), edge * 0.75);
    } else if (!mappedPaving) {
      let path = 1.0 - smoothstep(2.95, 3.05, roadDistance);
      color = mix(color, vec3<f32>(0.79,0.79,0.73), path);
    }
    if (scene.settings.x > 0.5) {
      color = mix(color, vec3<f32>(0.30,0.57,0.43), max(line.x,line.y) * 0.55);
    }
  }
  // Zebra segments extend to their actual sidewalk endpoints, but paint belongs only on asphalt.
  if (material > 1.5 && material < 2.5 && scramble && roadDistance > scene.settings.z + 0.04) { discard; }
  if (material > 2.5 && material < 3.5) { emissive = 0.65; }
  if (material < -0.5) {
    let greenLamp = material < -1.5;
    let lampOn = greenLamp == (scene.settings.y > 0.5);
    let lightColor = select(vec3<f32>(1.0,0.22,0.14), vec3<f32>(0.15,0.95,0.45), greenLamp);
    color = select(vec3<f32>(0.10,0.15,0.13), lightColor, lampOn);
    emissive = select(0.0,1.0,lampOn);
  }
  let diffuse = max(dot(normalize(input.normal), scene.sun.xyz), 0.0);
  let shade = mix(scene.sun.w + (1.0 - scene.sun.w) * diffuse, 1.0, emissive);
  let distance = length(input.world - scene.camera.xyz);
  let fogAmount = smoothstep(scene.settings.w, scene.fog.w, distance) * 0.72;
  return vec4<f32>(mix(color * shade, scene.fog.rgb, fogAmount), 1.0);
}
