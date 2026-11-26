struct Scene {
  viewProjection: mat4x4<f32>, camera: vec4<f32>, sun: vec4<f32>, settings: vec4<f32>, fog: vec4<f32>,
};
@group(0) @binding(0) var<uniform> scene: Scene;
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) material: vec4<f32>,
  @location(3) pose: vec4<f32>,
  @location(4) paint: vec3<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  let tangent = vec2<f32>(input.pose.w, -input.pose.z);
  let forwards = input.pose.zw;
  let xz = input.pose.xy + input.position.x * tangent + input.position.z * forwards;
  let n = input.normal.x * tangent + input.normal.z * forwards;
  var output: VertexOutput;
  output.world = vec3<f32>(xz.x, input.position.y, xz.y);
  output.position = scene.viewProjection * vec4<f32>(output.world, 1.0);
  output.normal = vec3<f32>(n.x, input.normal.y, n.y);
  output.color = mix(input.material.rgb, input.paint, input.material.a);
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let diffuse = max(dot(normalize(input.normal), scene.sun.xyz), 0.0);
  let shaded = input.color * mix(scene.sun.w, 1.0, diffuse);
  let fogAmount = smoothstep(scene.settings.w, scene.fog.w, length(scene.camera.xyz - input.world)) * 0.72;
  return vec4<f32>(mix(shaded, scene.fog.rgb, fogAmount), 1.0);
}
