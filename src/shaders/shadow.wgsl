struct Scene {
  viewProjection: mat4x4<f32>, camera: vec4<f32>, sun: vec4<f32>, settings: vec4<f32>, fog: vec4<f32>,
};
struct Instance { positionHeading: vec4<f32>, style: vec4<f32>, tint: vec4<f32>, extra: vec4<f32> };
@group(0) @binding(0) var<uniform> scene: Scene;
@group(1) @binding(0) var<storage, read> agents: array<Instance>;
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) opacity: f32,
};
@vertex fn vertexMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(vec2<f32>(-1.0,-1.0),vec2<f32>(1.0,-1.0),vec2<f32>(-1.0,1.0),vec2<f32>(-1.0,1.0),vec2<f32>(1.0,-1.0),vec2<f32>(1.0,1.0));
  let uv = positions[vertex];
  let agent = agents[instance];
  let offset = (uv * vec2<f32>(0.34, 0.44) + vec2<f32>(0.07, -0.09)) * agent.style.x;
  let p = agent.positionHeading.xyz + vec3<f32>(offset.x, 0.025, offset.y);
  var output: VertexOutput;
  output.position = scene.viewProjection * vec4<f32>(p, 1.0);
  output.uv = uv;
  output.opacity = agent.extra.z;
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let radius = dot(input.uv, input.uv);
  let alpha = (1.0 - smoothstep(0.12, 1.0, radius)) * 0.22 * input.opacity;
  return vec4<f32>(0.19, 0.25, 0.20, alpha);
}
